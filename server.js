// ==========================================
// TANK CLASH (탱크 클래시) - Single & 2~4P Online Multi Server (server.js)
// Zero external npm dependencies: run with `node server.js`
// ==========================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const DaepoEngine = require('./engine.js');

const PORT = process.env.PORT || 3020;
const TURN_LIMIT_MS = 35000;
const MAX_ROOM_PLAYERS = 4;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ==========================================
// Windows Desktop Shortcut Check & Creation Helper
// ==========================================
function getShortcutScript(action, targetUrl, iconPath) {
  if (action === 'check') {
    return `
      $desktop = [Environment]::GetFolderPath('Desktop')
      $names = @('Tank Clash.lnk', 'Tank Clash.url', '탱크 클래시.lnk', '탱크 클래시.url', 'DAEPO.lnk', 'DAEPO.url', '대포대전.lnk', '대포대전.url')
      $exists = $false
      foreach ($n in $names) {
        if (Test-Path (Join-Path $desktop $n)) { $exists = $true; break }
      }
      if ($exists) { Write-Output 'EXISTS' } else { Write-Output 'NONE' }
    `;
  }
  const safeUrl = String(targetUrl || `http://localhost:${PORT}`).replace(/'/g, '');
  const safeIcon = String(iconPath || path.join(__dirname, 'favicon.ico')).replace(/'/g, '');
  return `
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnkPath = Join-Path $desktop '탱크 클래시.lnk'
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($lnkPath)
    $edgePaths = @(
      "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
      "\${env:ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe"
    )
    $chromePaths = @(
      "\${env:ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe",
      "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
      "\${env:LocalAppData}\\Google\\Chrome\\Application\\chrome.exe"
    )
    $browserExe = $null
    foreach ($p in ($chromePaths + $edgePaths)) {
      if ($p -and (Test-Path $p)) { $browserExe = $p; break }
    }
    if ($browserExe) {
      $sc.TargetPath = $browserExe
      $sc.Arguments = "--app=${safeUrl}"
    } else {
      $sc.TargetPath = "${safeUrl}"
    }
    $sc.WorkingDirectory = "${__dirname.replace(/\\/g, '\\\\')}"
    $sc.IconLocation = "${safeIcon},0"
    $sc.Description = "탱크 클래시 (Tank Clash) - Single & Multi"
    $sc.Save()
    Write-Output 'CREATED'
  `;
}

function checkWindowsDesktopShortcut(callback) {
  if (process.platform !== 'win32') {
    callback(false);
    return;
  }
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', getShortcutScript('check')],
    { timeout: 4000 },
    (err, stdout) => {
      if (err) {
        callback(false);
        return;
      }
      callback(String(stdout).trim().includes('EXISTS'));
    }
  );
}

function createWindowsDesktopShortcut(targetUrl, callback) {
  if (process.platform !== 'win32') {
    callback(false, 'Not Windows');
    return;
  }
  const iconPath = path.join(__dirname, 'favicon.ico');
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      getShortcutScript('create', targetUrl, iconPath)
    ],
    { timeout: 6000 },
    (err, stdout) => {
      if (err) {
        callback(false, err.message);
        return;
      }
      callback(String(stdout).trim().includes('CREATED'));
    }
  );
}

// ==========================================
// HTTP Static Server + Shortcut API
// ==========================================
const server = http.createServer((req, res) => {
  const reqUrl = req.url.split('?')[0];

  if (reqUrl === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK');
    return;
  }

  if (reqUrl === '/api/shortcut-status' && req.method === 'GET') {
    checkWindowsDesktopShortcut((exists) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ exists, platform: process.platform }));
    });
    return;
  }

  if (reqUrl === '/api/create-shortcut' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let targetUrl = `http://localhost:${PORT}`;
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed.url) targetUrl = parsed.url;
      } catch (e) {}
      createWindowsDesktopShortcut(targetUrl, (ok, errMsg) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok, error: errMsg || null }));
      });
    });
    return;
  }

  const filePathReq = reqUrl === '/' ? '/index.html' : reqUrl;
  const safePath = path.normalize(filePathReq).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

