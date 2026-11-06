// ==========================================
// DAEPO FORTRESS - Shared Deterministic Game Engine (engine.js)
// Works in both Node.js (server.js) and Browser (game.js)
// ==========================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DaepoEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORLD_WIDTH = 2800;
  const WORLD_HEIGHT = 900;
  const WATER_LEVEL = 862;
  const GRAVITY = 380;
  const WIND_ACCEL_SCALE = 8.5;
  const POWER_VELOCITY_SCALE = 10.2;
  const MAX_WIND = 15;
  const TANK_HIT_RADIUS = 22;
  const BARREL_LENGTH = 28;
  const TURN_FUEL_DEFAULT = 120;

  const PLAYER_PALETTE = [
    { name: '1P 블루', main: '#38bdf8', dark: '#0284c7', light: '#bae6fd', badge: '🔵' },
    { name: '2P 레드', main: '#fb7185', dark: '#e11d48', light: '#fecdd3', badge: '🔴' },
    { name: '3P 골드', main: '#fbbf24', dark: '#d97706', light: '#fde68a', badge: '🟡' },
    { name: '4P 그린', main: '#34d399', dark: '#059669', light: '#a7f3d0', badge: '🟢' }
  ];

  const TANK_TYPES = {
    cannon: {
      id: 'cannon',
      name: '캐논',
      subtitle: '밸런스형',
      icon: '🛡️',
      maxHp: 100,
      maxFuel: 120,
      dmgMult: 1.05,
      craterMult: 1.05,
      minAngle: 8,
      maxAngle: 84
    },
    duke: {
      id: 'duke',
      name: '헤비듀크',
      subtitle: '고화력형',
      icon: '💥',
      maxHp: 110,
      maxFuel: 95,
      dmgMult: 1.18,
      craterMult: 0.96,
      minAngle: 10,
      maxAngle: 80
    },
    multi: {
      id: 'multi',
      name: '크레이터',
      subtitle: '지형파괴형',
      icon: '🌋',
      maxHp: 100,
      maxFuel: 110,
      dmgMult: 0.95,
      craterMult: 1.38,
      minAngle: 6,
      maxAngle: 86
    },
    laser: {
      id: 'laser',
      name: '스피드',
      subtitle: '기동강화형',
      icon: '⚡',
      maxHp: 95,
      maxFuel: 165,
      dmgMult: 1.02,
      craterMult: 0.90,
      minAngle: 5,
      maxAngle: 85
    }
  };

  const WEAPONS = {
    normal: {
      id: 'normal',
      name: '일반탄',
      icon: '💣',
      ammo: -1, // unlimited
      shots: 1,
      baseDamage: 42,
      splashRadius: 68,
      craterRadius: 46,
      desc: '기본 포탄 (무제한)'
    },
    double: {
      id: 'double',
      name: '더블샷',
      icon: '🚀',
      ammo: 2,
      shots: 2,
      baseDamage: 29,
      splashRadius: 58,
      craterRadius: 36,
      desc: '연속 2발 발사'
    },
    power: {
      id: 'power',
      name: '고폭탄',
      icon: '☢️',
      ammo: 2,
      shots: 1,
      baseDamage: 62,
      splashRadius: 96,
      craterRadius: 74,
      desc: '강력한 폭발과 거대 크레이터'
    },
    teleport: {
      id: 'teleport',
      name: '이동탄',
      icon: '🌀',
      ammo: 1,
      shots: 1,
      baseDamage: 0,
      splashRadius: 0,
      craterRadius: 0,
      desc: '탄착 지점으로 내 탱크 순간이동'
    },
    heal: {
      id: 'heal',
      name: '수리키트',
      icon: '🔧',
      ammo: 1,
      shots: 0,
      healAmount: 35,
      desc: '즉시 체력 +35 회복 (턴 소모)'
    }
  };

  const MAP_THEMES = {
    mountains: {
      id: 'mountains',
      name: '험준한 설산',
      skyTop: '#0b1528',
      skyMid: '#1d3557',
      skyBot: '#457b9d',
      crust: '#e2e8f0',
      crustSub: '#94a3b8',
      soilTop: '#475569',
      soilBot: '#1e293b',
      water: '#0284c7'
    },
    canyon: {
      id: 'canyon',
      name: '붉은 대계곡',
      skyTop: '#1c1018',
      skyMid: '#4a1d24',
      skyBot: '#9a3412',
      crust: '#fb923c',
      crustSub: '#ea580c',
      soilTop: '#9a3412',
      soilBot: '#431407',
      water: '#ea580c'
    },
    hills: {
      id: 'hills',
      name: '초원 구릉지',
      skyTop: '#09192f',
      skyMid: '#153e63',
      skyBot: '#38bdf8',
      crust: '#4ade80',
      crustSub: '#16a34a',
      soilTop: '#78350f',
      soilBot: '#3f1d0b',
      water: '#0369a1'
    },
    twinpeaks: {
      id: 'twinpeaks',
      name: '쌍봉 화산분지',
      skyTop: '#0f0f1a',
      skyMid: '#2b193d',
      skyBot: '#6b21a8',
      crust: '#a855f7',
      crustSub: '#6b21a8',
      soilTop: '#334155',
      soilBot: '#0f172a',
      water: '#dc2626'
    },
    terrace: {
      id: 'terrace',
      name: '사막 단차고원',
      skyTop: '#172554',
      skyMid: '#1e40af',
      skyBot: '#f59e0b',
      crust: '#fcd34d',
      crustSub: '#d97706',
      soilTop: '#92400e',
      soilBot: '#451a03',
      water: '#0284c7'
    }
  };

  const MAP_TYPE_LIST = Object.keys(MAP_THEMES);

  // Deterministic Seeded PRNG (Mulberry32)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // Generate diverse terrain heightmap (Float32Array of length WORLD_WIDTH + 1)
  // Remember: y=0 is top of sky, y=900 is bottom, WATER_LEVEL=862.
  // Smaller y = higher mountain peak; larger y = deeper valley.
  function generateTerrain(seed, requestedMapType) {
    const rng = mulberry32(seed || 12345);
    let mapType = requestedMapType;
    if (!mapType || mapType === 'random' || !MAP_THEMES[mapType]) {
      mapType = MAP_TYPE_LIST[Math.floor(rng() * MAP_TYPE_LIST.length)];
    }

    const terrain = new Float32Array(WORLD_WIDTH + 1);
    const p1 = rng() * Math.PI * 2;
    const p2 = rng() * Math.PI * 2;
    const p3 = rng() * Math.PI * 2;
    const p4 = rng() * Math.PI * 2;

    if (mapType === 'mountains') {
      // Rugged alpine peaks + valleys
      const numPeaks = 3 + Math.floor(rng() * 2);
      const peaks = [];
      for (let i = 0; i < numPeaks; i++) {
        peaks.push({
          cx: 380 + ((WORLD_WIDTH - 760) * (i + 0.2 + rng() * 0.6)) / numPeaks,
          amp: 170 + rng() * 145,
          sigma: 135 + rng() * 115
        });
      }
      for (let x = 0; x <= WORLD_WIDTH; x++) {
        const nx = x / WORLD_WIDTH;
        let y =
          655 +
          Math.sin(nx * Math.PI * 3.2 + p1) * 48 +
          Math.sin(nx * Math.PI * 7.5 + p2) * 24 +
          Math.sin(nx * Math.PI * 15 + p3) * 9;
        for (const pk of peaks) {
          const d = (x - pk.cx) / pk.sigma;
          y -= pk.amp * Math.exp(-0.5 * d * d);
        }
        terrain[x] = clamp(y, 235, 790);
      }
    } else if (mapType === 'canyon') {
      // High flanks, deep central gorge + central spire/island
      const gorgeCenter = WORLD_WIDTH * (0.44 + rng() * 0.12);
      const gorgeWidth = 340 + rng() * 120;
      const hasIsland = rng() > 0.35;
      for (let x = 0; x <= WORLD_WIDTH; x++) {
        const nx = x / WORLD_WIDTH;
        let y =
          500 +
          Math.sin(nx * Math.PI * 4.0 + p1) * 38 +
          Math.cos(nx * Math.PI * 9.0 + p2) * 18;
        const gd = (x - gorgeCenter) / gorgeWidth;
        // Carve deep canyon
        y += 285 * Math.exp(-0.5 * gd * gd);
        // Optional rocky pillar in the middle of the canyon
        if (hasIsland) {
          const id = (x - gorgeCenter) / 95;
          y -= 210 * Math.exp(-0.5 * id * id);
        }
        // Secondary side valley
        const v2 = (x - WORLD_WIDTH * (rng() > 0.5 ? 0.23 : 0.77)) / 180;
        y += 95 * Math.exp(-0.5 * v2 * v2);
        terrain[x] = clamp(y, 280, 815);
      }
    } else if (mapType === 'hills') {
      // Rolling hills and flat plains mix
      const flatCenter = WORLD_WIDTH * (0.3 + rng() * 0.4);
      for (let x = 0; x <= WORLD_WIDTH; x++) {
        const nx = x / WORLD_WIDTH;
        const wave =
          Math.sin(nx * Math.PI * 2.6 + p1) * 85 +
          Math.sin(nx * Math.PI * 5.8 + p2) * 42 +
          Math.sin(nx * Math.PI * 11.5 + p3) * 14;
        const fd = (x - flatCenter) / 340;
        const flatten = 1 - 0.72 * Math.exp(-0.5 * fd * fd);
        const y = 605 + wave * flatten;
        terrain[x] = clamp(y, 350, 775);
      }
    } else if (mapType === 'twinpeaks') {
      // Twin dramatic mountain peaks creating 3 distinct basins
      const pk1 = WORLD_WIDTH * (0.31 + rng() * 0.06);
      const pk2 = WORLD_WIDTH * (0.63 + rng() * 0.06);
      const a1 = 230 + rng() * 80;
      const a2 = 230 + rng() * 80;
      for (let x = 0; x <= WORLD_WIDTH; x++) {
        const nx = x / WORLD_WIDTH;
        let y =
          675 +
          Math.sin(nx * Math.PI * 5 + p1) * 30 +
          Math.sin(nx * Math.PI * 12 + p2) * 12;
        const d1 = (x - pk1) / 165;
        const d2 = (x - pk2) / 165;
        y -= a1 * Math.exp(-0.5 * d1 * d1);
        y -= a2 * Math.exp(-0.5 * d2 * d2);
        terrain[x] = clamp(y, 240, 800);
      }
    } else {
      // 'terrace': Stepped desert mesas, plains, and valleys
      const steps = 5 + Math.floor(rng() * 3);
      const stepHeights = [];
      for (let i = 0; i <= steps; i++) {
        stepHeights.push(410 + rng() * 320);
      }
      for (let x = 0; x <= WORLD_WIDTH; x++) {
        const nx = x / WORLD_WIDTH;
        const pos = nx * steps;
        const idx = Math.min(steps - 1, Math.floor(pos));
        const frac = pos - idx;
        // Smooth steep cliff S-curve between flat terraces
        const smooth = clamp((frac - 0.35) / 0.3, 0, 1);
        const sCurve = smooth * smooth * (3 - 2 * smooth);
        let y = stepHeights[idx] * (1 - sCurve) + stepHeights[idx + 1] * sCurve;
        y += Math.sin(nx * Math.PI * 10 + p4) * 10;
        terrain[x] = clamp(y, 310, 785);
      }
    }

    // Raise extreme left/right edges slightly so tanks don't immediately roll off the world border
    for (let x = 0; x < 90; x++) {
      const t = 1 - x / 90;
      terrain[x] = clamp(terrain[x] - t * t * 55, 220, 800);
      const rx = WORLD_WIDTH - x;
      terrain[rx] = clamp(terrain[rx] - t * t * 55, 220, 800);
    }

    // Light smoothing pass for clean rendering
    smoothTerrainSegment(terrain, 0, WORLD_WIDTH, 2);

    return { terrain, mapType };
  }

  function smoothTerrainSegment(terrain, startX, endX, passes) {
    const s = clamp(Math.floor(startX), 1, WORLD_WIDTH - 1);
    const e = clamp(Math.ceil(endX), 1, WORLD_WIDTH - 1);
    const tmp = new Float32Array(e - s + 1);
    for (let p = 0; p < passes; p++) {
      for (let x = s; x <= e; x++) {
        tmp[x - s] = (terrain[x - 1] + terrain[x] * 2 + terrain[x + 1]) * 0.25;
      }
      for (let x = s; x <= e; x++) {
        terrain[x] = tmp[x - s];
      }
    }
  }

  function flattenSpawnPad(terrain, cx, halfWidth) {
    const x0 = clamp(Math.round(cx), 80, WORLD_WIDTH - 80);
    const targetY = clamp(terrain[x0], 270, 775);
    const outer = halfWidth + 28;
    for (let x = Math.max(0, x0 - outer); x <= Math.min(WORLD_WIDTH, x0 + outer); x++) {
      const dist = Math.abs(x - x0);
      if (dist <= halfWidth) {
        terrain[x] = targetY;
      } else {
        const t = (dist - halfWidth) / (outer - halfWidth);
        const s = t * t * (3 - 2 * t);
        terrain[x] = targetY * (1 - s) + terrain[x] * s;
      }
    }
  }

  function getTerrainY(terrain, x) {
    const cx = clamp(x, 0, WORLD_WIDTH);
    const i0 = Math.floor(cx);
    const i1 = Math.min(WORLD_WIDTH, i0 + 1);
    const f = cx - i0;
    return terrain[i0] * (1 - f) + terrain[i1] * f;
  }

  function getTerrainSlopeAngle(terrain, x) {
    const x1 = clamp(x - 8, 0, WORLD_WIDTH);
    const x2 = clamp(x + 8, 0, WORLD_WIDTH);
    const dy = getTerrainY(terrain, x2) - getTerrainY(terrain, x1);
    return Math.atan2(dy, x2 - x1);
  }

  function createInitialAmmo() {
    return {
      normal: -1,
      double: WEAPONS.double.ammo,
      power: WEAPONS.power.ammo,
      teleport: WEAPONS.teleport.ammo,
      heal: WEAPONS.heal.ammo
    };
  }

  function nextWind(rng, currentWind) {
    if (typeof currentWind !== 'number') {
      return Math.round((rng() * 2 - 1) * 11);
    }
    // Gradual shift most turns, occasional strong gust
    if (rng() < 0.22) {
      return Math.round((rng() * 2 - 1) * MAX_WIND);
    }
    const delta = Math.round((rng() * 2 - 1) * 6);
    return clamp(currentWind + delta, -MAX_WIND, MAX_WIND);
  }

  // Create a full match state for 1~4 players
  // playersConfig: [{ id, nickname, isAi, tankType, slotIndex }]
  function createMatch(options) {
    const seed = (options && options.seed) || Math.floor(Math.random() * 2147483640) + 1;
    const rng = mulberry32(seed + 7919);
    const gen = generateTerrain(seed, options && options.mapType);
    const terrain = gen.terrain;
    const mapType = gen.mapType;

    const configs = (options && options.players) || [];
    const count = configs.length;

    // Distribute spawn X positions across WORLD_WIDTH with randomized jitter
    // Shuffle spawn order slightly or spread across zones so every game feels fresh
    const margin = 230;
    const usable = WORLD_WIDTH - margin * 2;
    const zoneOrder = Array.from({ length: count }, (_, i) => i);
    for (let i = zoneOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = zoneOrder[i];
      zoneOrder[i] = zoneOrder[j];
      zoneOrder[j] = tmp;
    }

    const players = configs.map((cfg, idx) => {
      const tankSpec = TANK_TYPES[cfg.tankType] || TANK_TYPES.cannon;
      const palette = PLAYER_PALETTE[idx % PLAYER_PALETTE.length];
      let spawnX;
      if (count === 1) {
        spawnX = 320 + Math.round(rng() * 180);
      } else {
        const zone = zoneOrder[idx];
        const base = margin + (usable * zone) / (count - 1);
        const maxJitter = Math.min(130, usable / (count * 3.2));
        spawnX = clamp(Math.round(base + (rng() * 2 - 1) * maxJitter), 150, WORLD_WIDTH - 150);
      }
      flattenSpawnPad(terrain, spawnX, 24);
      const groundY = getTerrainY(terrain, spawnX);
      const facing = spawnX > WORLD_WIDTH * 0.5 ? -1 : 1;

      return {
        id: String(cfg.id || `p_${idx + 1}`),
        slot: idx,
        nickname: cfg.nickname || (cfg.isAi ? `AI-${idx}` : `P${idx + 1}`),
        isAi: Boolean(cfg.isAi),
        tankType: tankSpec.id,
        color: palette.main,
        colorDark: palette.dark,
        colorLight: palette.light,
        badge: palette.badge,
        x: spawnX,
        y: groundY,
        facing,
        angle: 45,
        power: 58,
        lastPower: null,
        hp: tankSpec.maxHp,
        maxHp: tankSpec.maxHp,
        fuel: tankSpec.maxFuel,
        maxFuel: tankSpec.maxFuel,
        alive: true,
        selectedWeapon: 'normal',
        ammo: createInitialAmmo(),
        damageDealt: 0,
        kills: 0,
        deathOrder: 0,
        aiMemory: {}
      };
    });

    // Face nearest opponent initially
    if (players.length >= 2) {
      for (const p of players) {
        let nearest = null;
        let bestD = Infinity;
        for (const other of players) {
          if (other.id === p.id) continue;
          const d = Math.abs(other.x - p.x);
          if (d < bestD) {
            bestD = d;
            nearest = other;
          }
        }
        if (nearest) {
          p.facing = nearest.x >= p.x ? 1 : -1;
        }
      }
    }

    // Practice targets if count === 1 (1인 영점 연습 모드)
    const practiceTargets = [];
    if (count === 1) {
      for (let i = 0; i < 3; i++) {
        practiceTargets.push(spawnPracticeTarget(terrain, rng, i));
      }
    }

    const wind = nextWind(rng, undefined);

    return {
      seed,
      rngState: Math.floor(rng() * 2147483640) + 1,
      mapType,
      terrain,
      wind,
      turnIndex: 0,
      turnNumber: 1,
      isPractice: count === 1,
      practiceScore: 0,
      practiceTargets,
      players,
      deathCounter: 0,
      status: 'playing',
      winnerId: null
    };
  }

  function spawnPracticeTarget(terrain, rng, slotIdx) {
    const minX = 850 + slotIdx * 580;
    const maxX = Math.min(WORLD_WIDTH - 160, minX + 460);
    const tx = Math.round(minX + rng() * (maxX - minX));
    const ty = getTerrainY(terrain, tx) - 18;
    return {
      id: `target_${slotIdx}_${Math.floor(rng() * 10000)}`,
      slotIdx,
      x: tx,
      y: ty,
      radius: 26
    };
  }

  function stepMatchRng(match) {
    const r = mulberry32(match.rngState || 1);
    const val = r();
    match.rngState = Math.floor(r() * 2147483640) + 1;
    return val;
  }

  function getMuzzlePosition(player, terrain, overrideAngleDeg) {
    const slope = terrain ? getTerrainSlopeAngle(terrain, player.x) : 0;
    const turretBaseX = player.x;
    const turretBaseY = player.y - 16;
    const ang = typeof overrideAngleDeg === 'number' ? overrideAngleDeg : player.angle;
    const rad = (ang * Math.PI) / 180;
    const dirX = Math.cos(rad) * player.facing;
    const dirY = -Math.sin(rad);
    return {
      x: turretBaseX + dirX * BARREL_LENGTH,
      y: turretBaseY + dirY * BARREL_LENGTH,
      dirX,
      dirY,
      slope
    };
  }

  // Move active tank horizontally along terrain
  function moveTank(match, playerIdx, dir, distanceUnits) {
    const p = match.players[playerIdx];
    if (!p || !p.alive) return false;
    const stepDir = dir >= 0 ? 1 : -1;
    p.facing = stepDir;

    if (p.fuel <= 0) return false;
    const dist = clamp(distanceUnits || 3.2, 0.5, 16);
    const actualDist = Math.min(dist, p.fuel);
    const steps = Math.max(1, Math.ceil(actualDist));
    const perStep = actualDist / steps;

    let moved = 0;
    for (let i = 0; i < steps; i++) {
      const nextX = clamp(p.x + stepDir * perStep, 45, WORLD_WIDTH - 45);
      if (Math.abs(nextX - p.x) < 0.01) break;
      const curY = getTerrainY(match.terrain, p.x);
      const nextY = getTerrainY(match.terrain, nextX);
      const climb = curY - nextY; // positive means climbing uphill
      if (climb > perStep * 1.95) {
        // Cliff too steep to climb
        break;
      }
      p.x = nextX;
      p.y = nextY;
      moved += perStep;
      if (p.y >= WATER_LEVEL) {
        eliminatePlayer(match, p);
        break;
      }
    }

    p.fuel = Math.max(0, +(p.fuel - moved).toFixed(2));
    return moved > 0;
  }

  function eliminatePlayer(match, p) {
    if (!p.alive) return;
    p.hp = 0;
    p.alive = false;
    match.deathCounter = (match.deathCounter || 0) + 1;
    p.deathOrder = match.deathCounter;
  }

  // Carve circular crater into 1D terrain heightmap seamlessly
  function carveCrater(terrain, cx, cy, radius) {
    if (!radius || radius <= 0) return;
    const xStart = Math.max(1, Math.floor(cx - radius));
    const xEnd = Math.min(WORLD_WIDTH - 1, Math.ceil(cx + radius));
    const r2 = radius * radius;

    for (let x = xStart; x <= xEnd; x++) {
      const dx = x - cx;
      const d2 = dx * dx;
      if (d2 >= r2) continue;
      const halfChord = Math.sqrt(r2 - d2);
      const yTop = cy - halfChord;
      const yBot = cy + halfChord;

      if (yBot > terrain[x]) {
        if (terrain[x] >= yTop) {
          terrain[x] = yBot;
        } else {
          // Overhanging cliff collapses into carved cavity
          terrain[x] = terrain[x] + (yBot - yTop);
        }
        terrain[x] = Math.min(WORLD_HEIGHT + 30, terrain[x]);
      }
    }

    smoothTerrainSegment(terrain, xStart - 3, xEnd + 3, 2);
  }

  // Settle all alive tanks onto carved terrain; handle water/abyss deaths
  function settleTanks(match, attacker) {
    const events = [];
    for (const p of match.players) {
      if (!p.alive) continue;
      const newGroundY = getTerrainY(match.terrain, p.x);
      const fallDist = newGroundY - p.y;
      if (Math.abs(fallDist) > 0.2) {
        p.y = newGroundY;
      }
      if (p.y >= WATER_LEVEL) {
        const wasAlive = p.alive;
        eliminatePlayer(match, p);
        if (wasAlive && attacker && attacker.id !== p.id) {
          attacker.kills += 1;
        }
        events.push({ type: 'sink', playerId: p.id, x: p.x, y: p.y });
      }
    }
    if (match.isPractice && match.practiceTargets) {
      for (const t of match.practiceTargets) {
        t.y = Math.min(t.y, getTerrainY(match.terrain, t.x) - 18);
      }
    }
    return events;
  }

  // Simulate a single projectile flight using parabolic equation + wind acceleration
  // x(t) = x0 + vx0 * t + 0.5 * ax * t^2
  // y(t) = y0 + vy0 * t + 0.5 * g * t^2
  function traceProjectile(match, shooter, angleDeg, powerVal, windVal) {
    const muzzle = getMuzzlePosition(shooter, match.terrain, angleDeg);
    const speed = clamp(powerVal, 8, 100) * POWER_VELOCITY_SCALE;
    const rad = (angleDeg * Math.PI) / 180;
    let vx = Math.cos(rad) * shooter.facing * speed;
    let vy = -Math.sin(rad) * speed;
    const ax = windVal * WIND_ACCEL_SCALE;
    const ay = GRAVITY;

    let x = muzzle.x;
    let y = muzzle.y;

    const dt = 1 / 120;
    const maxTime = 11.0;
    const points = [{ x: +x.toFixed(1), y: +y.toFixed(1) }];
    let hitType = 'out';
    let hitTankId = null;
    let hitTargetId = null;

    let step = 0;
    const maxSteps = Math.ceil(maxTime / dt);

    while (step < maxSteps) {
      step++;
      vx += ax * dt;
      vy += ay * dt;
      x += vx * dt;
      y += vy * dt;

      if (step % 3 === 0) {
        points.push({ x: +x.toFixed(1), y: +y.toFixed(1) });
      }

      // Left/Right out of bounds
      if (x < -80 || x > WORLD_WIDTH + 80 || y > WORLD_HEIGHT + 40) {
        hitType = 'out';
        break;
      }

      // Water surface hit
      if (y >= WATER_LEVEL && (x < 0 || x > WORLD_WIDTH || getTerrainY(match.terrain, x) >= WATER_LEVEL)) {
        hitType = 'water';
        y = WATER_LEVEL;
        break;
      }

      // Check direct hit with tanks (ignore self for initial 0.16s so barrel doesn't self-clip)
      if (x >= 0 && x <= WORLD_WIDTH) {
        let hitPlayer = null;
        for (const p of match.players) {
          if (!p.alive) continue;
          if (p.id === shooter.id && step < 22) continue;
          const cx = p.x;
          const cy = p.y - 13;
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy <= TANK_HIT_RADIUS * TANK_HIT_RADIUS) {
            hitPlayer = p;
            break;
          }
        }
        if (hitPlayer) {
          hitType = 'tank';
          hitTankId = hitPlayer.id;
          break;
        }

        // Practice targets in 1P mode
        if (match.isPractice && match.practiceTargets) {
          let hitTgt = null;
          for (const tgt of match.practiceTargets) {
            const dx = x - tgt.x;
            const dy = y - tgt.y;
            if (dx * dx + dy * dy <= tgt.radius * tgt.radius) {
              hitTgt = tgt;
              break;
            }
          }
          if (hitTgt) {
            hitType = 'practice_target';
            hitTargetId = hitTgt.id;
            break;
          }
        }

        // Check terrain collision
        const groundY = getTerrainY(match.terrain, x);
        if (y >= groundY) {
          y = groundY;
          hitType = y >= WATER_LEVEL ? 'water' : 'terrain';
          break;
        }
      }
    }

    const lastPt = points[points.length - 1];
    if (!lastPt || lastPt.x !== +x.toFixed(1) || lastPt.y !== +y.toFixed(1)) {
      points.push({ x: +x.toFixed(1), y: +y.toFixed(1) });
    }

    return {
      points,
      hitX: +x.toFixed(1),
      hitY: +y.toFixed(1),
      hitType,
      hitTankId,
      hitTargetId
    };
  }

  // Advance turn to next alive player & check victory condition
  function advanceTurnAndCheckWinner(match) {
    const alivePlayers = match.players.filter((p) => p.alive);

    if (!match.isPractice && alivePlayers.length <= 1) {
      match.status = 'finished';
      match.winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
      return;
    }
    if (match.isPractice && alivePlayers.length === 0) {
      match.status = 'finished';
      match.winnerId = null;
      return;
    }

    const total = match.players.length;
    let nextIdx = match.turnIndex;
    for (let i = 1; i <= total; i++) {
      const cand = (match.turnIndex + i) % total;
      if (match.players[cand].alive) {
        nextIdx = cand;
        break;
      }
    }

    match.turnIndex = nextIdx;
    match.turnNumber += 1;

    // Refill active player's movement fuel for their new turn
    const nextPlayer = match.players[nextIdx];
    if (nextPlayer) {
      nextPlayer.fuel = nextPlayer.maxFuel;
    }

    // Update wind
    const rngVal = stepMatchRng(match);
    const localRng = mulberry32(Math.floor(rngVal * 2147483640) + match.turnNumber * 31);
    match.wind = nextWind(localRng, match.wind);
  }

  // Execute active player's turn action (fire weapon or use heal)
  function executeTurnAction(match, action) {
    if (!match || match.status !== 'playing') return null;
    const shooter = match.players[match.turnIndex];
    if (!shooter || !shooter.alive) return null;

    const tankSpec = TANK_TYPES[shooter.tankType] || TANK_TYPES.cannon;

    // Sync final position/facing/angle/power from action if valid
    if (action.facing === 1 || action.facing === -1) {
      shooter.facing = action.facing;
    }
    if (typeof action.angle === 'number' && !Number.isNaN(action.angle)) {
      shooter.angle = clamp(Math.round(action.angle), tankSpec.minAngle, tankSpec.maxAngle);
    }
    if (typeof action.power === 'number' && !Number.isNaN(action.power)) {
      shooter.power = clamp(Math.round(action.power * 10) / 10, 10, 100);
    }

    let weaponId = action.weapon || shooter.selectedWeapon || 'normal';
    if (!WEAPONS[weaponId]) weaponId = 'normal';
    if (weaponId !== 'normal' && (!shooter.ammo || shooter.ammo[weaponId] <= 0)) {
      weaponId = 'normal';
    }
    const weapon = WEAPONS[weaponId];

    // Consume limited ammo
    if (weaponId !== 'normal') {
      shooter.ammo[weaponId] = Math.max(0, shooter.ammo[weaponId] - 1);
      if (shooter.ammo[weaponId] <= 0) {
        shooter.selectedWeapon = 'normal';
      }
    }

    // Case 1: Heal Kit
    if (weaponId === 'heal') {
      const beforeHp = shooter.hp;
      shooter.hp = Math.min(shooter.maxHp, shooter.hp + weapon.healAmount);
      const healed = shooter.hp - beforeHp;
      advanceTurnAndCheckWinner(match);

      return {
        kind: 'heal',
        shooterId: shooter.id,
        weaponId: 'heal',
        healed,
        aiNote: action.aiNote || null,
        projectiles: [],
        craters: [],
        damages: [],
        practiceHits: [],
        wind: match.wind,
        turnIndex: match.turnIndex,
        turnNumber: match.turnNumber,
        status: match.status,
        winnerId: match.winnerId,
        playersSnapshot: serializePlayers(match.players),
        practiceScore: match.practiceScore,
        practiceTargets: match.practiceTargets
      };
    }

    // Case 2: Projectile weapon (normal, double, power, teleport)
    shooter.lastPower = shooter.power;
    const projectiles = [];
    const craters = [];
    const allDamageEvents = [];
    const practiceHits = [];

    const shotCount = weapon.shots || 1;
    for (let s = 0; s < shotCount; s++) {
      let shotAngle = shooter.angle;
      let shotPower = shooter.power;
      if (shotCount === 2) {
        // Tight Fortress double-shot grouping so accurate aim lands both shells
        shotAngle = clamp(shooter.angle + (s === 0 ? 0.18 : -0.18), 3, 88);
        shotPower = clamp(shooter.power + (s === 0 ? -0.25 : 0.25), 8, 100);
      }

      const trace = traceProjectile(match, shooter, shotAngle, shotPower, match.wind);
      const projDamages = [];

      if (weaponId === 'teleport') {
        if (
          (trace.hitType === 'terrain' || trace.hitType === 'tank') &&
          trace.hitX >= 45 &&
          trace.hitX <= WORLD_WIDTH - 45 &&
          trace.hitY < WATER_LEVEL - 4
        ) {
          shooter.x = clamp(trace.hitX, 45, WORLD_WIDTH - 45);
          shooter.y = getTerrainY(match.terrain, shooter.x);
        }
      } else if (trace.hitType === 'practice_target' && match.isPractice) {
        // Practice target hit!
        const idx = match.practiceTargets.findIndex((t) => t.id === trace.hitTargetId);
        if (idx !== -1) {
          const oldTgt = match.practiceTargets[idx];
          match.practiceScore += 100;
          practiceHits.push({ x: oldTgt.x, y: oldTgt.y, points: 100 });
          const rVal = stepMatchRng(match);
          const subRng = mulberry32(Math.floor(rVal * 2147483640) + idx * 97);
          match.practiceTargets[idx] = spawnPracticeTarget(match.terrain, subRng, oldTgt.slotIdx);
        }
      } else if (trace.hitType === 'terrain' || trace.hitType === 'tank') {
        const craterR = Math.round(weapon.craterRadius * tankSpec.craterMult);
        const splashR = weapon.splashRadius;
        const maxDmg = weapon.baseDamage * tankSpec.dmgMult;

        // Calculate blast damage to all alive tanks within splashRadius
        for (const target of match.players) {
          if (!target.alive) continue;
          const cx = target.x;
          const cy = target.y - 13;
          const dist = Math.hypot(trace.hitX - cx, trace.hitY - cy);
          const effectiveDist = Math.max(0, dist - TANK_HIT_RADIUS * 0.65);

          if (effectiveDist <= splashR) {
            const falloff = 1 - (effectiveDist / splashR) * 0.78;
            const dmg = Math.max(4, Math.round(maxDmg * falloff));
            target.hp = Math.max(0, target.hp - dmg);

            if (target.id !== shooter.id) {
              shooter.damageDealt += dmg;
            }
            const killed = target.hp <= 0;
            if (killed) {
              eliminatePlayer(match, target);
              if (target.id !== shooter.id) {
                shooter.kills += 1;
              }
            }
            const ev = {
              playerId: target.id,
              damage: dmg,
              killed,
              x: target.x,
              y: target.y - 24
            };
            projDamages.push(ev);
            allDamageEvents.push(ev);
          }
        }

        // Carve destructible terrain crater & settle tanks
        if (craterR > 0) {
          carveCrater(match.terrain, trace.hitX, trace.hitY, craterR);
          craters.push({ x: trace.hitX, y: trace.hitY, r: craterR });
          const sinkEvents = settleTanks(match, shooter);
          for (const sk of sinkEvents) {
            const sinkDmg = {
              playerId: sk.playerId,
              damage: 999,
              killed: true,
              sank: true,
              x: sk.x,
              y: sk.y
            };
            projDamages.push(sinkDmg);
            allDamageEvents.push(sinkDmg);
          }
        }
      }

      projectiles.push({
        points: trace.points,
        hitX: trace.hitX,
        hitY: trace.hitY,
        hitType: trace.hitType,
        craterRadius:
          weaponId !== 'teleport' && (trace.hitType === 'terrain' || trace.hitType === 'tank')
            ? Math.round(weapon.craterRadius * tankSpec.craterMult)
            : 0,
        damages: projDamages
      });
    }

    // Record feedback into AI memory if shooter is AI
    if (shooter.isAi && action.aiTargetId && projectiles.length > 0) {
      updateAiZeroingMemory(match, shooter, action.aiTargetId, projectiles[0]);
    }

    advanceTurnAndCheckWinner(match);

    return {
      kind: 'shot',
      shooterId: shooter.id,
      weaponId,
      facing: shooter.facing,
      angle: shooter.angle,
      power: shooter.power,
      aiNote: action.aiNote || null,
      projectiles,
      craters,
      damages: allDamageEvents,
      practiceHits,
      wind: match.wind,
      turnIndex: match.turnIndex,
      turnNumber: match.turnNumber,
      status: match.status,
      winnerId: match.winnerId,
      playersSnapshot: serializePlayers(match.players),
      practiceScore: match.practiceScore,
      practiceTargets: match.practiceTargets
    };
  }

  // ==========================================
  // AI Zeroing-In (영점 조절) Implementation
  // 1. Calculates horizontal/vertical distance to target
  // 2. Starts with wide random angle/power error on initial shot
  // 3. Uses shot impact feedback to progressively shrink error and lock onto target
  // ==========================================
  function solveBallisticPower(match, shooter, target, angleDeg, includeWind) {
    const windToUse = includeWind ? match.wind : 0;
    const muzzle = getMuzzlePosition(shooter, match.terrain, angleDeg);
    const dxGoal = Math.abs(target.x - muzzle.x);

    let bestPower = 55;
    let bestErr = Infinity;

    // Coarse scan across power 12..100
    for (let p = 12; p <= 100; p += 4) {
      const sim = quickSimulateLanding(muzzle, shooter.facing, angleDeg, p, windToUse, match.terrain, target);
      const err = Math.hypot(sim.x - target.x, (sim.y - target.y) * 0.45) + (sim.blockedEarly ? 380 : 0);
      if (err < bestErr) {
        bestErr = err;
        bestPower = p;
      }
    }

    // Fine scan around bestPower (0.2 precision for long-range craters)
    const fineStart = Math.max(10, bestPower - 4);
    const fineEnd = Math.min(100, bestPower + 4);
    for (let p = fineStart; p <= fineEnd; p += 0.2) {
      const sim = quickSimulateLanding(muzzle, shooter.facing, angleDeg, p, windToUse, match.terrain, target);
      const err = Math.hypot(sim.x - target.x, (sim.y - target.y) * 0.45) + (sim.blockedEarly ? 380 : 0);
      if (err < bestErr) {
        bestErr = err;
        bestPower = p;
      }
    }

    return { power: bestPower, err: bestErr };
  }

  function quickSimulateLanding(muzzle, facing, angleDeg, powerVal, windVal, terrain, target) {
    const speed = powerVal * POWER_VELOCITY_SCALE;
    const rad = (angleDeg * Math.PI) / 180;
    let vx = Math.cos(rad) * facing * speed;
    let vy = -Math.sin(rad) * speed;
    const ax = windVal * WIND_ACCEL_SCALE;
    const ay = GRAVITY;
    let x = muzzle.x;
    let y = muzzle.y;
    const dt = 1 / 120;
    const totalDx = Math.abs(target.x - muzzle.x);

    for (let step = 0; step < 1300; step++) {
      vx += ax * dt;
      vy += ay * dt;
      x += vx * dt;
      y += vy * dt;

      if (x < 0 || x > WORLD_WIDTH || y > WORLD_HEIGHT) break;
      const dxTarget = x - target.x;
      const dyTarget = y - (target.y - 12);
      if (dxTarget * dxTarget + dyTarget * dyTarget <= TANK_HIT_RADIUS * TANK_HIT_RADIUS) {
        return { x, y, blockedEarly: false };
      }
      const gy = getTerrainY(terrain, x);
      if (y >= gy) {
        const traveled = Math.abs(x - muzzle.x);
        const blockedEarly = totalDx > 160 && traveled < totalDx * 0.68;
        return { x, y: gy, blockedEarly };
      }
    }
    return { x, y, blockedEarly: false };
  }

  function computeAiTurn(match, aiIdx) {
    const ai = match.players[aiIdx];
    if (!ai || !ai.alive) return null;
    const tankSpec = TANK_TYPES[ai.tankType] || TANK_TYPES.cannon;

    const rSeed = stepMatchRng(match);
    const rng = mulberry32(Math.floor(rSeed * 2147483640) + match.turnNumber * 131 + aiIdx * 17);

    // 1. Emergency Repair if low HP
    if (ai.hp <= 42 && ai.ammo.heal > 0 && rng() < 0.72) {
      return {
        moves: [],
        facing: ai.facing,
        angle: ai.angle,
        power: ai.power,
        weapon: 'heal',
        aiNote: '🔧 긴급 수리 키트 사용!'
      };
    }

    // 2. Select target (prefer enemies already partially zeroed-in or closer/human)
    const enemies = match.players.filter((p) => p.alive && p.id !== ai.id);
    if (enemies.length === 0) return null;

    let target = enemies[0];
    let bestScore = -Infinity;
    for (const e of enemies) {
      const dist = Math.abs(e.x - ai.x);
      const mem = ai.aiMemory[e.id];
      const lockBonus = mem ? mem.shots * 240 : 0;
      const humanBonus = !e.isAi ? 120 : 0;
      const lowHpBonus = (110 - e.hp) * 2.2;
      const score = -dist * 0.45 + lockBonus + humanBonus + lowHpBonus + rng() * 90;
      if (score > bestScore) {
        bestScore = score;
        target = e;
      }
    }

    // 3. Optional slight movement (avoid cliff edge or reposition slightly)
    const moves = [];
    if (ai.fuel >= 25 && (ai.y > WATER_LEVEL - 48 || rng() < 0.45)) {
      const wantDir =
        ai.x < 140 ? 1 : ai.x > WORLD_WIDTH - 140 ? -1 : target.x > ai.x ? 1 : -1;
      const moveDir = rng() < 0.7 ? wantDir : -wantDir;
      const moveSteps = 4 + Math.floor(rng() * 7);
      for (let m = 0; m < moveSteps; m++) {
        if (moveTank(match, aiIdx, moveDir, 4.5)) {
          moves.push({ x: +ai.x.toFixed(1), y: +ai.y.toFixed(1), facing: ai.facing, fuel: ai.fuel });
        } else {
          break;
        }
      }
    }

    ai.facing = target.x >= ai.x ? 1 : -1;

    // 4. Inspect memory & check if target moved significantly since last shot
    if (!ai.aiMemory[target.id]) {
      ai.aiMemory[target.id] = {
        shots: 0,
        lastTargetX: target.x,
        preferredAngle: 42 + Math.round(rng() * 20),
        blockedCount: 0,
        lastRangeErr: 0
      };
    }
    const mem = ai.aiMemory[target.id];
    const targetMovedDist = Math.abs(target.x - mem.lastTargetX);
    if (targetMovedDist > 65 && mem.shots > 0) {
      // Target moved! Partially degrade zeroing lock proportional to move distance
      mem.shots = Math.max(1, mem.shots - (targetMovedDist > 140 ? 2 : 1));
    }

    // 5. Determine optimal feasible angle (42~55 deg for long range, higher if obstacle blocks)
    const dx = Math.abs(target.x - ai.x);
    let baseAngle = dx > 1650 ? 45 : mem.preferredAngle;
    baseAngle = clamp(baseAngle, tankSpec.minAngle + 5, Math.min(68, tankSpec.maxAngle - 4));

    // 6. Compute baseline power & apply progressive Zeroing-In error decay!
    // Shot 0 (Initial): Parabolic distance formula + wide random scatter
    // Shot 1: Error cut by ~60%
    // Shot 2: Error cut by ~82%
    // Shot 3+: Locked-on precision!
    const shots = mem.shots;
    let chosenAngle;
    let chosenPower;
    let aiStageNote;

    if (shots === 0) {
      // Initial shot: textbook parabolic distance formula R = v^2 sin(2θ) / g + wide random error!
      const dy = ai.y - target.y; // positive if target is higher up
      const angleNoise = (rng() * 2 - 1) * 9;
      chosenAngle = clamp(Math.round(baseAngle + angleNoise), 32, 62);

      const rad = (chosenAngle * Math.PI) / 180;
      const sin2 = Math.max(0.35, Math.sin(2 * rad));
      const effectiveRange = Math.max(120, dx + dy * 0.85);
      const v0 = Math.sqrt((effectiveRange * GRAVITY) / sin2);
      const roughPower = v0 / POWER_VELOCITY_SCALE;

      const randSign = rng() < 0.5 ? -1 : 1;
      const powerNoise = randSign * (9 + rng() * 12);

      chosenPower = clamp(Math.round(roughPower + powerNoise), 14, 99);
      aiStageNote = `📡 거리 ${Math.round(dx)}m 측정 → 초기 탐색 사격`;
    } else {
      // Find clean trajectory angle that clears any ridge/crater lip with margin
      let bestCand = solveBallisticPower(match, ai, target, baseAngle, true);
      let bestAng = baseAngle;
      const candidates = [baseAngle, 48, 56, 64, 72, 78, 40];
      let bestComposite = Infinity;
      for (const ca of candidates) {
        if (ca < tankSpec.minAngle || ca > tankSpec.maxAngle) continue;
        const cand = solveBallisticPower(match, ai, target, ca, true);
        // Check sensitivity to -1 power so AI doesn't graze a ridge by 1px
        const checkLow = quickSimulateLanding(
          getMuzzlePosition(ai, match.terrain, ca),
          ai.facing,
          ca,
          Math.max(10, cand.power - 1.0),
          match.wind,
          match.terrain,
          target
        );
        const ridgePenalty = Math.abs(checkLow.x - target.x) > 110 ? 65 : 0;
        const composite = cand.err + ridgePenalty;
        if (composite < bestComposite) {
          bestComposite = composite;
          bestCand = cand;
          bestAng = ca;
        }
      }

      // Exponential error decay with each consecutive shot
      const decay = Math.pow(0.38, shots); // shot1: 0.38, shot2: 0.144, shot3: 0.055
      const maxAngErr = 8 * decay;
      const maxPowErr = 17 * decay;

      const angErr = (rng() * 2 - 1) * maxAngErr;
      chosenAngle = clamp(Math.round(bestAng + angErr), tankSpec.minAngle, tankSpec.maxAngle);

      // Solve exact power for chosenAngle, then inject decaying power error
      const exactForChosen = solveBallisticPower(match, ai, target, chosenAngle, true);
      const powErr = (rng() * 2 - 1) * maxPowErr;
      chosenPower = clamp(Math.round((exactForChosen.power + powErr) * 10) / 10, 12, 100);

      if (shots === 1) {
        aiStageNote = '🎯 탄착 오차 분석 → 1차 영점 보정';
      } else if (shots === 2) {
        aiStageNote = '🎯 정밀 영점 수렴 중 (오차 대폭 감소)';
      } else {
        aiStageNote = '🔥 영점 조준 완료! 정밀 포격';
      }
    }

    // Choose special weapon once zeroing confidence is high
    let weapon = 'normal';
    if (shots >= 2) {
      if (ai.ammo.power > 0 && rng() < 0.55) {
        weapon = 'power';
      } else if (ai.ammo.double > 0 && rng() < 0.65) {
        weapon = 'double';
      }
    }

    return {
      moves,
      facing: ai.facing,
      angle: chosenAngle,
      power: chosenPower,
      weapon,
      aiTargetId: target.id,
      aiNote: aiStageNote
    };
  }

  function updateAiZeroingMemory(match, ai, targetId, firstProj) {
    const target = match.players.find((p) => p.id === targetId);
    if (!target || !firstProj) return;
    if (!ai.aiMemory[targetId]) {
      ai.aiMemory[targetId] = {
        shots: 0,
        lastTargetX: target.x,
        preferredAngle: ai.angle,
        blockedCount: 0,
        lastRangeErr: 0
      };
    }
    const mem = ai.aiMemory[targetId];
    mem.shots += 1;
    mem.lastTargetX = target.x;

    const intendedDist = Math.abs(target.x - ai.x);
    const actualDist = Math.abs(firstProj.hitX - ai.x);
    if (intendedDist > 180 && actualDist < intendedDist * 0.62 && firstProj.hitY < Math.min(ai.y, target.y) - 20) {
      // Hit an intermediate mountain peak
      mem.blockedCount = Math.min(3, (mem.blockedCount || 0) + 1);
    } else {
      mem.blockedCount = 0;
      mem.preferredAngle = ai.angle;
    }
    mem.lastRangeErr = actualDist - intendedDist;
  }

  function serializePlayers(players) {
    return players.map((p) => ({
      id: p.id,
      slot: p.slot,
      nickname: p.nickname,
      isAi: p.isAi,
      tankType: p.tankType,
      color: p.color,
      colorDark: p.colorDark,
      colorLight: p.colorLight,
      badge: p.badge,
      x: +p.x.toFixed(1),
      y: +p.y.toFixed(1),
      facing: p.facing,
      angle: p.angle,
      power: p.power,
      lastPower: p.lastPower,
      hp: p.hp,
      maxHp: p.maxHp,
      fuel: +p.fuel.toFixed(1),
      maxFuel: p.maxFuel,
      alive: p.alive,
      selectedWeapon: p.selectedWeapon,
      ammo: { ...p.ammo },
      damageDealt: p.damageDealt,
      kills: p.kills,
      deathOrder: p.deathOrder
    }));
  }

  function exportMatchState(match) {
    return {
      seed: match.seed,
      mapType: match.mapType,
      terrain: Array.from(match.terrain, (v) => Math.round(v * 10) / 10),
      wind: match.wind,
      turnIndex: match.turnIndex,
      turnNumber: match.turnNumber,
      isPractice: match.isPractice,
      practiceScore: match.practiceScore,
      practiceTargets: match.practiceTargets,
      status: match.status,
      winnerId: match.winnerId,
      players: serializePlayers(match.players)
    };
  }

  return {
    WORLD_WIDTH,
    WORLD_HEIGHT,
    WATER_LEVEL,
    GRAVITY,
    WIND_ACCEL_SCALE,
    POWER_VELOCITY_SCALE,
    MAX_WIND,
    TANK_HIT_RADIUS,
    BARREL_LENGTH,
    TURN_FUEL_DEFAULT,
    PLAYER_PALETTE,
    TANK_TYPES,
    WEAPONS,
    MAP_THEMES,
    MAP_TYPE_LIST,
    mulberry32,
    clamp,
    generateTerrain,
    getTerrainY,
    getTerrainSlopeAngle,
    getMuzzlePosition,
    createMatch,
    moveTank,
    carveCrater,
    settleTanks,
    traceProjectile,
    executeTurnAction,
    computeAiTurn,
    serializePlayers,
    exportMatchState
  };
});