// ==========================================
// Lightweight RFC 6455 WebSocket Implementation
// ==========================================
const clients = new Map();
const rooms = new Map();
let nextClientId = 1;
let nextRoomId = 1;

function encodeWsFrame(dataStr) {
  const payload = Buffer.from(dataStr, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendJson(client, obj) {
  if (!client || !client.socket || client.socket.destroyed) return;
  try {
    const frame = encodeWsFrame(JSON.stringify(obj));
    client.socket.write(frame);
  } catch (e) {}
}

function broadcastToRoom(room, obj, excludeClientId = null) {
  if (!room) return;
  for (const p of room.players) {
    if (excludeClientId && p.id === excludeClientId) continue;
    sendJson(p, obj);
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];
  socket.write(headers.join('\r\n'));

  const clientId = `c_${nextClientId++}`;
  const client = {
    id: clientId,
    nickname: `유저${clientId.slice(2)}`,
    tankType: 'cannon',
    stats: { wins: 0, losses: 0, draws: 0 },
    socket,
    roomId: null,
    buffer: Buffer.alloc(0)
  };
  clients.set(clientId, client);

  sendJson(client, { type: 'welcome', clientId, rooms: getPublicRoomList() });

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    processBuffer(client);
  });

  socket.on('close', () => handleDisconnect(client));
  socket.on('error', () => handleDisconnect(client));
});

function processBuffer(client) {
  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];
    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (client.buffer.length < 4) return;
      payloadLen = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (client.buffer.length < 10) return;
      payloadLen = Number(client.buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    const totalFrameLen = offset + maskLen + payloadLen;
    if (client.buffer.length < totalFrameLen) return;

    let payload = client.buffer.subarray(offset + maskLen, totalFrameLen);
    if (isMasked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    client.buffer = client.buffer.subarray(totalFrameLen);

    if (opcode === 0x8) {
      client.socket.end();
      handleDisconnect(client);
      return;
    } else if (opcode === 0x9) {
      const pong = Buffer.from([0x8a, 0x00]);
      client.socket.write(pong);
    } else if (opcode === 0x1) {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        handleClientMessage(client, msg);
      } catch (e) {}
    }
  }
}

// ==========================================
// Lobby & 2~4 Player Room Management
// ==========================================
function sanitizeStats(s) {
  if (!s || typeof s !== 'object') return { wins: 0, losses: 0, draws: 0 };
  return {
    wins: Math.max(0, Number(s.wins) || 0),
    losses: Math.max(0, Number(s.losses) || 0),
    draws: Math.max(0, Number(s.draws) || 0)
  };
}

function getPublicRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    list.push({
      id: room.id,
      title: room.title,
      hostId: room.players[0] ? room.players[0].id : '',
      hostName: room.players[0] ? room.players[0].nickname : '-',
      playerCount: room.players.length,
      maxPlayers: MAX_ROOM_PLAYERS,
      mapType: room.mapType,
      status: room.status
    });
  }
  return list;
}

function broadcastRoomList() {
  const roomList = getPublicRoomList();
  for (const c of clients.values()) {
    if (!c.roomId) {
      sendJson(c, { type: 'room_list', rooms: roomList });
    }
  }
}

function serializeWaitingRoom(room) {
  return {
    id: room.id,
    title: room.title,
    status: room.status,
    hostId: room.players[0] ? room.players[0].id : null,
    mapType: room.mapType,
    maxPlayers: MAX_ROOM_PLAYERS,
    players: room.players.map((p, idx) => ({
      id: p.id,
      slot: idx,
      nickname: p.nickname,
      tankType: p.tankType || 'cannon',
      stats: p.stats,
      isHost: idx === 0
    }))
  };
}

function sendWaitingRoomUpdate(room) {
  if (!room) return;
  const serialized = serializeWaitingRoom(room);
  for (const p of room.players) {
    sendJson(p, {
      type: 'room_update',
      myId: p.id,
      room: serialized
    });
  }
}

function clearRoomTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function estimateShotAnimMs(turnResult) {
  if (!turnResult || !turnResult.projectiles || turnResult.projectiles.length === 0) {
    return 900;
  }
  let maxPts = 0;
  for (const pr of turnResult.projectiles) {
    if (pr.points && pr.points.length > maxPts) maxPts = pr.points.length;
  }
  // Each sampled point is 3/120s = 25ms in real time, plus explosion & camera pan settle
  return Math.min(7500, maxPts * 25 + 1600);
}

function scheduleRoomTurnTimer(room, extraDelayMs = 0) {
  clearRoomTurnTimer(room);
  if (!room || room.status !== 'playing' || !room.match || room.match.status !== 'playing') return;

  const totalWait = TURN_LIMIT_MS + Math.max(0, extraDelayMs);
  room.turnDeadline = Date.now() + totalWait;
  room.turnTimer = setTimeout(() => {
    if (!rooms.has(room.id) || room.status !== 'playing' || !room.match) return;
    const activePlayer = room.match.players[room.match.turnIndex];
    if (!activePlayer || !activePlayer.alive) return;

    // Auto-fire with current angle & mid power on turn timeout
    const result = DaepoEngine.executeTurnAction(room.match, {
      facing: activePlayer.facing,
      angle: activePlayer.angle,
      power: activePlayer.power || 55,
      weapon: 'normal',
      aiNote: '⏰ 시간 초과 자동 발사!'
    });
    if (result) {
      handleRoomTurnResult(room, result);
    }
  }, totalWait);
}

function buildMatchRankings(match) {
  const sorted = [...match.players].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    // Later deathOrder means survived longer!
    if (a.deathOrder !== b.deathOrder) return b.deathOrder - a.deathOrder;
    return b.damageDealt - a.damageDealt;
  });
  return sorted.map((p, idx) => ({
    rank: idx + 1,
    id: p.id,
    nickname: p.nickname,
    badge: p.badge,
    color: p.color,
    tankType: p.tankType,
    alive: p.alive,
    kills: p.kills,
    damageDealt: p.damageDealt
  }));
}

function finalizeMultiplayerMatch(room) {
  if (!room || !room.match) return;
  clearRoomTurnTimer(room);

  const match = room.match;
  const winnerId = match.winnerId;
  const rankings = buildMatchRankings(match);

  for (const client of room.players) {
    if (!winnerId) {
      client.stats.draws += 1;
    } else if (client.id === winnerId) {
      client.stats.wins += 1;
    } else {
      client.stats.losses += 1;
    }
  }

  for (const client of room.players) {
    const myOutcome = !winnerId ? 'draw' : client.id === winnerId ? 'win' : 'lose';
    sendJson(client, {
      type: 'match_over',
      result: myOutcome,
      winnerId,
      rankings,
      meStats: client.stats
    });
  }

  // Return room to 'waiting' state so same 2~4 friends can play again or accept new players!
  room.status = 'waiting';
  room.match = null;
  broadcastRoomList();
}

function handleRoomTurnResult(room, result) {
  broadcastToRoom(room, {
    type: 'turn_resolved',
    result
  });

  if (room.match.status === 'finished') {
    const delayMs = estimateShotAnimMs(result);
    clearRoomTurnTimer(room);
    room.turnTimer = setTimeout(() => {
      if (rooms.has(room.id) && room.match && room.match.status === 'finished') {
        finalizeMultiplayerMatch(room);
      }
    }, delayMs);
  } else {
    scheduleRoomTurnTimer(room, estimateShotAnimMs(result));
  }
}

function handleClientMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'set_profile': {
      const clean = String(msg.nickname || '').trim().slice(0, 12);
      if (clean) client.nickname = clean;
      if (msg.tankType && DaepoEngine.TANK_TYPES[msg.tankType]) {
        client.tankType = msg.tankType;
      }
      if (msg.stats) client.stats = sanitizeStats(msg.stats);

      if (client.roomId && rooms.has(client.roomId)) {
        const room = rooms.get(client.roomId);
        if (room.status === 'waiting') sendWaitingRoomUpdate(room);
      } else {
        sendJson(client, { type: 'room_list', rooms: getPublicRoomList() });
      }
      break;
    }

    case 'get_rooms': {
      sendJson(client, { type: 'room_list', rooms: getPublicRoomList() });
      break;
    }

    case 'create_room': {
      if (client.roomId) leaveCurrentRoom(client);
      if (msg.nickname) {
        const clean = String(msg.nickname).trim().slice(0, 12);
        if (clean) client.nickname = clean;
      }
      if (msg.tankType && DaepoEngine.TANK_TYPES[msg.tankType]) {
        client.tankType = msg.tankType;
      }
      if (msg.stats) client.stats = sanitizeStats(msg.stats);

      const roomTitle = String(msg.title || `${client.nickname}의 탱크 클래시 방`).trim().slice(0, 24);
      const roomId = `room_${nextRoomId++}`;
      const room = {
        id: roomId,
        title: roomTitle,
        mapType: msg.mapType || 'random',
        players: [client],
        status: 'waiting',
        match: null,
        turnTimer: null
      };
      client.roomId = roomId;
      rooms.set(roomId, room);

      sendWaitingRoomUpdate(room);
      broadcastRoomList();
      break;
    }

    case 'join_room': {
      if (client.roomId) leaveCurrentRoom(client);
      if (msg.nickname) {
        const clean = String(msg.nickname).trim().slice(0, 12);
        if (clean) client.nickname = clean;
      }
      if (msg.tankType && DaepoEngine.TANK_TYPES[msg.tankType]) {
        client.tankType = msg.tankType;
      }
      if (msg.stats) client.stats = sanitizeStats(msg.stats);

      const room = rooms.get(msg.roomId);
      if (!room) {
        sendJson(client, { type: 'error', message: '존재하지 않는 방입니다.' });
        sendJson(client, { type: 'room_list', rooms: getPublicRoomList() });
        return;
      }
      if (room.status !== 'waiting') {
        sendJson(client, { type: 'error', message: '이미 게임이 진행 중인 방입니다.' });
        sendJson(client, { type: 'room_list', rooms: getPublicRoomList() });
        return;
      }
      if (room.players.length >= MAX_ROOM_PLAYERS) {
        sendJson(client, { type: 'error', message: '방 인원(최대 4명)이 가득 찼습니다.' });
        sendJson(client, { type: 'room_list', rooms: getPublicRoomList() });
        return;
      }

      room.players.push(client);
      client.roomId = room.id;

      sendWaitingRoomUpdate(room);
      broadcastToRoom(room, {
        type: 'room_notice',
        text: `👋 ${client.nickname}님이 입장했습니다! (현재 ${room.players.length}인용)`
      });
      broadcastRoomList();
      break;
    }

    case 'select_tank': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'waiting') return;
      if (msg.tankType && DaepoEngine.TANK_TYPES[msg.tankType]) {
        client.tankType = msg.tankType;
        sendWaitingRoomUpdate(room);
      }
      break;
    }

    case 'select_map': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'waiting') return;
      if (!room.players[0] || room.players[0].id !== client.id) return; // Host only
      const allowed = ['random', ...DaepoEngine.MAP_TYPE_LIST];
      if (allowed.includes(msg.mapType)) {
        room.mapType = msg.mapType;
        sendWaitingRoomUpdate(room);
        broadcastRoomList();
      }
      break;
    }

    case 'room_chat': {
      const room = rooms.get(client.roomId);
      if (!room) return;
      const text = String(msg.text || '').trim().slice(0, 40);
      if (!text) return;
      broadcastToRoom(room, {
        type: 'room_chat',
        senderId: client.id,
        nickname: client.nickname,
        text
      });
      break;
    }

    case 'start_match': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'waiting') return;
      if (!room.players[0] || room.players[0].id !== client.id) {
        sendJson(client, { type: 'error', message: '방장만 게임을 시작할 수 있습니다.' });
        return;
      }
      if (room.players.length < 2) {
        sendJson(client, { type: 'error', message: '최소 2명 이상 참여해야 멀티게임을 시작할 수 있습니다.' });
        return;
      }

      // Create 2, 3, or 4 player match depending on current participants!
      const playerConfigs = room.players.map((p, idx) => ({
        id: p.id,
        nickname: p.nickname,
        isAi: false,
        tankType: p.tankType || 'cannon',
        slotIndex: idx
      }));

      room.match = DaepoEngine.createMatch({
        mapType: room.mapType,
        players: playerConfigs
      });
      room.status = 'playing';

      const exported = DaepoEngine.exportMatchState(room.match);
      for (const p of room.players) {
        sendJson(p, {
          type: 'match_started',
          myId: p.id,
          roomId: room.id,
          roomTitle: room.title,
          playerCount: room.players.length,
          match: exported
        });
      }

      scheduleRoomTurnTimer(room, 600);
      broadcastRoomList();
      break;
    }

    case 'move_tank': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'playing' || !room.match || room.match.status !== 'playing') return;
      const active = room.match.players[room.match.turnIndex];
      if (!active || active.id !== client.id || !active.alive) return;

      const dir = msg.dir >= 0 ? 1 : -1;
      const dist = DaepoEngine.clamp(Number(msg.dist) || 3.5, 0.5, 12);
      const moved = DaepoEngine.moveTank(room.match, room.match.turnIndex, dir, dist);
      if (moved || active.facing === dir) {
        broadcastToRoom(
          room,
          {
            type: 'tank_moved',
            playerId: active.id,
            x: +active.x.toFixed(1),
            y: +active.y.toFixed(1),
            facing: active.facing,
            fuel: +active.fuel.toFixed(1),
            alive: active.alive
          },
          client.id
        );

        // If tank drove directly into deep water during movement
        if (!active.alive) {
          const res = {
            kind: 'sink_move',
            shooterId: active.id,
            weaponId: 'normal',
            projectiles: [],
            craters: [],
            damages: [{ playerId: active.id, damage: 999, killed: true, sank: true, x: active.x, y: active.y }],
            practiceHits: []
          };
          // Advance turn inside engine by checking alive players
          const aliveNow = room.match.players.filter((p) => p.alive);
          if (aliveNow.length <= 1) {
            room.match.status = 'finished';
            room.match.winnerId = aliveNow.length === 1 ? aliveNow[0].id : null;
          } else {
            const total = room.match.players.length;
            for (let i = 1; i <= total; i++) {
              const cand = (room.match.turnIndex + i) % total;
              if (room.match.players[cand].alive) {
                room.match.turnIndex = cand;
                room.match.players[cand].fuel = room.match.players[cand].maxFuel;
                break;
              }
            }
            room.match.turnNumber += 1;
          }
          res.wind = room.match.wind;
          res.turnIndex = room.match.turnIndex;
          res.turnNumber = room.match.turnNumber;
          res.status = room.match.status;
          res.winnerId = room.match.winnerId;
          res.playersSnapshot = DaepoEngine.serializePlayers(room.match.players);
          handleRoomTurnResult(room, res);
        }
      }
      break;
    }

    case 'aim_sync': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'playing' || !room.match || room.match.status !== 'playing') return;
      const active = room.match.players[room.match.turnIndex];
      if (!active || active.id !== client.id || !active.alive) return;

      const spec = DaepoEngine.TANK_TYPES[active.tankType] || DaepoEngine.TANK_TYPES.cannon;
      if (msg.facing === 1 || msg.facing === -1) active.facing = msg.facing;
      if (typeof msg.angle === 'number') {
        active.angle = DaepoEngine.clamp(Math.round(msg.angle), spec.minAngle, spec.maxAngle);
      }
      if (msg.weapon && DaepoEngine.WEAPONS[msg.weapon]) {
        active.selectedWeapon = msg.weapon;
      }

      broadcastToRoom(
        room,
        {
          type: 'tank_aimed',
          playerId: active.id,
          facing: active.facing,
          angle: active.angle,
          weapon: active.selectedWeapon
        },
        client.id
      );
      break;
    }

    case 'fire_turn': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'playing' || !room.match || room.match.status !== 'playing') return;
      const active = room.match.players[room.match.turnIndex];
      if (!active || active.id !== client.id || !active.alive) return;

      clearRoomTurnTimer(room);
      const result = DaepoEngine.executeTurnAction(room.match, {
        facing: msg.facing,
        angle: msg.angle,
        power: msg.power,
        weapon: msg.weapon
      });
      if (result) {
        handleRoomTurnResult(room, result);
      }
      break;
    }

    case 'back_to_room': {
      const room = rooms.get(client.roomId);
      if (!room) return;
      if (room.status === 'waiting') {
        sendWaitingRoomUpdate(room);
      }
      break;
    }

    case 'leave_room': {
      leaveCurrentRoom(client);
      sendJson(client, { type: 'left_room', rooms: getPublicRoomList() });
      break;
    }
  }
}

function leaveCurrentRoom(client) {
  const roomId = client.roomId;
  if (!roomId) return;
  client.roomId = null;

  const room = rooms.get(roomId);
  if (!room) return;

  const wasPlaying = room.status === 'playing' && room.match && room.match.status === 'playing';
  const leavingName = client.nickname;
  room.players = room.players.filter((p) => p.id !== client.id);

  if (room.players.length === 0) {
    clearRoomTurnTimer(room);
    rooms.delete(roomId);
    broadcastRoomList();
    return;
  }

  if (wasPlaying) {
    // Mark disconnected player's tank as eliminated so remaining 2~3 players can keep playing!
    const match = room.match;
    const pIdx = match.players.findIndex((p) => p.id === client.id);
    if (pIdx !== -1 && match.players[pIdx].alive) {
      match.players[pIdx].hp = 0;
      match.players[pIdx].alive = false;
      match.deathCounter = (match.deathCounter || 0) + 1;
      match.players[pIdx].deathOrder = match.deathCounter;
    }

    const alivePlayers = match.players.filter((p) => p.alive);
    broadcastToRoom(room, {
      type: 'player_left_match',
      playerId: client.id,
      nickname: leavingName,
      playersSnapshot: DaepoEngine.serializePlayers(match.players)
    });

    if (alivePlayers.length <= 1) {
      match.status = 'finished';
      match.winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
      finalizeMultiplayerMatch(room);
    } else if (match.turnIndex === pIdx) {
      // It was the disconnected player's turn -> advance turn immediately!
      const total = match.players.length;
      for (let i = 1; i <= total; i++) {
        const cand = (match.turnIndex + i) % total;
        if (match.players[cand].alive) {
          match.turnIndex = cand;
          match.players[cand].fuel = match.players[cand].maxFuel;
          break;
        }
      }
      match.turnNumber += 1;
      broadcastToRoom(room, {
        type: 'turn_skipped',
        turnIndex: match.turnIndex,
        turnNumber: match.turnNumber,
        playersSnapshot: DaepoEngine.serializePlayers(match.players)
      });
      scheduleRoomTurnTimer(room, 300);
    }
  } else {
    sendWaitingRoomUpdate(room);
    broadcastToRoom(room, {
      type: 'room_notice',
      text: `🚪 ${leavingName}님이 퇴장했습니다. (현재 ${room.players.length}명)`
    });
  }

  broadcastRoomList();
}

function handleDisconnect(client) {
  if (!clients.has(client.id)) return;
  leaveCurrentRoom(client);
  clients.delete(client.id);
}

setInterval(() => {
  for (const c of clients.values()) {
    sendJson(c, { type: 'ping' });
  }
}, 25000).unref();

function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

if (require.main === module) {
  server.listen(PORT, () => {
    const ips = getLocalIpAddresses();
    console.log('====================================================');
    console.log(`💣 TANK CLASH (탱크 클래시) SERVER RUNNING!`);
    console.log(`👉 Local PC URL : http://localhost:${PORT}`);
    ips.forEach((ip) => {
      console.log(`👉 LAN / Mobile : http://${ip}:${PORT}`);
    });
    console.log('====================================================');
  });
}

module.exports = { server };
