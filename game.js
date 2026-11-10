// ==========================================
// TANK CLASH (탱크 클래시) - PC & Smartphone Client (game.js)
// Single (1~4P AI Zeroing / Local Pass-and-Play / Practice)
// & Online Multi (2~4P Dynamic Room Lobby via WS + Serverless Fallback)
// ==========================================

(function () {
  'use strict';

  const Engine = window.DaepoEngine;
  const TURN_LIMIT_SEC = 35;
  const STORAGE_KEY = 'daepo_fortress_save_v1';

  // ==========================================
  // Application State
  // ==========================================
  const app = {
    screen: 'menu', // 'menu' | 'single-setup' | 'lobby' | 'room' | 'game'
    mode: 'single', // 'single' | 'multi'
    singleSubMode: 'ai', // 'ai' | 'local'
    aiCount: 1, // 1->2P, 2->3P, 3->4P, 0->1P practice
    aiLevel: 1, // 1~30 level progression in Single AI mode
    lastSingleAiOutcome: null, // 'win' | 'lose' | 'draw'
    localCount: 2, // 2~4P pass-and-play
    myTankType: 'cannon',
    selectedMapType: 'random',

    nickname: '',
    myClientId: 'u_' + Math.random().toString(36).slice(2, 9),
    soundEnabled: true,
    stats: { wins: 0, losses: 0, draws: 0 },

    // Multiplayer Room State
    currentRoom: null,

    // Active Match State (Client Render Copy + Local Single Engine Instance)
    localEngineMatch: null,
    renderMatch: null, // { mapType, terrain: Float32Array, wind, turnIndex, turnNumber, isPractice, practiceScore, practiceTargets, players, status, winnerId }
    isAnimatingTurn: false,
    spaceCharging: false,
    spaceChargeStartPower: 10,

    // Camera (Fixed vertical height = WORLD_HEIGHT 900, horizontal scroll camera.x)
    camera: {
      x: 0,
      targetX: 0,
      mode: 'followTank', // 'followTank' | 'followShell' | 'manual'
      shake: 0,
      isDragging: false,
      dragStartClientX: 0,
      dragStartCamX: 0
    },

    // Active Animations (Flying Projectiles, Explosions, Particles, Floating Texts)
    activeShell: null,
    explosions: [],
    particles: [],
    floatingTexts: [],
    windFlakes: [],
    scorchMarks: []
  };

  let turnTimerInterval = null;
  let turnSecondsLeft = TURN_LIMIT_SEC;
  let toastTimeoutId = null;
  let aiActionTimerId = null;
  let lastAimSyncAt = 0;

  // ==========================================
  // Web Audio API Synthesized Sound Effects
  // ==========================================
  let audioCtx = null;
  let distortionCurveCache = null;
  let activeFlightSound = null;

  function ensureAudio() {
    if (!app.soundEnabled) return null;
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function getSoftClipCurve() {
    if (distortionCurveCache) return distortionCurveCache;
    const samples = 1024;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(x * 2.4);
    }
    distortionCurveCache = curve;
    return curve;
  }

  function playUiClick(freq = 520) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.25, now + 0.05);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.065);
  }

  function stopShellFlightSound() {
    if (!activeFlightSound) return;
    const snd = activeFlightSound;
    activeFlightSound = null;
    try {
      const now = snd.ctx.currentTime;
      snd.masterGain.gain.cancelScheduledValues(now);
      snd.masterGain.gain.setValueAtTime(Math.max(0.0001, snd.masterGain.gain.value || 0.08), now);
      snd.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
      setTimeout(() => {
        for (const node of snd.sources) {
          try {
            node.stop();
          } catch (e) {}
          try {
            node.disconnect();
          } catch (e) {}
        }
        try {
          snd.masterGain.disconnect();
        } catch (e) {}
      }, 45);
    } catch (e) {}
  }

  function startShellFlightSound(weaponId = 'normal', pointCount = 55) {
    stopShellFlightSound();
    const ctx = ensureAudio();
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur = Math.min(3.4, Math.max(0.26, pointCount / 46));
    const apexTime = now + dur * 0.36;
    const endTime = now + dur;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.001, now);
    masterGain.gain.linearRampToValueAtTime(0.22, now + Math.min(0.08, dur * 0.25));
    masterGain.gain.setValueAtTime(0.22, Math.max(now + 0.09, endTime - 0.06));
    masterGain.gain.exponentialRampToValueAtTime(0.001, endTime + 0.04);
    masterGain.connect(ctx.destination);

    const sources = [];

    // 1. Aerodynamic Wind / Propulsion Rush (Bandpass-filtered noise tracking trajectory)
    const bufLen = Math.max(1, Math.floor(ctx.sampleRate * (dur + 0.1)));
    const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    let prev = 0;
    for (let i = 0; i < bufLen; i++) {
      const white = Math.random() * 2 - 1;
      prev = (prev + 0.08 * white) / 1.08;
      ch[i] = (white * 0.55 + prev * 1.6) * 0.7;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const aeroFilter = ctx.createBiquadFilter();
    aeroFilter.type = 'bandpass';
    aeroFilter.Q.value = weaponId === 'double' ? 2.4 : weaponId === 'power' ? 3.2 : 4.0;
    const startBand = weaponId === 'double' ? 1450 : weaponId === 'power' ? 680 : 1050;
    const apexBand = weaponId === 'double' ? 1850 : weaponId === 'power' ? 520 : 780;
    const endBand = weaponId === 'double' ? 920 : weaponId === 'power' ? 1180 : 1380;
    aeroFilter.frequency.setValueAtTime(startBand, now);
    aeroFilter.frequency.exponentialRampToValueAtTime(apexBand, apexTime);
    aeroFilter.frequency.exponentialRampToValueAtTime(endBand, endTime);

    const aeroGain = ctx.createGain();
    aeroGain.gain.value = weaponId === 'double' ? 0.85 : weaponId === 'power' ? 0.72 : 0.52;
    noiseSrc.connect(aeroFilter).connect(aeroGain).connect(masterGain);
    noiseSrc.start(now);
    noiseSrc.stop(endTime + 0.05);
    sources.push(noiseSrc);

    // 2. Weapon-Specific Ballistic Whistle / Thruster / Warp Tone
    if (weaponId === 'teleport') {
      // Sci-Fi Warp Phase Shimmer (FM modulated dual sine)
      const carrier = ctx.createOscillator();
      const modOsc = ctx.createOscillator();
      const modGain = ctx.createGain();
      const toneGain = ctx.createGain();

      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(520, now);
      carrier.frequency.exponentialRampToValueAtTime(1180, apexTime);
      carrier.frequency.exponentialRampToValueAtTime(640, endTime);

      modOsc.type = 'sine';
      modOsc.frequency.setValueAtTime(16, now);
      modOsc.frequency.linearRampToValueAtTime(28, endTime);
      modGain.gain.value = 55;

      toneGain.gain.value = 0.38;
      modOsc.connect(modGain).connect(carrier.frequency);
      carrier.connect(toneGain).connect(masterGain);

      carrier.start(now);
      modOsc.start(now);
      carrier.stop(endTime + 0.05);
      modOsc.stop(endTime + 0.05);
      sources.push(carrier, modOsc);
    } else if (weaponId === 'power') {
      // Heavy High-Explosive Warhead Scream + Pulsing Core Hum
      const whistle = ctx.createOscillator();
      const subHowl = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const wGain = ctx.createGain();

      whistle.type = 'sawtooth';
      whistle.frequency.setValueAtTime(640, now);
      whistle.frequency.exponentialRampToValueAtTime(760, apexTime);
      whistle.frequency.exponentialRampToValueAtTime(215, endTime);

      subHowl.type = 'triangle';
      subHowl.frequency.setValueAtTime(320, now);
      subHowl.frequency.exponentialRampToValueAtTime(380, apexTime);
      subHowl.frequency.exponentialRampToValueAtTime(108, endTime);

      lfo.type = 'sine';
      lfo.frequency.value = 18;
      lfoGain.gain.value = 26;
      lfo.connect(lfoGain).connect(whistle.frequency);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1550;

      wGain.gain.value = 0.34;
      whistle.connect(lp);
      subHowl.connect(lp);
      lp.connect(wGain).connect(masterGain);

      whistle.start(now);
      subHowl.start(now);
      lfo.start(now);
      whistle.stop(endTime + 0.05);
      subHowl.stop(endTime + 0.05);
      lfo.stop(endTime + 0.05);
      sources.push(whistle, subHowl, lfo);
    } else if (weaponId === 'double') {
      // High-Velocity Rocket Booster Turbine Whistle
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const rGain = ctx.createGain();

      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(680, now);
      osc1.frequency.exponentialRampToValueAtTime(1060, apexTime);
      osc1.frequency.exponentialRampToValueAtTime(420, endTime);

      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(1020, now);
      osc2.frequency.exponentialRampToValueAtTime(1480, apexTime);
      osc2.frequency.exponentialRampToValueAtTime(590, endTime);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 1.8;

      rGain.gain.value = 0.28;
      osc1.connect(bp);
      osc2.connect(bp);
      bp.connect(rGain).connect(masterGain);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(endTime + 0.05);
      osc2.stop(endTime + 0.05);
      sources.push(osc1, osc2);
    } else {
      // Classic Artillery Shell Whistle (피유우우웅~ Doppler descent arc)
      const whistle = ctx.createOscillator();
      const harmonic = ctx.createOscillator();
      const wGain = ctx.createGain();
      const hGain = ctx.createGain();

      whistle.type = 'sine';
      whistle.frequency.setValueAtTime(840, now);
      whistle.frequency.exponentialRampToValueAtTime(980, apexTime);
      whistle.frequency.exponentialRampToValueAtTime(310, endTime);

      harmonic.type = 'triangle';
      harmonic.frequency.setValueAtTime(1680, now);
      harmonic.frequency.exponentialRampToValueAtTime(1920, apexTime);
      harmonic.frequency.exponentialRampToValueAtTime(620, endTime);

      wGain.gain.value = 0.34;
      hGain.gain.value = 0.09;

      whistle.connect(wGain).connect(masterGain);
      harmonic.connect(hGain).connect(masterGain);

      whistle.start(now);
      harmonic.start(now);
      whistle.stop(endTime + 0.05);
      harmonic.stop(endTime + 0.05);
      sources.push(whistle, harmonic);
    }

    activeFlightSound = { ctx, masterGain, sources };
  }

  function playCannonFireSound(weaponOrHeavy = 'normal') {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const wpnId =
      weaponOrHeavy === true
        ? 'power'
        : typeof weaponOrHeavy === 'string'
        ? weaponOrHeavy
        : 'normal';
    const isHeavy = wpnId === 'power';
    const isRocket = wpnId === 'double';

    // 1. Sharp Muzzle Crack / Breech Snap
    const crackOsc = ctx.createOscillator();
    const crackGain = ctx.createGain();
    crackOsc.type = 'triangle';
    crackOsc.frequency.setValueAtTime(isHeavy ? 420 : isRocket ? 620 : 510, now);
    crackOsc.frequency.exponentialRampToValueAtTime(68, now + 0.065);
    crackGain.gain.setValueAtTime(0.32, now);
    crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    crackOsc.connect(crackGain).connect(ctx.destination);
    crackOsc.start(now);
    crackOsc.stop(now + 0.075);

    // 2. Deep Saturated Cannon Barrel Thump
    const bodyOsc = ctx.createOscillator();
    const subOsc = ctx.createOscillator();
    const shaper = ctx.createWaveShaper();
    shaper.curve = getSoftClipCurve();
    const bodyGain = ctx.createGain();

    const bodyDur = isHeavy ? 0.46 : isRocket ? 0.28 : 0.34;
    bodyOsc.type = 'sawtooth';
    bodyOsc.frequency.setValueAtTime(isHeavy ? 155 : isRocket ? 210 : 180, now);
    bodyOsc.frequency.exponentialRampToValueAtTime(isHeavy ? 24 : 32, now + bodyDur);

    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(isHeavy ? 110 : 135, now);
    subOsc.frequency.exponentialRampToValueAtTime(22, now + bodyDur);

    bodyGain.gain.setValueAtTime(isHeavy ? 0.38 : 0.32, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + bodyDur + 0.02);

    bodyOsc.connect(shaper);
    subOsc.connect(shaper);
    shaper.connect(bodyGain).connect(ctx.destination);
    bodyOsc.start(now);
    subOsc.start(now);
    bodyOsc.stop(now + bodyDur + 0.03);
    subOsc.stop(now + bodyDur + 0.03);

    // 3. Gunpowder Propellant Blast Roar
    const noiseDur = isHeavy ? 0.34 : 0.25;
    const bufSize = Math.floor(ctx.sampleRate * noiseDur);
    const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const out = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      const env = Math.pow(1 - i / bufSize, 1.35);
      out[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2.2;
    filter.frequency.setValueAtTime(isHeavy ? 1250 : isRocket ? 1800 : 1450, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + noiseDur);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(isHeavy ? 0.34 : 0.28, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + noiseDur);
    src.connect(filter).connect(nGain).connect(ctx.destination);
    src.start(now);
  }

  function playExplosionSound(radius = 48, weaponId = 'normal') {
    stopShellFlightSound();
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const isPower = weaponId === 'power' || radius >= 68;
    const isDouble = weaponId === 'double';
    const dur = Math.min(1.25, (isPower ? 0.68 : 0.44) + radius * 0.0065);

    const shaper = ctx.createWaveShaper();
    shaper.curve = getSoftClipCurve();

    // Layer 1: Detonation Impact Crack (Initial high-energy transient snap)
    const snapOsc = ctx.createOscillator();
    const snapGain = ctx.createGain();
    snapOsc.type = 'sawtooth';
    snapOsc.frequency.setValueAtTime(isPower ? 520 : isDouble ? 640 : 460, now);
    snapOsc.frequency.exponentialRampToValueAtTime(38, now + 0.085);
    snapGain.gain.setValueAtTime(isPower ? 0.42 : 0.34, now);
    snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    snapOsc.connect(shaper);
    snapOsc.connect(snapGain).connect(ctx.destination);
    snapOsc.start(now);
    snapOsc.stop(now + 0.095);

    // Layer 2: Deep Sub-Bass Shockwave Boom (Chest-thumping low frequency wave)
    const subOsc = ctx.createOscillator();
    const punchOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    const subDur = Math.min(1.1, dur * 0.92);

    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(isPower ? 155 : 130, now);
    subOsc.frequency.exponentialRampToValueAtTime(isPower ? 18 : 24, now + subDur);

    punchOsc.type = 'triangle';
    punchOsc.frequency.setValueAtTime(isPower ? 220 : 185, now);
    punchOsc.frequency.exponentialRampToValueAtTime(28, now + subDur * 0.65);

    subGain.gain.setValueAtTime(isPower ? 0.48 : 0.38, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + subDur);

    subOsc.connect(shaper);
    punchOsc.connect(shaper);
    shaper.connect(subGain).connect(ctx.destination);
    subOsc.start(now);
    punchOsc.start(now);
    subOsc.stop(now + subDur + 0.02);
    punchOsc.stop(now + subDur * 0.68);

    // Layer 3: Fiery Blast Roar (Full-bodied textured explosion noise)
    const bufSize = Math.floor(ctx.sampleRate * dur);
    const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < bufSize; i++) {
      const t = i / bufSize;
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.06 * white) / 1.06;
      const attack = Math.min(1, i / (ctx.sampleRate * 0.008));
      const decay = Math.pow(1 - t, isPower ? 1.15 : 1.45);
      // Add subtle rumble modulation in the tail
      const rumbleMod = 0.82 + 0.18 * Math.sin(i * 0.015);
      data[i] = (white * 0.55 + brown * 2.1) * attack * decay * rumbleMod;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = isPower ? 3.0 : 2.1;
    filter.frequency.setValueAtTime(isPower ? 1850 : 1450, now);
    filter.frequency.exponentialRampToValueAtTime(isPower ? 52 : 68, now + dur);

    const gain = ctx.createGain();
    const peakGain = Math.min(0.52, (isPower ? 0.36 : 0.28) + radius * 0.0025);
    gain.gain.setValueAtTime(peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(now);

    // Layer 4: Secondary Debris & Earth/Rock Crumble Tail
    const debrisCount = isPower ? 4 : 2;
    for (let d = 0; d < debrisCount; d++) {
      const delay = 0.07 + d * 0.085 + Math.random() * 0.04;
      const dDur = 0.12 + Math.random() * 0.1;
      const dLen = Math.floor(ctx.sampleRate * dDur);
      const dBuf = ctx.createBuffer(1, dLen, ctx.sampleRate);
      const dCh = dBuf.getChannelData(0);
      for (let i = 0; i < dLen; i++) {
        dCh[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / dLen, 1.8);
      }
      const dSrc = ctx.createBufferSource();
      dSrc.buffer = dBuf;
      const dBp = ctx.createBiquadFilter();
      dBp.type = 'bandpass';
      dBp.frequency.value = 320 + d * 190;
      dBp.Q.value = 1.6;
      const dGain = ctx.createGain();
      dGain.gain.setValueAtTime(0.14 * Math.pow(0.78, d), now + delay);
      dGain.gain.exponentialRampToValueAtTime(0.001, now + delay + dDur);
      dSrc.connect(dBp).connect(dGain).connect(ctx.destination);
      dSrc.start(now + delay);
    }

    // Layer 5: High-Explosive (고폭탄) Seismic Aftershock & Plasma Crackle
    if (isPower) {
      const quakeOsc = ctx.createOscillator();
      const quakeGain = ctx.createGain();
      quakeOsc.type = 'sawtooth';
      quakeOsc.frequency.setValueAtTime(86, now + 0.05);
      quakeOsc.frequency.exponentialRampToValueAtTime(16, now + 1.05);
      const quakeLp = ctx.createBiquadFilter();
      quakeLp.type = 'lowpass';
      quakeLp.frequency.value = 140;
      quakeGain.gain.setValueAtTime(0.28, now + 0.05);
      quakeGain.gain.exponentialRampToValueAtTime(0.001, now + 1.08);
      quakeOsc.connect(quakeLp).connect(quakeGain).connect(ctx.destination);
      quakeOsc.start(now + 0.05);
      quakeOsc.stop(now + 1.1);
    }
  }

  function playWaterSplashSound() {
    stopShellFlightSound();
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;

    // 1. Plunge Bubble Pitch-Up ("풍덩!")
    const plungeOsc = ctx.createOscillator();
    const plungeGain = ctx.createGain();
    plungeOsc.type = 'sine';
    plungeOsc.frequency.setValueAtTime(145, now);
    plungeOsc.frequency.exponentialRampToValueAtTime(520, now + 0.19);
    plungeGain.gain.setValueAtTime(0.26, now);
    plungeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    plungeOsc.connect(plungeGain).connect(ctx.destination);
    plungeOsc.start(now);
    plungeOsc.stop(now + 0.23);

    // 2. Water Spray Splash ("쏴아아~")
    const dur = 0.45;
    const bufSize = Math.floor(ctx.sampleRate * dur);
    const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 1.3);
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(1150, now);
    bp.frequency.exponentialRampToValueAtTime(280, now + dur);
    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.24, now);
    sGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(sGain).connect(ctx.destination);
    src.start(now);
  }

  function playHealOrTeleportSound(isTeleport = false) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = isTeleport ? [360, 540, 780, 1040] : [440, 554, 659, 880];
    notes.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + idx * 0.06);
      g.gain.setValueAtTime(0.11, now + idx * 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.16);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + idx * 0.06);
      osc.stop(now + idx * 0.06 + 0.17);
    });
  }

  function playFanfareSound(result) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const seq =
      result === 'win'
        ? [523, 659, 784, 1046]
        : result === 'lose'
        ? [392, 349, 311, 261]
        : [440, 523, 440, 523];
    seq.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, now + i * 0.11);
      g.gain.setValueAtTime(0.14, now + i * 0.11);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.28);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.3);
    });
  }

  // ==========================================
  // Local Storage Persistence
  // ==========================================
  function loadSavedProfile() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.nickname) app.nickname = String(parsed.nickname).slice(0, 10);
      if (parsed.myTankType && Engine.TANK_TYPES[parsed.myTankType]) {
        app.myTankType = parsed.myTankType;
      }
      if (parsed.stats) {
        app.stats = {
          wins: Math.max(0, Number(parsed.stats.wins) || 0),
          losses: Math.max(0, Number(parsed.stats.losses) || 0),
          draws: Math.max(0, Number(parsed.stats.draws) || 0)
        };
      }
      if (typeof parsed.soundEnabled === 'boolean') {
        app.soundEnabled = parsed.soundEnabled;
      }
    } catch (e) {}
  }

  function saveProfile() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          nickname: app.nickname,
          myTankType: app.myTankType,
          stats: app.stats,
          soundEnabled: app.soundEnabled
        })
      );
    } catch (e) {}
    renderHeaderStats();
  }

  function renderHeaderStats() {
    const w = app.stats.wins;
    const l = app.stats.losses;
    const d = app.stats.draws;
    const total = w + l + d;
    const rate = total > 0 ? Math.round((w / total) * 100) : 0;

    const elW = document.getElementById('hdr-stat-w');
    const elL = document.getElementById('hdr-stat-l');
    const elR = document.getElementById('hdr-stat-r');
    if (elW) elW.textContent = String(w);
    if (elL) elL.textContent = String(l);
    if (elR) elR.textContent = `${rate}%`;

    const sIcon = app.soundEnabled ? '🔊' : '🔇';
    const b1 = document.getElementById('btn-sound-toggle');
    const b2 = document.getElementById('btn-battle-sound');
    if (b1) b1.textContent = sIcon;
    if (b2) b2.textContent = sIcon;
  }

  // ==========================================
  // Screen Navigation
  // ==========================================
  function showScreen(name) {
    if (name !== 'game') {
      stopShellFlightSound();
    }
    app.screen = name;
    const screens = ['menu', 'single-setup', 'lobby', 'room', 'guide', 'game'];
    for (const s of screens) {
      const el = document.getElementById(`screen-${s}`);
      if (el) el.classList.toggle('hidden', s !== name);
    }
    const hdr = document.getElementById('global-header');
    if (hdr) hdr.classList.toggle('hidden', name === 'game');

    if (name === 'game') {
      requestAnimationFrame(() => {
        resizeBattleCanvas();
      });
    }
  }

  function showToast(text, durationMs = 2400) {
    const el = document.getElementById('battle-toast');
    if (!el) return;
    if (toastTimeoutId) clearTimeout(toastTimeoutId);
    el.textContent = text;
    el.classList.remove('hidden');
    toastTimeoutId = setTimeout(() => {
      el.classList.add('hidden');
    }, durationMs);
  }

  function validateNickname() {
    const input = document.getElementById('input-nickname');
    const val = (input ? input.value : app.nickname).trim();
    const pill = document.getElementById('name-input-pill');
    const warn = document.getElementById('id-warning-msg');

    if (!val) {
      if (pill) {
        pill.classList.remove('input-error');
        void pill.offsetWidth;
        pill.classList.add('input-error');
      }
      if (warn) warn.classList.remove('hidden');
      if (input) input.focus();
      return false;
    }

    app.nickname = val.slice(0, 10);
    if (pill) pill.classList.remove('input-error');
    if (warn) warn.classList.add('hidden');
    saveProfile();
    return true;
  }

  // ==========================================
  // Canvas & Camera Sizing (Fixed Height + Horizontal Scroll!)
  // ==========================================
  const gameCanvas = document.getElementById('game-canvas');
  const ctx = gameCanvas.getContext('2d');
  const minimapCanvas = document.getElementById('minimap-canvas');
  const miniCtx = minimapCanvas.getContext('2d');

  let viewCssW = 800;
  let viewCssH = 500;
  let viewDpr = 1;

  function resizeBattleCanvas() {
    const stage = document.getElementById('battle-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    viewCssW = rect.width;
    viewCssH = rect.height;
    viewDpr = Math.min(window.devicePixelRatio || 1, 2);

    gameCanvas.width = Math.round(viewCssW * viewDpr);
    gameCanvas.height = Math.round(viewCssH * viewDpr);

    // Minimap HiDPI
    const mRect = minimapCanvas.getBoundingClientRect();
    if (mRect.width > 10 && mRect.height > 10) {
      minimapCanvas.width = Math.round(mRect.width * viewDpr);
      minimapCanvas.height = Math.round(mRect.height * viewDpr);
    }

    clampCamera();
  }

  window.addEventListener('resize', resizeBattleCanvas);

  // Height is strictly fixed to WORLD_HEIGHT (900).
  // Scale = viewCssH / 900. Horizontal visible world width = viewCssW / scale.
  function getWorldScale() {
    return viewCssH / Engine.WORLD_HEIGHT;
  }

  // Detect smartphone screens so tanks & nicknames are boosted ONLY on smartphones (PC unchanged!)
  function isSmartphoneScreen() {
    const w = window.innerWidth || viewCssW;
    const h = window.innerHeight || viewCssH;
    const shortSide = Math.min(w, h);
    const coarse = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    return shortSide <= 680 || (coarse && shortSide <= 920);
  }

  function getMobileTankBoost() {
    if (!isSmartphoneScreen()) return 1.0; // PC keeps exact original 1.0 ratio
    const ws = Math.max(0.24, getWorldScale());
    // Balanced smartphone boost (~1.48x in portrait, up to ~1.82x in compact landscape) so tanks look crisp without distortion
    return Engine.clamp(0.74 / ws, 1.48, 1.82);
  }

  function getVisibleWorldWidth() {
    return viewCssW / getWorldScale();
  }

  function getMaxCameraX() {
    return Math.max(0, Engine.WORLD_WIDTH - getVisibleWorldWidth());
  }

  function clampCamera() {
    const maxCam = getMaxCameraX();
    app.camera.x = Engine.clamp(app.camera.x, 0, maxCam);
    app.camera.targetX = Engine.clamp(app.camera.targetX, 0, maxCam);
  }

  function centerCameraOnWorldX(worldX, immediate = false) {
    const visW = getVisibleWorldWidth();
    const maxCam = getMaxCameraX();
    const goal = Engine.clamp(worldX - visW * 0.5, 0, maxCam);
    app.camera.targetX = goal;
    if (immediate) app.camera.x = goal;
  }

  function focusActiveTank(immediate = false) {
    if (!app.renderMatch) return;
    const active = app.renderMatch.players[app.renderMatch.turnIndex];
    if (!active) return;
    app.camera.mode = 'followTank';
    centerCameraOnWorldX(active.x, immediate);
    updateFloatingRecenterBtn();
  }

  function updateFloatingRecenterBtn() {
    const btn = document.getElementById('btn-floating-recenter');
    if (!btn) return;
    const show = app.screen === 'game' && app.camera.mode === 'manual' && !app.isAnimatingTurn;
    btn.classList.toggle('hidden', !show);
  }

  // ==========================================
  // Turn Control Helpers
  // ==========================================
  function getActivePlayer() {
    if (!app.renderMatch) return null;
    return app.renderMatch.players[app.renderMatch.turnIndex] || null;
  }

  function isMyControllableTurn() {
    if (app.screen !== 'game' || !app.renderMatch || app.renderMatch.status !== 'playing') return false;
    if (app.isAnimatingTurn) return false;
    const active = getActivePlayer();
    if (!active || !active.alive) return false;

    if (app.mode === 'single') {
      return !active.isAi;
    }
    return active.id === app.myClientId;
  }

  function initWindParticles() {
    app.windFlakes = [];
    for (let i = 0; i < 42; i++) {
      app.windFlakes.push({
        x: Math.random() * Engine.WORLD_WIDTH,
        y: 40 + Math.random() * (Engine.WATER_LEVEL - 120),
        r: 1.4 + Math.random() * 2.2,
        vy: 14 + Math.random() * 22,
        alpha: 0.2 + Math.random() * 0.45
      });
    }
  }

  function hydrateRenderMatchFromExport(exported) {
    app.renderMatch = {
      seed: exported.seed,
      mapType: exported.mapType,
      aiLevel: exported.aiLevel || app.aiLevel || 1,
      terrain: new Float32Array(exported.terrain),
      wind: exported.wind,
      turnIndex: exported.turnIndex,
      turnNumber: exported.turnNumber,
      isPractice: Boolean(exported.isPractice),
      practiceScore: exported.practiceScore || 0,
      practiceTargets: exported.practiceTargets ? JSON.parse(JSON.stringify(exported.practiceTargets)) : [],
      status: exported.status,
      winnerId: exported.winnerId,
      players: JSON.parse(JSON.stringify(exported.players))
    };
    app.isAnimatingTurn = false;
    app.activeShell = null;
    app.explosions = [];
    app.particles = [];
    app.floatingTexts = [];
    app.scorchMarks = [];
    initWindParticles();
  }

  // ==========================================
  // Single Player Match Launch (1~4P AI / Local / Practice)
  // ==========================================
  function startSingleGame() {
    clearAiTimer();
    clearTurnCountdown();
    document.getElementById('gameover-modal').classList.add('hidden');

    app.mode = 'single';
    const maxLv = Engine.MAX_AI_LEVEL || 30;
    app.aiLevel = Engine.clamp(Math.round(Number(app.aiLevel) || 1), 1, maxLv);
    const aiSpec = Engine.getAiLevelSpec ? Engine.getAiLevelSpec(app.aiLevel) : { level: app.aiLevel, tierName: 'AI' };
    const playerConfigs = [];

    if (app.singleSubMode === 'ai') {
      // Player 1 = Human
      playerConfigs.push({
        id: app.myClientId,
        nickname: app.nickname || '명사수',
        isAi: false,
        tankType: app.myTankType
      });

      const aiTankPool = ['cannon', 'duke', 'multi', 'laser'];
      const aiBaseNames = ['알파포병', '호크아이', '아이언돔'];
      for (let i = 0; i < app.aiCount; i++) {
        const baseName = aiBaseNames[i] || `AI-${i + 1}`;
        playerConfigs.push({
          id: `ai_${i + 1}`,
          nickname: `Lv.${app.aiLevel} ${baseName}`,
          isAi: true,
          tankType: aiTankPool[(i + 1 + app.aiLevel) % aiTankPool.length]
        });
      }
    } else {
      // Local Pass-and-Play (2~4 human players taking turns on one device)
      const localTankPool = [app.myTankType, 'duke', 'multi', 'laser'];
      for (let i = 0; i < app.localCount; i++) {
        playerConfigs.push({
          id: i === 0 ? app.myClientId : `local_${i + 1}`,
          nickname: i === 0 ? app.nickname || '1P' : `${i + 1}P 플레이어`,
          isAi: false,
          tankType: localTankPool[i % localTankPool.length]
        });
      }
    }

    app.localEngineMatch = Engine.createMatch({
      mapType: app.selectedMapType,
      aiLevel: app.aiLevel,
      players: playerConfigs
    });

    hydrateRenderMatchFromExport(Engine.exportMatchState(app.localEngineMatch));
    showScreen('game');
    resizeBattleCanvas();
    focusActiveTank(true);
    syncAllBattleHud();

    const totalP = playerConfigs.length;
    const themeName = (Engine.MAP_THEMES[app.renderMatch.mapType] || {}).name || '랜덤 전장';
    if (app.renderMatch.isPractice) {
      showToast(`🎯 탱크 클래시 영점 사격 연습! (${themeName}) — 바람과 거리를 계산해 표적을 맞히세요`, 3200);
    } else if (app.singleSubMode === 'ai') {
      showToast(
        `💣 [LV.${app.aiLevel}/${maxLv} · ${aiSpec.tierName}] ${totalP}인용 탱크 클래시 시작! [지형: ${themeName}]`,
        2900
      );
    } else {
      showToast(`💣 ${totalP}인용 탱크 클래시 (Tank Clash) 시작! [지형: ${themeName}]`, 2600);
    }

    beginTurnPhase();
  }

  function clearAiTimer() {
    if (aiActionTimerId) {
      clearTimeout(aiActionTimerId);
      aiActionTimerId = null;
    }
  }

  function clearTurnCountdown() {
    if (turnTimerInterval) {
      clearInterval(turnTimerInterval);
      turnTimerInterval = null;
    }
  }

  function beginTurnPhase() {
    clearTurnCountdown();
    clearAiTimer();
    if (!app.renderMatch || app.renderMatch.status !== 'playing') return;

    const active = getActivePlayer();
    if (!active) return;

    focusActiveTank(false);
    syncAllBattleHud();

    // Start 35s turn timer (skip countdown in 1P practice mode)
    const timerBadge = document.getElementById('turn-timer');
    if (app.renderMatch.isPractice) {
      if (timerBadge) {
        timerBadge.textContent = `점수 ${app.renderMatch.practiceScore}`;
        timerBadge.classList.remove('urgent');
      }
      return;
    }

    turnSecondsLeft = TURN_LIMIT_SEC;
    renderTimerBadge();

    turnTimerInterval = setInterval(() => {
      if (app.screen !== 'game' || !app.renderMatch || app.renderMatch.status !== 'playing' || app.isAnimatingTurn) {
        return;
      }
      turnSecondsLeft = Math.max(0, turnSecondsLeft - 1);
      renderTimerBadge();

      if (turnSecondsLeft <= 5 && turnSecondsLeft > 0 && isMyControllableTurn()) {
        playUiClick(740);
      }

      if (turnSecondsLeft <= 0) {
        clearTurnCountdown();
        if (app.mode === 'single' && isMyControllableTurn()) {
          showToast('⏰ 제한시간 초과! 자동 발사합니다.');
          triggerPlayerFire();
        }
      }
    }, 1000);

    // If Single Player & Active Player is AI -> run AI Zeroing-In sequence!
    if (app.mode === 'single' && active.isAi) {
      scheduleSingleAiTurn();
    } else if (app.mode === 'single' && app.singleSubMode === 'local') {
      showToast(`${active.badge} ${active.nickname}님의 차례입니다!`, 1800);
    }
  }

  function renderTimerBadge() {
    const timerBadge = document.getElementById('turn-timer');
    if (!timerBadge) return;
    timerBadge.textContent = `${turnSecondsLeft}s`;
    timerBadge.classList.toggle('urgent', turnSecondsLeft <= 5);
  }

  // Animate AI moving, calculating zeroing adjustment, aiming barrel, and firing!
  function scheduleSingleAiTurn() {
    if (!app.localEngineMatch || !app.renderMatch) return;
    const aiIdx = app.localEngineMatch.turnIndex;
    const aiPlan = Engine.computeAiTurn(app.localEngineMatch, aiIdx);
    if (!aiPlan) return;

    const renderAi = app.renderMatch.players[aiIdx];
    if (aiPlan.aiNote) {
      showToast(`🤖 ${renderAi.nickname}: ${aiPlan.aiNote}`, 2700);
    }

    let stepDelay = 550;

    // 1. Replay AI movement steps smoothly on client
    if (aiPlan.moves && aiPlan.moves.length > 0) {
      aiPlan.moves.forEach((mv, idx) => {
        setTimeout(() => {
          if (app.screen !== 'game' || !app.renderMatch) return;
          renderAi.x = mv.x;
          renderAi.y = mv.y;
          renderAi.facing = mv.facing;
          renderAi.fuel = mv.fuel;
          centerCameraOnWorldX(renderAi.x, false);
          syncControlDeckUI();
        }, 300 + idx * 55);
      });
      stepDelay += aiPlan.moves.length * 55 + 220;
    }

    // 2. Smoothly rotate AI turret to chosen angle
    aiActionTimerId = setTimeout(() => {
      if (app.screen !== 'game' || !app.renderMatch || !app.localEngineMatch) return;
      renderAi.facing = aiPlan.facing;
      renderAi.angle = aiPlan.angle;
      renderAi.power = aiPlan.power;
      renderAi.selectedWeapon = aiPlan.weapon;
      syncControlDeckUI();

      // 3. Fire after brief aim lock pause
      aiActionTimerId = setTimeout(() => {
        if (app.screen !== 'game' || !app.localEngineMatch) return;
        const result = Engine.executeTurnAction(app.localEngineMatch, aiPlan);
        if (result) {
          playTurnResultAnimation(result, () => {
            if (app.localEngineMatch.status === 'finished') {
              handleSingleMatchFinished();
            } else {
              beginTurnPhase();
            }
          });
        }
      }, 520);
    }, stepDelay);
  }

  // ==========================================
  // Player Controls: Move, Angle, Weapon, Power, Fire
  // ==========================================
  function performTankMove(dir) {
    if (!isMyControllableTurn()) return;
    const active = getActivePlayer();
    if (!active) return;

    app.camera.mode = 'followTank';
    updateFloatingRecenterBtn();

    if (app.mode === 'single') {
      const moved = Engine.moveTank(app.localEngineMatch, app.localEngineMatch.turnIndex, dir, 4.0);
      const src = app.localEngineMatch.players[app.localEngineMatch.turnIndex];
      active.x = src.x;
      active.y = src.y;
      active.facing = src.facing;
      active.fuel = src.fuel;
      active.alive = src.alive;
      centerCameraOnWorldX(active.x, false);
      syncAllBattleHud();

      if (!src.alive) {
        // Sank into water while moving!
        Engine.executeTurnAction(app.localEngineMatch, {
          facing: src.facing,
          angle: src.angle,
          power: 10,
          weapon: 'normal'
        });
        // Check alive players
        const alive = app.localEngineMatch.players.filter((p) => p.alive);
        if (!app.localEngineMatch.isPractice && alive.length <= 1) {
          app.localEngineMatch.status = 'finished';
          app.localEngineMatch.winnerId = alive.length === 1 ? alive[0].id : null;
          handleSingleMatchFinished();
        } else {
          hydrateRenderMatchFromExport(Engine.exportMatchState(app.localEngineMatch));
          beginTurnPhase();
        }
      } else if (moved) {
        playUiClick(240);
      }
    } else {
      // Multiplayer: optimistic smooth local step + send move_tank to server
      Engine.moveTank(app.renderMatch, app.renderMatch.turnIndex, dir, 4.0);
      centerCameraOnWorldX(active.x, false);
      syncAllBattleHud();
      netSend({ type: 'move_tank', dir, dist: 4.0 });
    }
  }

  function adjustCannonAngle(delta) {
    if (!isMyControllableTurn()) return;
    const active = getActivePlayer();
    if (!active) return;
    const spec = Engine.TANK_TYPES[active.tankType] || Engine.TANK_TYPES.cannon;
    const nextAng = Engine.clamp(active.angle + delta, spec.minAngle, spec.maxAngle);
    if (nextAng === active.angle) return;

    active.angle = nextAng;
    if (app.mode === 'single' && app.localEngineMatch) {
      app.localEngineMatch.players[app.localEngineMatch.turnIndex].angle = nextAng;
    } else {
      throttledAimSync();
    }
    app.camera.mode = 'followTank';
    centerCameraOnWorldX(active.x, false);
    updateFloatingRecenterBtn();
    syncControlDeckUI();
    playUiClick(430 + nextAng * 3);
  }

  function adjustPower(delta) {
    if (!isMyControllableTurn()) return;
    const active = getActivePlayer();
    if (!active) return;
    active.power = Engine.clamp(Math.round(active.power + delta), 10, 100);
    if (app.mode === 'single' && app.localEngineMatch) {
      app.localEngineMatch.players[app.localEngineMatch.turnIndex].power = active.power;
    }
    syncControlDeckUI();
  }

  function setPowerDirect(val) {
    if (!isMyControllableTurn()) return;
    const active = getActivePlayer();
    if (!active) return;
    active.power = Engine.clamp(Math.round(val), 10, 100);
    if (app.mode === 'single' && app.localEngineMatch) {
      app.localEngineMatch.players[app.localEngineMatch.turnIndex].power = active.power;
    }
    syncControlDeckUI();
  }

  function selectWeapon(wpnId) {
    if (!isMyControllableTurn()) return;
    const active = getActivePlayer();
    if (!active || !Engine.WEAPONS[wpnId]) return;
    if (wpnId !== 'normal' && (!active.ammo || active.ammo[wpnId] <= 0)) {
      showToast('⚠️ 해당 특수 포탄/아이템을 모두 소진했습니다!', 1500);
      return;
    }
    active.selectedWeapon = wpnId;
    if (app.mode === 'single' && app.localEngineMatch) {
      app.localEngineMatch.players[app.localEngineMatch.turnIndex].selectedWeapon = wpnId;
    } else {
      throttledAimSync(true);
    }
    playUiClick(620);
    syncControlDeckUI();
  }

  function throttledAimSync(force = false) {
    if (app.mode !== 'multi') return;
    const active = getActivePlayer();
    if (!active) return;
    const now = performance.now();
    if (!force && now - lastAimSyncAt < 90) return;
    lastAimSyncAt = now;
    netSend({
      type: 'aim_sync',
      facing: active.facing,
      angle: active.angle,
      weapon: active.selectedWeapon
    });
  }

  function triggerPlayerFire() {
    if (!isMyControllableTurn()) return;
    const active = getActivePlayer();
    if (!active) return;

    app.spaceCharging = false;
    clearTurnCountdown();

    const payload = {
      facing: active.facing,
      angle: active.angle,
      power: active.power,
      weapon: active.selectedWeapon || 'normal'
    };

    if (app.mode === 'single') {
      const result = Engine.executeTurnAction(app.localEngineMatch, payload);
      if (!result) return;
      playTurnResultAnimation(result, () => {
        if (app.localEngineMatch.status === 'finished') {
          handleSingleMatchFinished();
        } else {
          beginTurnPhase();
        }
      });
    } else {
      app.isAnimatingTurn = true;
      syncControlDeckUI();
      netSend({
        type: 'fire_turn',
        ...payload
      });
    }
  }

  // ==========================================
  // Turn Shot & Crater Playback Sequencer
  // ==========================================
  function spawnExplosionVisual(x, y, radius, weaponId = 'normal') {
    const isTeleport = weaponId === 'teleport' || weaponId === true;
    if (isTeleport) {
      playHealOrTeleportSound(true);
      app.explosions.push({ x, y, maxR: 54, age: 0, dur: 0.52, kind: 'teleport', color: '#22d3ee' });
      for (let i = 0; i < 28; i++) {
        const ang = (Math.PI * 2 * i) / 28;
        const spd = 65 + Math.random() * 150;
        app.particles.push({
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 2.5 + Math.random() * 2.8,
          color: i % 3 === 0 ? '#c084fc' : i % 2 === 0 ? '#22d3ee' : '#ecfeff',
          life: 0.58,
          maxLife: 0.58,
          gravity: 0
        });
      }
      return;
    }

    const isPower = weaponId === 'power';
    const isDouble = weaponId === 'double';
    playExplosionSound(radius, weaponId);
    app.camera.shake = Math.min(isPower ? 24 : 18, (isPower ? 10 : 6) + radius * 0.16);
    app.explosions.push({
      x,
      y,
      maxR: radius * (isPower ? 1.55 : 1.35),
      age: 0,
      dur: isPower ? 0.68 : 0.52,
      kind: isPower ? 'power' : isDouble ? 'double' : 'normal',
      color: isPower ? '#ef4444' : '#f97316'
    });
    app.scorchMarks.push({ x, y, r: radius * 1.08 });
    if (app.scorchMarks.length > 40) app.scorchMarks.shift();

    const count = Math.min(isPower ? 64 : 48, 18 + Math.round(radius * (isPower ? 0.62 : 0.45)));
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI + Math.random() * Math.PI * 2;
      const spd = 70 + Math.random() * (180 + radius * (isPower ? 2.8 : 2.2));
      const fire = i % 3 !== 0;
      let pCol = '#78350f';
      if (fire) {
        if (isPower) {
          pCol = i % 2 === 0 ? '#fde047' : '#ef4444';
        } else if (isDouble) {
          pCol = i % 2 === 0 ? '#38bdf8' : '#fb923c';
        } else {
          pCol = Math.random() > 0.45 ? '#fbbf24' : '#ef4444';
        }
      }
      app.particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 65,
        r: fire ? 2.5 + Math.random() * (isPower ? 4.4 : 3.5) : 3 + Math.random() * 3,
        color: pCol,
        life: 0.55 + Math.random() * 0.45,
        maxLife: 0.95,
        gravity: 340
      });
    }
  }

  function playTurnResultAnimation(result, onComplete) {
    if (!app.renderMatch) {
      if (onComplete) onComplete();
      return;
    }

    app.isAnimatingTurn = true;
    syncControlDeckUI();

    const shooter = app.renderMatch.players.find((p) => p.id === result.shooterId);
    if (shooter) {
      if (result.facing) shooter.facing = result.facing;
      if (result.angle) shooter.angle = result.angle;
      if (result.power) shooter.power = result.power;
    }

    if (result.aiNote && shooter && shooter.isAi) {
      showToast(`🤖 ${shooter.nickname}: ${result.aiNote}`, 2400);
    }

    // Case A: Heal Kit
    if (result.kind === 'heal') {
      playHealOrTeleportSound(false);
      if (shooter) {
        shooter.hp = Math.min(shooter.maxHp || 100, shooter.hp + (result.healed || 0));
        syncPlayersStripUI();
        centerCameraOnWorldX(shooter.x, false);
        app.floatingTexts.push({
          x: shooter.x,
          y: shooter.y - 42,
          text: `+${result.healed} HP 수리!`,
          color: '#4ade80',
          age: 0,
          dur: 1.3
        });
      }
      setTimeout(() => {
        applyPostTurnSnapshot(result);
        if (onComplete) onComplete();
      }, 950);
      return;
    }

    // Case B: Projectile Sequence (1 or 2 shells)
    const projectiles = result.projectiles || [];
    if (projectiles.length === 0) {
      applyPostTurnSnapshot(result);
      if (onComplete) onComplete();
      return;
    }

    let projIdx = 0;

    function runNextProjectile() {
      if (!app.renderMatch || projIdx >= projectiles.length) {
        setTimeout(() => {
          applyPostTurnSnapshot(result);
          if (onComplete) onComplete();
        }, 680);
        return;
      }

      const proj = projectiles[projIdx++];
      const pts = proj.points || [];
      if (pts.length === 0) {
        runNextProjectile();
        return;
      }

      const wpnId = result.weaponId || 'normal';
      playCannonFireSound(wpnId);
      startShellFlightSound(wpnId, pts.length);
      app.camera.mode = 'followShell';
      updateFloatingRecenterBtn();

      // Weapon-specific Muzzle Flash Particles
      const startPt = pts[0];
      const muzzleColor =
        wpnId === 'teleport'
          ? '#67e8f9'
          : wpnId === 'power'
          ? '#fde047'
          : wpnId === 'double'
          ? '#fb923c'
          : '#e2e8f0';
      for (let i = 0; i < 12; i++) {
        app.particles.push({
          x: startPt.x,
          y: startPt.y,
          vx: (Math.random() * 2 - 1) * 85,
          vy: (Math.random() * 2 - 1) * 85,
          r: 2.8 + Math.random() * 3.2,
          color: i % 2 === 0 ? muzzleColor : '#ffffff',
          life: 0.36,
          maxLife: 0.36,
          gravity: -20
        });
      }

      const initAng =
        pts.length > 1 ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : 0;

      app.activeShell = {
        points: pts,
        cursor: 0,
        weaponId: wpnId,
        shotNumber: projIdx,
        head: { x: startPt.x, y: startPt.y, angle: initAng },
        trail: [{ x: startPt.x, y: startPt.y, angle: initAng }],
        onImpact: () => {
          stopShellFlightSound();
          app.activeShell = null;

          // Carve crater right at the exact impact moment!
          if (proj.craterRadius > 0) {
            Engine.carveCrater(app.renderMatch.terrain, proj.hitX, proj.hitY, proj.craterRadius);
            // Settle tanks visually onto newly carved crater
            for (const p of app.renderMatch.players) {
              if (!p.alive) continue;
              p.y = Engine.getTerrainY(app.renderMatch.terrain, p.x);
            }
          }

          if (wpnId === 'teleport') {
            spawnExplosionVisual(proj.hitX, proj.hitY, 36, 'teleport');
            if (shooter && proj.hitType !== 'water' && proj.hitType !== 'out') {
              shooter.x = Engine.clamp(proj.hitX, 45, Engine.WORLD_WIDTH - 45);
              shooter.y = Engine.getTerrainY(app.renderMatch.terrain, shooter.x);
            }
          } else if (proj.hitType === 'water') {
            playWaterSplashSound();
            app.floatingTexts.push({
              x: proj.hitX,
              y: Engine.WATER_LEVEL - 18,
              text: '💦 풍덩!',
              color: '#7dd3fc',
              age: 0,
              dur: 1.0
            });
          } else if (proj.hitType !== 'out') {
            spawnExplosionVisual(proj.hitX, proj.hitY, proj.craterRadius || 42, wpnId);
          }

          // Show floating damage numbers for this projectile
          if (proj.damages && proj.damages.length > 0) {
            for (const d of proj.damages) {
              const victim = app.renderMatch.players.find((p) => p.id === d.playerId);
              if (victim && !d.sank) {
                victim.hp = Math.max(0, victim.hp - d.damage);
                if (d.killed) victim.alive = false;
              } else if (victim && d.sank) {
                victim.hp = 0;
                victim.alive = false;
              }
              app.floatingTexts.push({
                x: d.x,
                y: d.y - 16,
                text: d.sank ? '🌊 수장 격파!' : d.killed ? `💥 -${d.damage} 격파!` : `-${d.damage}`,
                color: d.killed ? '#fbbf24' : '#f87171',
                age: 0,
                dur: 1.45
              });
            }
          }

          // Practice mode target hit feedback
          if (result.practiceHits && result.practiceHits.length > 0 && projIdx === 1) {
            for (const ph of result.practiceHits) {
              spawnExplosionVisual(ph.x, ph.y, 44, false);
              app.floatingTexts.push({
                x: ph.x,
                y: ph.y - 24,
                text: '🎯 명중! +100점',
                color: '#fde047',
                age: 0,
                dur: 1.5
              });
            }
          }

          syncPlayersStripUI();
          setTimeout(runNextProjectile, projectiles.length > 1 ? 320 : 120);
        }
      };
    }

    runNextProjectile();
  }

  function applyPostTurnSnapshot(result) {
    if (!app.renderMatch) return;
    if (result.playersSnapshot) {
      app.renderMatch.players = JSON.parse(JSON.stringify(result.playersSnapshot));
    }
    if (typeof result.wind === 'number') app.renderMatch.wind = result.wind;
    if (typeof result.turnIndex === 'number') app.renderMatch.turnIndex = result.turnIndex;
    if (typeof result.turnNumber === 'number') app.renderMatch.turnNumber = result.turnNumber;
    if (result.status) app.renderMatch.status = result.status;
    if ('winnerId' in result) app.renderMatch.winnerId = result.winnerId;
    if (typeof result.practiceScore === 'number') app.renderMatch.practiceScore = result.practiceScore;
    if (result.practiceTargets) {
      app.renderMatch.practiceTargets = JSON.parse(JSON.stringify(result.practiceTargets));
    }

    app.isAnimatingTurn = false;
    syncAllBattleHud();
  }

  // ==========================================
  // Match Completion & Result Modal
  // ==========================================
  function handleSingleMatchFinished() {
    clearTurnCountdown();
    clearAiTimer();
    if (!app.localEngineMatch) return;

    const match = app.localEngineMatch;
    const sorted = [...match.players].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.deathOrder !== b.deathOrder) return b.deathOrder - a.deathOrder;
      return b.damageDealt - a.damageDealt;
    });

    const rankings = sorted.map((p, i) => ({
      rank: i + 1,
      id: p.id,
      nickname: p.nickname,
      badge: p.badge,
      damageDealt: p.damageDealt,
      kills: p.kills,
      alive: p.alive
    }));

    let outcome = 'draw';
    let titleText = '🤝 무승부!';
    let subText = '동시에 모든 탱크가 파괴되었습니다.';
    let customBadgeText = null;
    let customRematchText = null;

    if (app.singleSubMode === 'local') {
      app.lastSingleAiOutcome = null;
      const winner = match.players.find((p) => p.id === match.winnerId);
      outcome = winner ? 'win' : 'draw';
      titleText = winner ? `🏆 ${winner.nickname} 최종 승리!` : '🤝 무승부!';
      subText = `${match.players.length}인 로컬 교대 대전 종료`;
    } else {
      const maxLv = Engine.MAX_AI_LEVEL || 30;
      const curLv = Engine.clamp(Math.round(Number(app.aiLevel) || 1), 1, maxLv);
      if (!match.winnerId) {
        outcome = 'draw';
        app.stats.draws += 1;
        app.lastSingleAiOutcome = 'draw';
        customBadgeText = `DRAW · LV.${curLv} / ${maxLv}`;
        titleText = `🤝 ${curLv}레벨 무승부!`;
        subText = `아쉽게 동시 파괴되었습니다. ${curLv}레벨을 다시 도전하거나 게임에서 나갈 수 있습니다.`;
        customRematchText = `🔄 ${curLv}레벨 다시 하기`;
      } else if (match.winnerId === app.myClientId) {
        outcome = 'win';
        app.stats.wins += 1;
        app.lastSingleAiOutcome = 'win';
        if (curLv < maxLv) {
          const nextSpec = Engine.getAiLevelSpec ? Engine.getAiLevelSpec(curLv + 1) : { tierName: 'AI' };
          customBadgeText = `STAGE CLEAR · LV.${curLv} / ${maxLv}`;
          titleText = `🏆 ${curLv}레벨 클리어!`;
          subText = `AI ${app.aiCount}기를 격파했습니다! 다음 단계(${curLv + 1}레벨 · ${nextSpec.tierName})로 진격하세요!`;
          customRematchText = `▶️ 다음 레벨 (${curLv + 1}레벨) 진격!`;
        } else {
          customBadgeText = `ALL CLEAR · LV.${maxLv} MASTER`;
          titleText = `👑 ${maxLv}레벨 최종 제패!`;
          subText = `축하합니다! 1레벨부터 ${maxLv}레벨까지 모든 AI 전장을 완벽히 정복했습니다!`;
          customRematchText = `🔄 1레벨부터 다시 도전`;
        }
      } else {
        outcome = 'lose';
        app.stats.losses += 1;
        app.lastSingleAiOutcome = 'lose';
        const winAi = match.players.find((p) => p.id === match.winnerId);
        customBadgeText = `DEFEAT · LV.${curLv} / ${maxLv}`;
        titleText = `💔 ${curLv}레벨 돌파 실패...`;
        subText = `${winAi ? winAi.nickname : 'AI'}에게 패배했습니다. ${curLv}레벨을 다시 하거나 게임에서 나갈 수 있습니다.`;
        customRematchText = `🔄 ${curLv}레벨 다시 하기`;
      }
      saveProfile();
    }

    openResultModal(outcome, titleText, subText, rankings, customBadgeText, customRematchText);
  }

  function openResultModal(outcome, titleText, subText, rankings, customBadgeText, customRematchText) {
    playFanfareSound(outcome);
    const modal = document.getElementById('gameover-modal');
    const badge = document.getElementById('modal-result-badge');
    const title = document.getElementById('modal-result-title');
    const sub = document.getElementById('modal-result-sub');
    const list = document.getElementById('modal-ranking-list');
    const rematchBtn = document.getElementById('btn-modal-rematch');
    const exitBtn = document.getElementById('btn-modal-exit');

    badge.className = `result-badge ${outcome}`;
    badge.textContent =
      customBadgeText || (outcome === 'win' ? 'VICTORY' : outcome === 'lose' ? 'DEFEAT' : 'DRAW');
    title.textContent = titleText;
    sub.textContent = subText;

    if (rematchBtn) {
      if (customRematchText) {
        rematchBtn.textContent = customRematchText;
      } else {
        rematchBtn.textContent = app.mode === 'multi' ? '🔄 대기방으로 (재경기)' : '🔄 새 맵에서 다시하기';
      }
    }
    if (exitBtn) {
      exitBtn.textContent = '🚪 게임 나가기';
    }

    list.innerHTML = '';
    (rankings || []).forEach((r) => {
      const row = document.createElement('div');
      row.className = `rank-row ${r.rank === 1 ? 'first' : ''}`;
      const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '4위';
      row.innerHTML = `
        <span><strong>${medal} ${escapeHtml(r.nickname)}</strong></span>
        <span class="rank-meta">격파 ${r.kills} · 딜량 ${r.damageDealt}</span>
      `;
      list.appendChild(row);
    });

    modal.classList.remove('hidden');
  }

  // ==========================================
  // HUD Sync Functions
  // ==========================================
  function syncAllBattleHud() {
    syncTopTurnAndWindUI();
    syncPlayersStripUI();
    syncControlDeckUI();
  }

  function syncTopTurnAndWindUI() {
    if (!app.renderMatch) return;
    const active = getActivePlayer();
    const dotEl = document.getElementById('turn-badge-dot');
    const nameEl = document.getElementById('turn-player-name');
    const lvBadge = document.getElementById('battle-level-badge');

    if (lvBadge) {
      const showLv =
        app.mode === 'single' && app.singleSubMode === 'ai' && !app.renderMatch.isPractice;
      if (showLv) {
        const maxLv = Engine.MAX_AI_LEVEL || 30;
        const curLv = Engine.clamp(Math.round(Number(app.aiLevel) || 1), 1, maxLv);
        const aiSpec = Engine.getAiLevelSpec ? Engine.getAiLevelSpec(curLv) : { tierName: 'AI' };
        lvBadge.textContent = `LV.${curLv}/${maxLv} · ${aiSpec.tierName}`;
        lvBadge.classList.remove('hidden');
      } else {
        lvBadge.classList.add('hidden');
      }
    }

    if (active) {
      if (dotEl) dotEl.textContent = active.badge || '🔵';
      if (nameEl) {
        if (app.renderMatch.isPractice) {
          nameEl.textContent = '영점 연습';
        } else if (app.mode === 'multi') {
          nameEl.textContent = active.id === app.myClientId ? '내 턴!' : `${active.nickname} 턴`;
        } else if (app.singleSubMode === 'ai') {
          nameEl.textContent = active.isAi ? `${active.nickname} 턴` : '내 턴!';
        } else {
          nameEl.textContent = `${active.nickname} 턴`;
        }
      }
    }

    // Wind Meter
    const w = app.renderMatch.wind || 0;
    const leftBar = document.getElementById('wind-fill-left');
    const rightBar = document.getElementById('wind-fill-right');
    const valTxt = document.getElementById('wind-value-text');
    const pct = Math.min(100, Math.round((Math.abs(w) / Engine.MAX_WIND) * 100));

    if (leftBar) leftBar.style.width = w < 0 ? `${pct}%` : '0%';
    if (rightBar) rightBar.style.width = w > 0 ? `${pct}%` : '0%';
    if (valTxt) {
      if (w === 0) valTxt.textContent = '무풍 0';
      else if (w < 0) valTxt.textContent = `◀ ${Math.abs(w)}`;
      else valTxt.textContent = `${w} ▶`;
    }
  }

  function syncPlayersStripUI() {
    const strip = document.getElementById('hud-players-strip');
    if (!strip || !app.renderMatch) return;

    const isLocalPass = app.mode === 'single' && app.singleSubMode === 'local';
    const myPlayer = !isLocalPass
      ? app.renderMatch.players.find((p) => p.id === app.myClientId) || app.renderMatch.players[0]
      : null;
    const myRef = myPlayer || getActivePlayer();

    // Order cards so MY HP is always shown first (left/top), followed by opponents' HP!
    const entries = app.renderMatch.players.map((p, idx) => ({ p, idx }));
    if (myPlayer) {
      entries.sort((a, b) => {
        const aMe = a.p.id === myPlayer.id ? 0 : 1;
        const bMe = b.p.id === myPlayer.id ? 0 : 1;
        return aMe !== bMe ? aMe - bMe : a.idx - b.idx;
      });
    }

    strip.setAttribute('data-count', String(entries.length));
    strip.innerHTML = '';

    entries.forEach(({ p, idx }) => {
      const card = document.createElement('button');
      card.type = 'button';
      const isMe = Boolean(myPlayer && p.id === myPlayer.id);
      const isTurn = idx === app.renderMatch.turnIndex && app.renderMatch.status === 'playing';
      const sideCls = isLocalPass ? 'is-local' : isMe ? 'is-me' : 'is-enemy';

      card.className = `p-hud-card ${sideCls} ${isTurn ? 'active-turn' : ''} ${!p.alive ? 'dead' : ''}`;

      const curHp = Math.max(0, Math.round(p.hp));
      const maxHp = Math.max(1, Math.round(p.maxHp || 100));
      const hpPct = p.alive ? Engine.clamp(Math.round((curHp / maxHp) * 100), 0, 100) : 0;

      const hpBarGrad =
        hpPct > 55
          ? 'linear-gradient(90deg, #16a34a, #4ade80)'
          : hpPct > 28
          ? 'linear-gradient(90deg, #d97706, #fde047)'
          : 'linear-gradient(90deg, #dc2626, #fb7185)';

      const hpTextColor = !p.alive
        ? '#fca5a5'
        : hpPct > 55
        ? '#4ade80'
        : hpPct > 28
        ? '#fde047'
        : '#fda4af';

      let roleLabel = '상대';
      let roleCls = 'role-enemy';
      if (app.renderMatch.isPractice) {
        roleLabel = '내 탱크';
        roleCls = 'role-me';
      } else if (isLocalPass) {
        roleLabel = `${idx + 1}P`;
        roleCls = 'role-local';
      } else if (isMe) {
        roleLabel = '나';
        roleCls = 'role-me';
      }

      let subMetaHtml = '';
      if (app.renderMatch.isPractice && isMe) {
        subMetaHtml = `<span class="p-hud-dist">🎯 ${app.renderMatch.practiceScore || 0}점</span>`;
      } else if (myRef && myRef.id !== p.id && p.alive) {
        subMetaHtml = `<span class="p-hud-dist">${Math.round(Math.abs(p.x - myRef.x))}m</span>`;
      }

      card.innerHTML = `
        <div class="p-hud-top">
          <div class="p-hud-ident">
            <span class="p-role-badge ${roleCls}">${roleLabel}</span>
            <span class="p-color-dot" style="background:${p.color};"></span>
            <span class="p-hud-name">${escapeHtml(p.nickname)}</span>
            ${isTurn ? '<span class="p-turn-tag">턴</span>' : ''}
          </div>
          <div class="p-hud-nums">
            ${subMetaHtml}
            <span class="p-hud-hpval" style="color:${hpTextColor};">
              ${p.alive ? `HP <strong>${curHp}</strong><small>/${maxHp}</small>` : '격파 💀'}
            </span>
          </div>
        </div>
        <div class="p-hud-hpbar">
          <div class="p-hud-hpfill" style="width:${hpPct}%;background:${hpBarGrad};"></div>
        </div>
      `;

      card.addEventListener('click', () => {
        if (app.isAnimatingTurn) return;
        app.camera.mode = 'manual';
        centerCameraOnWorldX(p.x, false);
        updateFloatingRecenterBtn();
        if (myRef && myRef.id !== p.id) {
          const dx = Math.round(Math.abs(p.x - myRef.x));
          showToast(`🔭 ${p.nickname} (HP ${curHp}/${maxHp}) — 거리 약 ${dx}m`, 1900);
        } else {
          focusActiveTank(false);
        }
      });

      strip.appendChild(card);
    });
  }

  function syncControlDeckUI() {
    const deck = document.getElementById('control-deck');
    const active = getActivePlayer();
    if (!deck || !active) return;

    // Show my own tank stats when waiting in multiplayer, or active controllable player on my turn
    const myTank =
      app.mode === 'multi'
        ? app.renderMatch.players.find((p) => p.id === app.myClientId) || active
        : active;

    const canAct = isMyControllableTurn();
    deck.classList.toggle('disabled-turn', !canAct);

    const fireBtn = document.getElementById('btn-fire');
    if (fireBtn) {
      fireBtn.disabled = !canAct;
      const isHeal = myTank.selectedWeapon === 'heal';
      fireBtn.querySelector('.fire-ico').textContent = isHeal ? '🔧' : '🔥';
      fireBtn.querySelector('.fire-txt').textContent = isHeal ? '수리!' : '발사!';
    }

    const lblFacing = document.getElementById('lbl-facing');
    if (lblFacing) lblFacing.textContent = myTank.facing < 0 ? '◀ 좌' : '우 ▶';

    const lblFuel = document.getElementById('lbl-fuel');
    const fuelFill = document.getElementById('fuel-bar-fill');
    if (lblFuel) lblFuel.textContent = String(Math.round(myTank.fuel));
    if (fuelFill) {
      fuelFill.style.width = `${Math.max(0, Math.min(100, (myTank.fuel / myTank.maxFuel) * 100))}%`;
    }

    const lblAngle = document.getElementById('lbl-angle');
    if (lblAngle) lblAngle.textContent = `${myTank.angle}°`;

    const lblPower = document.getElementById('lbl-power');
    const pFill = document.getElementById('power-gauge-fill');
    const pThumb = document.getElementById('power-thumb');
    const pLast = document.getElementById('power-last-marker');

    const pct = ((myTank.power - 10) / 90) * 100;
    if (lblPower) lblPower.textContent = String(Math.round(myTank.power));
    if (pFill) pFill.style.width = `${pct}%`;
    if (pThumb) pThumb.style.left = `${pct}%`;

    if (pLast) {
      if (typeof myTank.lastPower === 'number') {
        const lastPct = ((myTank.lastPower - 10) / 90) * 100;
        pLast.style.left = `${lastPct}%`;
        pLast.classList.remove('hidden');
      } else {
        pLast.classList.add('hidden');
      }
    }

    // Weapon buttons & ammo counts
    document.querySelectorAll('.wpn-btn').forEach((btn) => {
      const wId = btn.getAttribute('data-wpn');
      const count = myTank.ammo ? myTank.ammo[wId] : 0;
      const cntEl = document.getElementById(`ammo-${wId}`);
      if (cntEl) cntEl.textContent = wId === 'normal' ? '∞' : String(Math.max(0, count));

      btn.classList.toggle('active', myTank.selectedWeapon === wId);
      btn.classList.toggle('empty-ammo', wId !== 'normal' && count <= 0);
    });
  }

  // ==========================================
  // Main 60FPS Render & Animation Loop
  // ==========================================
  let prevFrameTime = performance.now();

  function frameLoop(now) {
    const dt = Math.min(0.05, (now - prevFrameTime) / 1000);
    prevFrameTime = now;

    if (app.screen === 'game' && app.renderMatch) {
      updateSimulationVisuals(dt);
      renderBattlefield(now);
      renderMinimap();
    }

    requestAnimationFrame(frameLoop);
  }

  function updateSimulationVisuals(dt) {
    // Spacebar Hold-to-Charge sweep
    if (app.spaceCharging && isMyControllableTurn()) {
      const active = getActivePlayer();
      if (active) {
        active.power = Engine.clamp(active.power + 68 * dt, 10, 100);
        const rounded = Math.round(active.power);
        if (app.mode === 'single' && app.localEngineMatch) {
          app.localEngineMatch.players[app.localEngineMatch.turnIndex].power = rounded;
        }
        syncControlDeckUI();
      }
    }

    // Flying Projectile Playback (Sub-frame interpolated position + tangent velocity orientation)
    if (app.activeShell) {
      const sh = app.activeShell;
      sh.cursor += dt * 46;
      const maxIdx = sh.points.length - 1;
      const clampedCursor = Math.min(maxIdx, sh.cursor);
      const idx = Math.floor(clampedCursor);
      const nextIdx = Math.min(maxIdx, idx + 1);
      const frac = clampedCursor - idx;

      const p0 = sh.points[idx];
      const p1 = sh.points[nextIdx];
      const curX = p0.x + (p1.x - p0.x) * frac;
      const curY = p0.y + (p1.y - p0.y) * frac;

      const angA = sh.points[Math.max(0, idx - 1)];
      const angB = sh.points[Math.min(maxIdx, idx + 1)];
      const dAngX = angB.x - angA.x;
      const dAngY = angB.y - angA.y;
      const curAngle =
        Math.abs(dAngX) + Math.abs(dAngY) > 0.01
          ? Math.atan2(dAngY, dAngX)
          : sh.head
          ? sh.head.angle
          : 0;

      sh.head = { x: curX, y: curY, angle: curAngle };
      sh.trail.push({ x: curX, y: curY, angle: curAngle });
      if (sh.trail.length > 30) sh.trail.shift();

      // Smooth horizontal camera scroll following projectile!
      if (app.camera.mode === 'followShell') {
        centerCameraOnWorldX(curX, false);
      }

      if (sh.cursor >= maxIdx) {
        const cb = sh.onImpact;
        if (cb) cb();
      }
    } else if (app.camera.mode === 'followTank') {
      const active = getActivePlayer();
      if (active) {
        centerCameraOnWorldX(active.x, false);
      }
    }

    // Smooth Horizontal Camera Interpolation
    const lerpSpeed = app.camera.mode === 'followShell' ? 11.5 : 7.5;
    app.camera.x += (app.camera.targetX - app.camera.x) * Math.min(1, lerpSpeed * dt);
    clampCamera();

    if (app.camera.shake > 0.1) {
      app.camera.shake *= Math.pow(0.04, dt);
    } else {
      app.camera.shake = 0;
    }

    // Wind flakes drift
    const windSpeedX = (app.renderMatch.wind || 0) * 18;
    for (const wf of app.windFlakes) {
      wf.x += windSpeedX * dt;
      wf.y += wf.vy * dt;
      if (wf.x < 0) wf.x += Engine.WORLD_WIDTH;
      if (wf.x > Engine.WORLD_WIDTH) wf.x -= Engine.WORLD_WIDTH;
      if (wf.y > Engine.WATER_LEVEL - 20) {
        wf.y = 20;
        wf.x = Math.random() * Engine.WORLD_WIDTH;
      }
    }

    // Explosions
    for (let i = app.explosions.length - 1; i >= 0; i--) {
      app.explosions[i].age += dt;
      if (app.explosions[i].age >= app.explosions[i].dur) {
        app.explosions.splice(i, 1);
      }
    }

    // Debris & Spark Particles
    for (let i = app.particles.length - 1; i >= 0; i--) {
      const p = app.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        app.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // Floating Damage / Heal Popups
    for (let i = app.floatingTexts.length - 1; i >= 0; i--) {
      const ft = app.floatingTexts[i];
      ft.age += dt;
      ft.y -= 28 * dt;
      if (ft.age >= ft.dur) {
        app.floatingTexts.splice(i, 1);
      }
    }
  }

  function renderBattlefield(nowMs) {
    const match = app.renderMatch;
    if (!match) return;
    const theme = Engine.MAP_THEMES[match.mapType] || Engine.MAP_THEMES.hills;

    ctx.save();
    ctx.scale(viewDpr, viewDpr);

    // 1. Sky Gradient (Full Viewport)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, viewCssH);
    skyGrad.addColorStop(0, theme.skyTop);
    skyGrad.addColorStop(0.55, theme.skyMid);
    skyGrad.addColorStop(1, theme.skyBot);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, viewCssW, viewCssH);

    const scale = getWorldScale();
    const visWorldW = viewCssW / scale;

    // Center world horizontally if ultrawide monitor is wider than WORLD_WIDTH
    let extraMarginPx = 0;
    if (visWorldW > Engine.WORLD_WIDTH) {
      extraMarginPx = (viewCssW - Engine.WORLD_WIDTH * scale) * 0.5;
    }

    const shakeX = app.camera.shake ? (Math.random() * 2 - 1) * app.camera.shake : 0;
    const shakeY = app.camera.shake ? (Math.random() * 2 - 1) * app.camera.shake : 0;

    // 2. Parallax Distant Background Ridges
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.36)';
    ctx.beginPath();
    ctx.moveTo(0, viewCssH);
    for (let sx = 0; sx <= viewCssW + 24; sx += 24) {
      const wx = sx / scale + app.camera.x * 0.35;
      const py =
        (540 + Math.sin(wx * 0.0028) * 95 + Math.cos(wx * 0.0065) * 45) * scale;
      ctx.lineTo(sx, py);
    }
    ctx.lineTo(viewCssW, viewCssH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Enter World Coordinate Space (Fixed Vertical Height = 0..900!)
    ctx.save();
    ctx.translate(extraMarginPx + shakeX, shakeY);
    ctx.scale(scale, scale);
    ctx.translate(-app.camera.x, 0);

    const xStart = Math.max(0, Math.floor(app.camera.x - 20));
    const xEnd = Math.min(Engine.WORLD_WIDTH, Math.ceil(app.camera.x + visWorldW + 20));

    // 3. Wind Particles in Sky
    ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
    for (const wf of app.windFlakes) {
      if (wf.x < xStart || wf.x > xEnd) continue;
      ctx.beginPath();
      ctx.arc(wf.x, wf.y, wf.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Deep Water Back Layer
    ctx.fillStyle = theme.water;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(xStart, Engine.WATER_LEVEL, xEnd - xStart, Engine.WORLD_HEIGHT - Engine.WATER_LEVEL);
    ctx.globalAlpha = 1;

    // 5. Destructible Terrain Polygon + Top Crust
    const terrain = match.terrain;
    const soilGrad = ctx.createLinearGradient(0, 260, 0, Engine.WORLD_HEIGHT);
    soilGrad.addColorStop(0, theme.soilTop);
    soilGrad.addColorStop(1, theme.soilBot);

    ctx.beginPath();
    ctx.moveTo(xStart, Engine.WORLD_HEIGHT);
    for (let x = xStart; x <= xEnd; x += 2) {
      ctx.lineTo(x, terrain[x]);
    }
    ctx.lineTo(xEnd, terrain[xEnd]);
    ctx.lineTo(xEnd, Engine.WORLD_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = soilGrad;
    ctx.fill();

    // Top Crust Stroke (Grass / Snow / Sand / Rock)
    ctx.beginPath();
    for (let x = xStart; x <= xEnd; x += 2) {
      if (x === xStart) ctx.moveTo(x, terrain[x] + 5);
      else ctx.lineTo(x, terrain[x] + 5);
    }
    ctx.strokeStyle = theme.crustSub;
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.beginPath();
    for (let x = xStart; x <= xEnd; x += 2) {
      if (x === xStart) ctx.moveTo(x, terrain[x] + 1);
      else ctx.lineTo(x, terrain[x] + 1);
    }
    ctx.strokeStyle = theme.crust;
    ctx.lineWidth = 5;
    ctx.stroke();

    // 6. Practice Targets (if 1P Practice Mode)
    if (match.isPractice && match.practiceTargets) {
      for (const tgt of match.practiceTargets) {
        drawPracticeBullseye(ctx, tgt, nowMs);
      }
    }

    // 7. Alive Tanks + Aiming Reticle
    const activePlayer = getActivePlayer();
    for (let i = 0; i < match.players.length; i++) {
      const p = match.players[i];
      if (!p.alive) continue;
      const isTurn = i === match.turnIndex && match.status === 'playing';
      drawTank(ctx, p, terrain, isTurn, nowMs);
    }

    // 8. Active Flying Projectile + Weapon-Specific Trail (Distinct Silhouette per Shell Type!)
    if (app.activeShell && app.activeShell.trail.length > 0) {
      drawActiveProjectile(ctx, app.activeShell, nowMs);
    }

    // 9. Explosion Shockwaves & Particles
    for (const ex of app.explosions) {
      const t = ex.age / ex.dur;
      const r = ex.maxR * Math.pow(t, 0.45);
      const alpha = Math.max(0, 1 - t);
      const grad = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);

      if (ex.kind === 'teleport') {
        grad.addColorStop(0, `rgba(236, 254, 255, ${alpha})`);
        grad.addColorStop(0.45, `rgba(34, 211, 238, ${alpha * 0.85})`);
        grad.addColorStop(0.8, `rgba(168, 85, 247, ${alpha * 0.55})`);
        grad.addColorStop(1, 'rgba(139, 92, 246, 0)');
      } else if (ex.kind === 'power') {
        grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        grad.addColorStop(0.35, `rgba(254, 240, 138, ${alpha * 0.95})`);
        grad.addColorStop(0.68, `rgba(239, 68, 68, ${alpha * 0.85})`);
        grad.addColorStop(1, 'rgba(153, 27, 27, 0)');
      } else {
        grad.addColorStop(0, `rgba(254, 249, 195, ${alpha})`);
        grad.addColorStop(0.5, `rgba(249, 115, 22, ${alpha * 0.8})`);
        grad.addColorStop(1, 'rgba(239, 68, 68, 0)');
      }

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Expanding crisp outer shockwave ring for Power Bomb & Teleport Warp
      if (ex.kind === 'power' || ex.kind === 'teleport') {
        ctx.save();
        ctx.strokeStyle =
          ex.kind === 'teleport'
            ? `rgba(103, 232, 249, ${alpha * 0.9})`
            : `rgba(254, 240, 138, ${alpha * 0.9})`;
        ctx.lineWidth = ex.kind === 'power' ? 4 : 2.8;
        ctx.beginPath();
        ctx.arc(ex.x, ex.y, r * 1.14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    for (const pt of app.particles) {
      ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 10. Foreground Animated Water Surface Waves
    ctx.beginPath();
    ctx.moveTo(xStart, Engine.WORLD_HEIGHT);
    for (let x = xStart; x <= xEnd; x += 18) {
      const waveY = Engine.WATER_LEVEL + Math.sin(x * 0.03 + nowMs * 0.004) * 3.5;
      ctx.lineTo(x, waveY);
    }
    ctx.lineTo(xEnd, Engine.WORLD_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = theme.water;
    ctx.globalAlpha = 0.72;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 11. Floating Damage / Heal Popups (clamped horizontally inside screen bounds so text never clips)
    ctx.textAlign = 'center';
    const popupFontPx = isSmartphoneScreen() ? Math.round(Engine.clamp(14 / Math.max(0.24, scale), 20, 36)) : 22;
    ctx.font = `900 ${popupFontPx}px Pretendard, Malgun Gothic, sans-serif`;
    for (const ft of app.floatingTexts) {
      const alpha = Math.max(0, 1 - ft.age / ft.dur);
      ctx.globalAlpha = alpha;
      const halfTxtW = ctx.measureText(ft.text).width * 0.5 + 8;
      const minPopupX = Math.max(halfTxtW, app.camera.x + halfTxtW);
      const maxPopupX = Math.min(Engine.WORLD_WIDTH - halfTxtW, app.camera.x + visWorldW - halfTxtW);
      const drawPopupX = maxPopupX >= minPopupX ? Engine.clamp(ft.x, minPopupX, maxPopupX) : ft.x;
      ctx.lineWidth = isSmartphoneScreen() ? 4.5 : 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.88)';
      ctx.strokeText(ft.text, drawPopupX, ft.y);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, drawPopupX, ft.y);
    }
    ctx.globalAlpha = 1;

    ctx.restore(); // Exit World Space

    // 12. Off-Screen Opponent Edge Pointers (crucial for Smartphone Horizontal Scroll!)
    drawOffscreenEnemyPointers(ctx, match, activePlayer, scale, extraMarginPx);

    ctx.restore();
  }

  // Distinct Flying Projectile & Trail Renderer per Shell Type ('normal' | 'double' | 'power' | 'teleport')
  function drawActiveProjectile(ctx, sh, nowMs) {
    const trail = sh.trail;
    const head = sh.head || trail[trail.length - 1];
    if (!head) return;

    const wpn = sh.weaponId || 'normal';
    const pScale = isSmartphoneScreen()
      ? Engine.clamp(getMobileTankBoost() * 0.86, 1.28, 1.58)
      : 1.15;

    ctx.save();

    // ==========================================
    // 1. WEAPON-SPECIFIC FLIGHT TRAIL
    // ==========================================
    if (wpn === 'teleport') {
      // Teleport Orb Trail: Alternating Neon Cyan & Electric Violet Dimensional Portal Rings!
      for (let i = 0; i < trail.length; i += 2) {
        const pt = trail[i];
        const ratio = (i + 1) / trail.length;
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate((pt.angle || 0) + i * 0.35);
        ctx.strokeStyle =
          i % 4 === 0
            ? `rgba(34, 211, 238, ${ratio * 0.82})`
            : `rgba(192, 132, 252, ${ratio * 0.78})`;
        ctx.lineWidth = (1.4 + ratio * 1.4) * pScale * 0.8;
        ctx.beginPath();
        ctx.ellipse(0, 0, (2.5 + ratio * 6.5) * pScale * 0.85, (1.4 + ratio * 3.8) * pScale * 0.85, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    } else if (wpn === 'power') {
      // Heavy High-Explosive Nuke Trail: Thick Dark Charcoal Smoke + Expanding Fiery Magma Shock Rings!
      for (let i = 0; i < trail.length; i++) {
        const pt = trail[i];
        const ratio = (i + 1) / trail.length;
        ctx.fillStyle =
          ratio > 0.68
            ? `rgba(239, 68, 68, ${ratio * 0.65})`
            : `rgba(30, 41, 59, ${ratio * 0.58})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (3.2 + (1 - ratio) * 5.5) * pScale * 0.85, 0, Math.PI * 2);
        ctx.fill();

        if (i % 5 === 0) {
          ctx.strokeStyle = `rgba(250, 204, 21, ${ratio * 0.72})`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, (5 + (1 - ratio) * 7) * pScale * 0.82, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    } else if (wpn === 'double') {
      // Double-Shot Rocket Trail: Crisp Twin Parallel Supersonic Jet Contrails!
      const offset = 3.4 * pScale;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i];
          const nx = -Math.sin(pt.angle || 0) * offset * side;
          const ny = Math.cos(pt.angle || 0) * offset * side;
          if (i === 0) ctx.moveTo(pt.x + nx, pt.y + ny);
          else ctx.lineTo(pt.x + nx, pt.y + ny);
        }
        ctx.strokeStyle = side < 0 ? 'rgba(56, 189, 248, 0.78)' : 'rgba(251, 146, 60, 0.82)';
        ctx.lineWidth = 2.4 * pScale * 0.85;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      // Bright inner jet sparks
      for (let i = Math.max(0, trail.length - 10); i < trail.length; i += 2) {
        const pt = trail[i];
        const ratio = (i + 1) / trail.length;
        ctx.fillStyle = `rgba(254, 240, 138, ${ratio * 0.8})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.2 * pScale * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Normal Cannon Shell Trail: Classic Artillery White-Gray Propellant Smoke Puffs
      for (let i = 0; i < trail.length; i++) {
        const pt = trail[i];
        const ratio = (i + 1) / trail.length;
        ctx.fillStyle =
          ratio > 0.78
            ? `rgba(251, 191, 36, ${ratio * 0.62})`
            : `rgba(226, 232, 240, ${ratio * 0.5})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (1.8 + ratio * 3.8) * pScale * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ==========================================
    // 2. WEAPON-SPECIFIC PROJECTILE HEAD BODY
    // ==========================================
    ctx.translate(head.x, head.y);

    if (wpn === 'teleport') {
      // === TELEPORT ORB: Spinning Dual-Ring Dimensional Warp Gyroscope ===
      ctx.scale(pScale, pScale);
      const spin = (nowMs || 0) * 0.011;

      // Outer warp glow
      const aura = ctx.createRadialGradient(0, 0, 1, 0, 0, 15);
      aura.addColorStop(0, 'rgba(236, 254, 255, 0.95)');
      aura.addColorStop(0.5, 'rgba(34, 211, 238, 0.55)');
      aura.addColorStop(1, 'rgba(168, 85, 247, 0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();

      // Tilted Orbital Ring 1 (Neon Cyan)
      ctx.save();
      ctx.rotate(spin);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, 12.5, 4.8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Counter-Rotating Orbital Ring 2 (Electric Violet)
      ctx.save();
      ctx.rotate(-spin * 1.25 + Math.PI * 0.38);
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, 12.5, 4.8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Spinning 4-point Star / Quantum Diamond Core
      ctx.save();
      ctx.rotate(spin * 1.8);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#0891b2';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -6.5);
      ctx.lineTo(4.2, 0);
      ctx.lineTo(0, 6.5);
      ctx.lineTo(-4.2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else if (wpn === 'power') {
      // === HIGH-EXPLOSIVE POWER BOMB: Giant Bulbous "Fat-Man" Heavy Warhead ===
      ctx.rotate(head.angle || 0);
      ctx.scale(pScale, pScale);

      // Pulsing danger red shock aura
      const pulse = 1 + Math.sin((nowMs || 0) * 0.025) * 0.14;
      ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
      ctx.beginPath();
      ctx.arc(0, 0, 16 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // Rear boxy bomb stabilizer tail assembly
      ctx.fillStyle = '#475569';
      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-16, -8.5);
      ctx.lineTo(-9, -5.5);
      ctx.lineTo(-9, 5.5);
      ctx.lineTo(-16, 8.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Fat armored charcoal warhead body
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.ellipse(0, 0, 12.5, 8.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Vivid Yellow Hazard Warning Band around belly
      ctx.fillStyle = '#facc15';
      ctx.fillRect(-3.5, -8.2, 6.5, 16.4);
      ctx.strokeRect(-3.5, -8.2, 6.5, 16.4);

      // Glowing Red-Hot Armed Nose Fuse
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(10.5, 0, 4.2, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.fill();
      ctx.stroke();

      // Blinking White-Yellow Fuse Tip Spark
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(13.5, 0, 2.2 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // Center Hazard Core Dot
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(-0.2, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (wpn === 'double') {
      // === DOUBLE-SHOT MISSILE: Sleek Winged Supersonic Guided Rocket ===
      ctx.rotate(head.angle || 0);
      ctx.scale(pScale, pScale);

      // Flickering Jet Thruster Flame at Rear Nozzle
      const jetLen = 10 + Math.sin((nowMs || 0) * 0.06) * 4;
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(-11, -3.4);
      ctx.lineTo(-11 - jetLen, 0);
      ctx.lineTo(-11, 3.4);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.moveTo(-11, -1.8);
      ctx.lineTo(-11 - jetLen * 0.62, 0);
      ctx.lineTo(-11, 1.8);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.6;

      // Swept Delta Rear Tail Fins (Top & Bottom)
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.moveTo(-11, -3.5);
      ctx.lineTo(-14, -8.5);
      ctx.lineTo(-5, -3.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-11, 3.5);
      ctx.lineTo(-14, 8.5);
      ctx.lineTo(-5, 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Slender White-Silver Rocket Fuselage
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.roundRect(-11, -3.6, 17, 7.2, 2);
      ctx.fill();
      ctx.stroke();

      // Cyan/Blue Tactical Stripe (1st vs 2nd shot accent)
      ctx.fillStyle = sh.shotNumber === 2 ? '#a855f7' : '#0ea5e9';
      ctx.fillRect(-3, -3.2, 4.5, 6.4);

      // Sharp Pointed Scarlet Nose Cone
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(6, -3.8);
      ctx.lineTo(15.5, 0);
      ctx.lineTo(6, 3.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      // === NORMAL SHELL: Classic Pointed Brass & Gunmetal Artillery Projectile ===
      ctx.rotate(head.angle || 0);
      ctx.scale(pScale, pScale);

      // Subtle hot base tracer glow
      ctx.fillStyle = 'rgba(251, 146, 60, 0.75)';
      ctx.beginPath();
      ctx.arc(-8.5, 0, 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.7;

      // Cylindrical Gunmetal Shell Casing
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.roundRect(-8, -4.2, 9.5, 8.4, 2);
      ctx.fill();
      ctx.stroke();

      // Copper/Gold Driving Band
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(-2, -4.1, 3, 8.2);

      // Pointed Ogive Steel-Gold Warhead Tip
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.moveTo(1.5, -4.2);
      ctx.quadraticCurveTo(8.5, -3.6, 11.5, 0);
      ctx.quadraticCurveTo(8.5, 3.6, 1.5, 4.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawPracticeBullseye(ctx, tgt, nowMs) {
    const bob = Math.sin(nowMs * 0.004 + tgt.slotIdx) * 5;
    const cy = tgt.y + bob;
    const r = tgt.radius;

    ctx.save();
    // Stand pole
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tgt.x, cy + r);
    ctx.lineTo(tgt.x, tgt.y + 30);
    ctx.stroke();

    const rings = [
      { rad: r, col: '#ef4444' },
      { rad: r * 0.68, col: '#ffffff' },
      { rad: r * 0.36, col: '#ef4444' }
    ];
    for (const rg of rings) {
      ctx.fillStyle = rg.col;
      ctx.beginPath();
      ctx.arc(tgt.x, cy, rg.rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Draw distinct barrel per tankType ('cannon' | 'duke' | 'multi' | 'laser')
  function drawTankBarrelByType(ctx, tankType, color, colorLight, nowMs) {
    const len = Engine.BARREL_LENGTH;
    ctx.strokeStyle = '#090d16';
    ctx.lineWidth = 2;

    if (tankType === 'duke') {
      // Heavy Duke: Thick twin siege cannons + hydraulic recoil damper + flared heavy muzzle
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.roundRect(-2, -8.5, 14, 17, 3);
      ctx.fill();
      ctx.stroke();

      // Upper & lower heavy barrels
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.roundRect(6, -7.2, len - 2, 6.2, 2);
      ctx.roundRect(6, 1.0, len - 2, 6.2, 2);
      ctx.fill();
      ctx.stroke();

      // Heavy armored siege muzzle block
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(len - 3, -8.8, 8, 17.6, 2);
      ctx.fill();
      ctx.stroke();
    } else if (tankType === 'multi') {
      // Crater Multi: Wide 3-tube rocket / heavy mortar pod with glowing warhead tips
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.roundRect(0, -8.5, len - 3, 17, 4);
      ctx.fill();
      ctx.stroke();

      // Caution stripe band
      ctx.fillStyle = color;
      ctx.fillRect(6, -7.5, 6, 15);

      // 3 stacked rocket warhead tips peeking out
      const ys = [-5, 0, 5];
      for (const wy of ys) {
        ctx.fillStyle = '#f97316';
        ctx.beginPath();
        ctx.arc(len - 2, wy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (tankType === 'laser') {
      // Speed Laser: Long futuristic twin-prong railgun with glowing energy core
      const longLen = len + 5;
      // Glowing plasma core beam inside rails
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(longLen, 0);
      ctx.stroke();

      // Top & bottom electromagnetic rails
      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.6;
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.roundRect(2, -6, longLen - 2, 3.4, 1.5);
      ctx.roundRect(2, 2.6, longLen - 2, 3.4, 1.5);
      ctx.fill();
      ctx.stroke();

      // Energy coil rings
      ctx.fillStyle = color;
      ctx.fillRect(11, -6.8, 3.5, 13.6);
      ctx.fillRect(20, -6.8, 3.5, 13.6);
    } else {
      // Classic Cannon: Balanced cylindrical steel barrel + classic muzzle brake
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.roundRect(0, -4.5, len, 9, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(len - 6, -6, 7, 12, 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Draw distinct hull, treads/hover-pads, and turret per tankType
  // Drawn in local tank coordinates where (0,0) is ground contact and +X is forward!
  function drawTankBodyByType(ctx, tankType, color, colorDark, colorLight, nowMs) {
    ctx.strokeStyle = '#090d16';
    ctx.lineWidth = 2;

    if (tankType === 'duke') {
      // === HEAVY DUKE (Bulky Siege Tank) ===
      // Rear twin exhaust stacks
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.roundRect(-22, -25, 5, 11, 2);
      ctx.roundRect(-16, -23, 4, 9, 2);
      ctx.fill();
      ctx.stroke();

      // Extra-wide armored caterpillar treads
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.roundRect(-24, -11, 48, 11, 4);
      ctx.fill();
      ctx.stroke();

      // 6 heavy road wheels
      ctx.fillStyle = '#94a3b8';
      for (let wx = -18; wx <= 18; wx += 7.2) {
        ctx.beginPath();
        ctx.arc(wx, -5, 2.7, 0, Math.PI * 2);
        ctx.fill();
      }

      // Armored side skirt plate
      ctx.fillStyle = colorDark || color;
      ctx.beginPath();
      ctx.roundRect(-23, -12, 46, 5, 2);
      ctx.fill();
      ctx.stroke();

      // Tall boxy heavy hull
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-21, -11);
      ctx.lineTo(-19, -20);
      ctx.lineTo(18, -20);
      ctx.lineTo(23, -11);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Front hazard accent
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(14, -18, 4, 5);

      // Angular M1/Siege style blocky turret
      ctx.fillStyle = colorLight;
      ctx.beginPath();
      ctx.moveTo(-14, -19);
      ctx.lineTo(-10, -29);
      ctx.lineTo(10, -29);
      ctx.lineTo(14, -19);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (tankType === 'multi') {
      // === CRATER MULTI (Artillery / Multi-Rocket Carrier) ===
      // Rugged wide treads
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.roundRect(-22, -10, 44, 10, 5);
      ctx.fill();
      ctx.stroke();

      // Caterpillar rollers + orange hubs
      for (let wx = -15; wx <= 15; wx += 7.5) {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(wx, -5, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Flat artillery deck chassis + rear ammo rack
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(-21, -16, 42, 7.5, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = colorDark || '#334155';
      ctx.beginPath();
      ctx.roundRect(-20, -22, 8, 7, 2);
      ctx.fill();
      ctx.stroke();

      // Tall bulbous artillery launcher dome + top sensor antenna
      ctx.fillStyle = colorLight;
      ctx.beginPath();
      ctx.roundRect(-11, -29, 22, 14, 7);
      ctx.fill();
      ctx.stroke();

      // Radar dish on top
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-3, -29);
      ctx.lineTo(-3, -34);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-3, -35, 4, Math.PI * 0.2, Math.PI * 0.9);
      ctx.stroke();
    } else if (tankType === 'laser') {
      // === SPEED LASER (Futuristic Hover-Railgun Tank) ===
      const hoverBob = Math.sin((nowMs || 0) * 0.008) * 1.4;
      ctx.save();
      ctx.translate(0, -1.5 + hoverBob);

      // Glowing plasma hover thrusters underneath
      ctx.fillStyle = 'rgba(56, 189, 248, 0.78)';
      ctx.beginPath();
      ctx.ellipse(-11, -1.5, 8, 2.8, 0, 0, Math.PI * 2);
      ctx.ellipse(11, -1.5, 8, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();

      // Streamlined sci-fi hover skids
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-22, -4);
      ctx.lineTo(-17, -9);
      ctx.lineTo(19, -9);
      ctx.lineTo(24, -4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Sharp forward-swept wedge hull
      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-21, -8);
      ctx.lineTo(-15, -16);
      ctx.lineTo(13, -16);
      ctx.lineTo(25, -9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Sleek stealth prism turret + cyan energy visor
      ctx.fillStyle = colorLight;
      ctx.beginPath();
      ctx.moveTo(-12, -15);
      ctx.lineTo(-5, -25);
      ctx.lineTo(8, -24);
      ctx.lineTo(13, -15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.roundRect(2, -22, 7, 3.5, 1.5);
      ctx.fill();

      ctx.restore();
    } else {
      // === CLASSIC CANNON (Balanced Standard Tank) ===
      // Treads
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.roundRect(-20, -9.5, 40, 9.5, 5);
      ctx.fill();
      ctx.stroke();

      // 5 Road wheels
      ctx.fillStyle = '#94a3b8';
      for (let wx = -13; wx <= 13; wx += 6.5) {
        ctx.beginPath();
        ctx.arc(wx, -4.5, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Rounded armored hull + front headlight
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(-18, -17, 36, 9.5, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(14, -12.5, 2.2, 0, Math.PI * 2);
      ctx.fill();

      // Classic hemispherical dome turret + commander hatch
      ctx.fillStyle = colorLight;
      ctx.beginPath();
      ctx.arc(0, -16, 11.5, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = colorDark || color;
      ctx.beginPath();
      ctx.roundRect(-5, -29.5, 8, 3, 1.5);
      ctx.fill();
      ctx.stroke();
    }
  }

  function getTankLocalPivotY(tankType) {
    if (tankType === 'duke') return 23;
    if (tankType === 'multi') return 22;
    if (tankType === 'laser') return 19;
    return 18;
  }

  function renderTankCardPreviews() {
    const colors = {
      cannon: { main: '#38bdf8', dark: '#0284c7', light: '#bae6fd' },
      duke: { main: '#fb7185', dark: '#e11d48', light: '#fecdd3' },
      multi: { main: '#fbbf24', dark: '#d97706', light: '#fde68a' },
      laser: { main: '#34d399', dark: '#059669', light: '#a7f3d0' }
    };

    function makeTankPreviewCanvas(tType) {
      const cvs = document.createElement('canvas');
      cvs.width = 148;
      cvs.height = 88;
      cvs.style.width = '74px';
      cvs.style.height = '44px';
      cvs.style.display = 'block';

      const c = cvs.getContext('2d');
      c.scale(2, 2);
      const pal = colors[tType] || colors.cannon;
      const pivY = getTankLocalPivotY(tType);

      c.save();
      c.translate(33, 39 - pivY * 0.82);
      c.rotate((-28 * Math.PI) / 180);
      c.scale(0.82, 0.82);
      drawTankBarrelByType(c, tType, pal.main, pal.light, 0);
      c.restore();

      c.save();
      c.translate(33, 39);
      c.scale(0.82, 0.82);
      drawTankBodyByType(c, tType, pal.main, pal.dark, pal.light, 0);
      c.restore();
      return cvs;
    }

    document.querySelectorAll('#single-tank-grid .tank-card').forEach((card) => {
      const tType = card.getAttribute('data-tank') || 'cannon';
      const icoSpan = card.querySelector('.t-icon');
      if (!icoSpan) return;
      icoSpan.innerHTML = '';
      icoSpan.appendChild(makeTankPreviewCanvas(tType));
    });

    document.querySelectorAll('#guide-tank-cards [data-tank-preview]').forEach((box) => {
      const tType = box.getAttribute('data-tank-preview') || 'cannon';
      box.innerHTML = '';
      box.appendChild(makeTankPreviewCanvas(tType));
    });
  }

  function drawTank(ctx, p, terrain, isActiveTurn, nowMs) {
    const slope = Engine.clamp(Engine.getTerrainSlopeAngle(terrain, p.x), -0.55, 0.55);
    const isMobile = isSmartphoneScreen();
    const worldScale = Math.max(0.24, getWorldScale());
    const visWorldW = viewCssW / worldScale;
    const tankBoost = getMobileTankBoost(); // 1.0 on PC, ~1.48x-1.82x on Smartphone!
    const localPivotY = getTankLocalPivotY(p.tankType);
    const turretOffsetY = localPivotY * tankBoost;

    // Draw Fortress Aiming Arc & Sight Line behind active controllable tank
    if (isActiveTurn && !app.isAnimatingTurn) {
      ctx.save();
      const pivotX = p.x;
      const pivotY = p.y - turretOffsetY;
      const arcR = 56 * (isMobile ? tankBoost * 0.82 : 1);

      // Subtle angle fan
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.32)';
      ctx.lineWidth = isMobile ? 2.6 : 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      if (p.facing > 0) {
        ctx.arc(pivotX, pivotY, arcR, (-85 * Math.PI) / 180, (-5 * Math.PI) / 180);
      } else {
        ctx.arc(pivotX, pivotY, arcR, (-175 * Math.PI) / 180, (-95 * Math.PI) / 180);
      }
      ctx.stroke();

      // Aiming vector dotted guide
      const rad = (p.angle * Math.PI) / 180;
      const dx = Math.cos(rad) * p.facing;
      const dy = -Math.sin(rad);
      const startR = 28 * tankBoost;
      const endR = (46 + p.power * 0.55) * (isMobile ? tankBoost * 0.85 : 1);
      ctx.strokeStyle = 'rgba(254, 240, 138, 0.85)';
      ctx.lineWidth = isMobile ? 3.2 : 2.5;
      ctx.beginPath();
      ctx.moveTo(pivotX + dx * startR, pivotY + dy * startR);
      ctx.lineTo(pivotX + dx * endR, pivotY + dy * endR);
      ctx.stroke();
      ctx.setLineDash([]);

      // Bouncing Turn Arrow above active tank
      const bounce = Math.sin(nowMs * 0.007) * (5 * (isMobile ? 1.2 : 1));
      const arrowBaseY = p.y - (isMobile ? 46 * tankBoost + 28 : 64) + bounce;
      const arrowSize = isMobile ? 11 : 8;
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(p.x, arrowBaseY);
      ctx.lineTo(p.x - arrowSize, arrowBaseY - arrowSize * 1.55);
      ctx.lineTo(p.x + arrowSize, arrowBaseY - arrowSize * 1.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 1. Draw Distinct Cannon Barrel in World Angle (scaled by tankBoost on Smartphone)
    const turretBaseX = p.x;
    const turretBaseY = p.y - turretOffsetY;
    const rad = (p.angle * Math.PI) / 180;
    const barrelWorldAngle = Math.atan2(-Math.sin(rad), Math.cos(rad) * p.facing);

    ctx.save();
    ctx.translate(turretBaseX, turretBaseY);
    ctx.rotate(barrelWorldAngle);
    ctx.scale(tankBoost, tankBoost);
    drawTankBarrelByType(ctx, p.tankType, p.color, p.colorLight, nowMs);
    ctx.restore();

    // 2. Draw Distinct Chassis & Turret Tilted with Terrain Slope (anchored at ground p.x, p.y)
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(slope * 0.75);
    ctx.scale(tankBoost * (p.facing < 0 ? -1 : 1), tankBoost);
    drawTankBodyByType(ctx, p.tankType, p.color, p.colorDark, p.colorLight, nowMs);
    ctx.restore();

    // 3. Overhead HP Bar & Nickname Tag (Cleanly sized & horizontally edge-clamped so left/right borders never slice labels!)
    const barW = isMobile ? Math.round(42 * tankBoost * 0.86) : 46;
    const barH = isMobile ? Math.round(5.5 * tankBoost * 0.82) : 6;
    const fontWorldPx = isMobile ? Math.round(Engine.clamp(12 / worldScale, 18, 30)) : 13;
    ctx.font = `800 ${fontWorldPx}px Pretendard, Malgun Gothic, sans-serif`;
    ctx.textAlign = 'center';

    const textW = ctx.measureText(p.nickname).width;
    const pillPadX = isMobile ? fontWorldPx * 0.42 : 6;
    const halfLabelW = Math.max(barW * 0.5 + 3, textW * 0.5 + pillPadX + 3);

    // Keep overhead label safely inside world borders and (when tank is visible on screen) inside left/right screen borders
    let labelCenterX = Engine.clamp(p.x, halfLabelW + 6, Engine.WORLD_WIDTH - halfLabelW - 6);
    const isTankOnScreen = p.x >= app.camera.x - 24 && p.x <= app.camera.x + visWorldW + 24;
    if (isTankOnScreen && visWorldW > halfLabelW * 2 + 16) {
      labelCenterX = Engine.clamp(
        labelCenterX,
        app.camera.x + halfLabelW + 8,
        app.camera.x + visWorldW - halfLabelW - 8
      );
    }

    const bx = labelCenterX - barW * 0.5;
    const by = p.y - (isMobile ? 38 * tankBoost + barH : 44);

    // Keep overhead tank HP bar intact right above the tank!
    ctx.fillStyle = 'rgba(7, 13, 25, 0.86)';
    ctx.fillRect(bx - 1.5, by - 1.5, barW + 3, barH + 3);
    const hpRatio = Engine.clamp(p.hp / p.maxHp, 0, 1);
    ctx.fillStyle = hpRatio > 0.55 ? '#22c55e' : hpRatio > 0.28 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(bx, by, barW * hpRatio, barH);

    // High-contrast bright nickname pill with player team border so nicknames never look dark or hard to read
    const pillH = isMobile ? fontWorldPx * 1.34 : 18;
    const pillY = by - pillH - (isMobile ? 4 : 3.5);
    ctx.fillStyle = 'rgba(15, 34, 66, 0.9)';
    ctx.strokeStyle = isActiveTurn ? '#fbbf24' : p.color;
    ctx.lineWidth = isMobile ? Math.max(1.8, fontWorldPx * 0.09) : 1.4;
    ctx.beginPath();
    ctx.roundRect(labelCenterX - textW * 0.5 - pillPadX, pillY, textW + pillPadX * 2, pillH, pillH * 0.48);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isActiveTurn ? '#fef08a' : '#ffffff';
    ctx.fillText(p.nickname, labelCenterX, pillY + pillH * 0.76);
  }

  function drawOffscreenEnemyPointers(ctx, match, activePlayer, scale, extraMarginPx) {
    if (!activePlayer) return;
    const isMobile = isSmartphoneScreen();
    let leftIdx = 0;
    let rightIdx = 0;

    for (const p of match.players) {
      if (!p.alive || p.id === activePlayer.id) continue;
      const screenX = extraMarginPx + (p.x - app.camera.x) * scale;
      const distMeters = Math.round(Math.abs(p.x - activePlayer.x));
      const shortNick = isMobile && p.nickname.length > 6 ? `${p.nickname.slice(0, 6)}…` : p.nickname;

      if (screenX < -12) {
        const py = 26 + leftIdx * 26;
        leftIdx++;
        drawEdgeBadge(ctx, 8, py, `◀ ${p.badge} ${shortNick} ${distMeters}m`, p.color, 'left');
      } else if (screenX > viewCssW + 12) {
        const py = 26 + rightIdx * 26;
        rightIdx++;
        drawEdgeBadge(ctx, viewCssW - 8, py, `${p.badge} ${shortNick} ${distMeters}m ▶`, p.color, 'right');
      }
    }
  }

  function drawEdgeBadge(ctx, x, y, label, borderColor, align) {
    ctx.save();
    ctx.font = '800 10.5px Pretendard, Malgun Gothic, sans-serif';
    const maxBadgeW = Math.max(96, Math.floor(viewCssW * 0.45));
    let displayLabel = label;
    while (displayLabel.length > 5 && ctx.measureText(displayLabel).width + 14 > maxBadgeW) {
      displayLabel = displayLabel.slice(0, -2) + '…';
    }
    const tw = Math.min(maxBadgeW, ctx.measureText(displayLabel).width + 14);
    const rx = align === 'left' ? x : x - tw;
    ctx.fillStyle = 'rgba(20, 38, 70, 0.92)';
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(rx, y - 10.5, tw, 21, 10.5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayLabel, rx + 7, y);
    ctx.restore();
  }

  // Minimap Radar Renderer (Auto-syncs bitmap resolution to actual CSS flex width/height so aspect ratio never stretches!)
  function renderMinimap() {
    const match = app.renderMatch;
    if (!match) return;
    const cssW = minimapCanvas.clientWidth;
    const cssH = minimapCanvas.clientHeight;
    if (cssW > 10 && cssH > 10) {
      const targetW = Math.round(cssW * viewDpr);
      const targetH = Math.round(cssH * viewDpr);
      if (minimapCanvas.width !== targetW || minimapCanvas.height !== targetH) {
        minimapCanvas.width = targetW;
        minimapCanvas.height = targetH;
      }
    }
    const w = minimapCanvas.width;
    const h = minimapCanvas.height;
    if (w < 10 || h < 10) return;

    miniCtx.clearRect(0, 0, w, h);
    miniCtx.fillStyle = '#070d19';
    miniCtx.fillRect(0, 0, w, h);

    // Terrain silhouette
    miniCtx.fillStyle = '#334155';
    miniCtx.beginPath();
    miniCtx.moveTo(0, h);
    const step = 28;
    for (let wx = 0; wx <= Engine.WORLD_WIDTH; wx += step) {
      const mx = (wx / Engine.WORLD_WIDTH) * w;
      const my = (match.terrain[wx] / Engine.WORLD_HEIGHT) * h;
      miniCtx.lineTo(mx, my);
    }
    miniCtx.lineTo(w, h);
    miniCtx.closePath();
    miniCtx.fill();

    // Practice targets
    if (match.isPractice && match.practiceTargets) {
      miniCtx.fillStyle = '#f87171';
      for (const t of match.practiceTargets) {
        const mx = (t.x / Engine.WORLD_WIDTH) * w;
        const my = (t.y / Engine.WORLD_HEIGHT) * h;
        miniCtx.beginPath();
        miniCtx.arc(mx, my, 2.5 * viewDpr, 0, Math.PI * 2);
        miniCtx.fill();
      }
    }

    // Alive tanks
    for (const p of match.players) {
      if (!p.alive) continue;
      const mx = (p.x / Engine.WORLD_WIDTH) * w;
      const my = Math.max(3, (p.y / Engine.WORLD_HEIGHT) * h - 2);
      miniCtx.fillStyle = p.color;
      miniCtx.beginPath();
      miniCtx.arc(mx, my, 3.2 * viewDpr, 0, Math.PI * 2);
      miniCtx.fill();
    }

    // Active shell dot on minimap (color-coded by shell type)
    if (app.activeShell && app.activeShell.trail.length > 0) {
      const hd = app.activeShell.head || app.activeShell.trail[app.activeShell.trail.length - 1];
      const wId = app.activeShell.weaponId;
      miniCtx.fillStyle =
        wId === 'teleport'
          ? '#22d3ee'
          : wId === 'power'
          ? '#ef4444'
          : wId === 'double'
          ? '#fb923c'
          : '#fef08a';
      miniCtx.beginPath();
      miniCtx.arc((hd.x / Engine.WORLD_WIDTH) * w, (hd.y / Engine.WORLD_HEIGHT) * h, 2.8 * viewDpr, 0, Math.PI * 2);
      miniCtx.fill();
    }

    // Current Horizontal Camera Viewport Box
    const visW = Math.min(Engine.WORLD_WIDTH, getVisibleWorldWidth());
    const vx = (app.camera.x / Engine.WORLD_WIDTH) * w;
    const vw = (visW / Engine.WORLD_WIDTH) * w;
    miniCtx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    miniCtx.lineWidth = Math.max(1.5, 1.5 * viewDpr);
    miniCtx.strokeRect(vx, 1, vw, h - 2);
  }

  // ==========================================
  // Online Multiplayer Networking (WebSocket + Serverless MQTT Fallback)
  // Supports 2~4 Player Dynamic Rooms!
  // ==========================================
  let ws = null;
  let transportMode = 'none'; // 'none' | 'server' | 'serverless'
  let mqttRxBuffer = new Uint8Array(0);
  let mqttPingTimer = null;
  let hostAnnounceTimer = null;

  const TOPIC_LOBBY = 'daepo_fortress_v1/lobby';
  const TOPIC_PEER_PREFIX = 'daepo_fortress_v1/peer/';
  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  let mqttBrokerIdx = 0;
  let mqttConnectedOnce = false;
  const pendingNetQueue = [];
  const serverlessRooms = new Map();
  let hostedServerlessRoom = null;
  let joinedHostPeerId = null;

  function isNativeAndroidApp() {
    const h = (location.hostname || '').toLowerCase();
    return (
      Boolean(window.TankClashAndroid) ||
      location.protocol === 'file:' ||
      location.protocol === 'capacitor:' ||
      h === 'appassets.androidplatform.net'
    );
  }

  function isStaticCloudHost() {
    if (isNativeAndroidApp()) return true;
    const h = (location.hostname || '').toLowerCase();
    return (
      h.endsWith('.github.io') ||
      h.endsWith('.vercel.app') ||
      h.endsWith('.netlify.app') ||
      h.endsWith('.pages.dev')
    );
  }

  function flushPendingNetQueue() {
    while (pendingNetQueue.length > 0) {
      const item = pendingNetQueue.shift();
      netSend(item);
    }
  }

  function setWsBadge(cls, label) {
    const el = document.getElementById('ws-status-badge');
    if (!el) return;
    el.className = `ws-badge ${cls}`;
    el.textContent = label;
  }

  function ensureNetworkConnected() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setWsBadge('connecting', '연결중...');

    // On GitHub Pages / static cloud hosts, connect directly to Serverless WSS Relay with 0ms delay!
    if (isStaticCloudHost()) {
      connectServerlessMqtt();
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}`;
    let fallbackTriggered = false;

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      connectServerlessMqtt();
      return;
    }

    const fallbackTimer = setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        fallbackTriggered = true;
        try {
          ws.close();
        } catch (e) {}
        connectServerlessMqtt();
      }
    }, 1500);

    ws.onopen = () => {
      if (fallbackTriggered) return;
      clearTimeout(fallbackTimer);
      transportMode = 'server';
      setWsBadge('connected', '온라인');
      netSend({
        type: 'set_profile',
        nickname: app.nickname,
        tankType: app.myTankType,
        stats: app.stats
      });
      netSend({ type: 'get_rooms' });
      flushPendingNetQueue();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'welcome' && msg.clientId) {
          app.myClientId = msg.clientId;
        }
        handleIncomingNetMessage(msg);
      } catch (e) {}
    };

    ws.onclose = () => {
      if (!fallbackTriggered && transportMode !== 'server') {
        fallbackTriggered = true;
        clearTimeout(fallbackTimer);
        connectServerlessMqtt();
        return;
      }
      setWsBadge('disconnected', '연결끊김');
    };

    ws.onerror = () => {
      if (!fallbackTriggered && transportMode !== 'server') {
        fallbackTriggered = true;
        clearTimeout(fallbackTimer);
        connectServerlessMqtt();
      }
    };
  }

  // Lightweight MQTT over WSS codec for static cloud deployments
  function encodeMqttLen(len) {
    const out = [];
    do {
      let d = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) d |= 0x80;
      out.push(d);
    } while (len > 0);
    return out;
  }

  function encodeMqttStr(str) {
    const u8 = new TextEncoder().encode(str);
    const res = new Uint8Array(2 + u8.length);
    res[0] = (u8.length >> 8) & 0xff;
    res[1] = u8.length & 0xff;
    res.set(u8, 2);
    return res;
  }

  function buildMqttConnect(clientId) {
    const proto = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
    const idBytes = encodeMqttStr(clientId);
    const rem = proto.length + idBytes.length;
    const lenB = encodeMqttLen(rem);
    const pkt = new Uint8Array(1 + lenB.length + rem);
    pkt[0] = 0x10;
    pkt.set(lenB, 1);
    pkt.set(proto, 1 + lenB.length);
    pkt.set(idBytes, 1 + lenB.length + proto.length);
    return pkt;
  }

  function buildMqttSub(topic, pid) {
    const tb = encodeMqttStr(topic);
    const rem = 2 + tb.length + 1;
    const lenB = encodeMqttLen(rem);
    const pkt = new Uint8Array(1 + lenB.length + rem);
    pkt[0] = 0x82;
    pkt.set(lenB, 1);
    let o = 1 + lenB.length;
    pkt[o++] = (pid >> 8) & 0xff;
    pkt[o++] = pid & 0xff;
    pkt.set(tb, o);
    pkt[o + tb.length] = 0x00;
    return pkt;
  }

  function buildMqttPub(topic, obj) {
    const tb = encodeMqttStr(topic);
    const pb = new TextEncoder().encode(JSON.stringify(obj));
    const rem = tb.length + pb.length;
    const lenB = encodeMqttLen(rem);
    const pkt = new Uint8Array(1 + lenB.length + rem);
    pkt[0] = 0x30;
    pkt.set(lenB, 1);
    pkt.set(tb, 1 + lenB.length);
    pkt.set(pb, 1 + lenB.length + tb.length);
    return pkt;
  }

  function mqttPub(topic, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN || transportMode !== 'serverless') return;
    try {
      ws.send(buildMqttPub(topic, obj));
    } catch (e) {}
  }

  function connectServerlessMqtt() {
    transportMode = 'serverless';
    mqttConnectedOnce = false;
    mqttRxBuffer = new Uint8Array(0);
    if (mqttPingTimer) clearInterval(mqttPingTimer);

    const brokerUrl = MQTT_BROKERS[mqttBrokerIdx % MQTT_BROKERS.length];
    try {
      ws = new WebSocket(brokerUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      setWsBadge('disconnected', '오프라인');
      return;
    }

    ws.onopen = () => {
      ws.send(buildMqttConnect(app.myClientId));
    };

    ws.onmessage = (ev) => {
      const chunk = new Uint8Array(ev.data);
      const merged = new Uint8Array(mqttRxBuffer.length + chunk.length);
      merged.set(mqttRxBuffer, 0);
      merged.set(chunk, mqttRxBuffer.length);
      mqttRxBuffer = merged;
      drainMqttPackets();
    };

    ws.onclose = () => {
      if (!mqttConnectedOnce && mqttBrokerIdx < MQTT_BROKERS.length - 1) {
        mqttBrokerIdx++;
        connectServerlessMqtt();
        return;
      }
      setWsBadge('disconnected', '오프라인');
    };
    ws.onerror = () => {
      if (!mqttConnectedOnce && mqttBrokerIdx < MQTT_BROKERS.length - 1) {
        try {
          ws.close();
        } catch (e) {}
      } else {
        setWsBadge('disconnected', '오프라인');
      }
    };
  }

  function drainMqttPackets() {
    while (mqttRxBuffer.length >= 2) {
      const type = mqttRxBuffer[0] >> 4;
      let mult = 1;
      let remLen = 0;
      let idx = 1;
      let d = 0;
      do {
        if (idx >= mqttRxBuffer.length) return;
        d = mqttRxBuffer[idx++];
        remLen += (d & 127) * mult;
        mult *= 128;
      } while ((d & 128) !== 0);

      const total = idx + remLen;
      if (mqttRxBuffer.length < total) return;

      const body = mqttRxBuffer.slice(idx, total);
      mqttRxBuffer = mqttRxBuffer.slice(total);

      if (type === 2) {
        mqttConnectedOnce = true;
        setWsBadge('connected', '온라인');
        ws.send(buildMqttSub(TOPIC_LOBBY, 1));
        ws.send(buildMqttSub(TOPIC_PEER_PREFIX + app.myClientId, 2));
        mqttPub(TOPIC_LOBBY, { kind: 'discover', fromId: app.myClientId });
        flushPendingNetQueue();

        if (mqttPingTimer) clearInterval(mqttPingTimer);
        mqttPingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new Uint8Array([0xc0, 0x00]));
          }
        }, 25000);
      } else if (type === 3) {
        const tLen = (body[0] << 8) | body[1];
        const topic = new TextDecoder().decode(body.slice(2, 2 + tLen));
        const str = new TextDecoder().decode(body.slice(2 + tLen));
        try {
          onServerlessPacket(topic, JSON.parse(str));
        } catch (e) {}
      }
    }
  }

  // Serverless 2~4P Host-Authoritative Relay Handler
  function sendToServerlessPeer(peerId, serverMsg) {
    if (peerId === app.myClientId) {
      handleIncomingNetMessage(serverMsg);
    } else {
      mqttPub(TOPIC_PEER_PREFIX + peerId, { kind: 'srv', msg: serverMsg });
    }
  }

  function announceServerlessRoom() {
    if (!hostedServerlessRoom) return;
    mqttPub(TOPIC_LOBBY, {
      kind: 'announce',
      room: {
        id: hostedServerlessRoom.id,
        title: hostedServerlessRoom.title,
        hostId: app.myClientId,
        hostName: hostedServerlessRoom.players[0] ? hostedServerlessRoom.players[0].nickname : app.nickname,
        playerCount: hostedServerlessRoom.players.length,
        maxPlayers: 4,
        mapType: hostedServerlessRoom.mapType,
        status: hostedServerlessRoom.status
      }
    });
  }

  function broadcastHostedWaitingRoom() {
    if (!hostedServerlessRoom) return;
    const roomObj = {
      id: hostedServerlessRoom.id,
      title: hostedServerlessRoom.title,
      status: hostedServerlessRoom.status,
      hostId: hostedServerlessRoom.players[0] ? hostedServerlessRoom.players[0].id : null,
      mapType: hostedServerlessRoom.mapType,
      maxPlayers: 4,
      players: hostedServerlessRoom.players.map((p, idx) => ({
        id: p.id,
        slot: idx,
        nickname: p.nickname,
        tankType: p.tankType || 'cannon',
        stats: p.stats,
        isHost: idx === 0
      }))
    };
    for (const p of hostedServerlessRoom.players) {
      sendToServerlessPeer(p.id, { type: 'room_update', myId: p.id, room: roomObj });
    }
    announceServerlessRoom();
  }

  function onServerlessPacket(topic, pkt) {
    if (topic === TOPIC_LOBBY) {
      if (pkt.kind === 'discover' && hostedServerlessRoom) {
        announceServerlessRoom();
      } else if (pkt.kind === 'announce' && pkt.room) {
        serverlessRooms.set(pkt.room.id, { ...pkt.room, updatedAt: Date.now() });
        if (app.screen === 'lobby') renderLobbyList(getFreshServerlessRooms());
      } else if (pkt.kind === 'remove' && pkt.roomId) {
        serverlessRooms.delete(pkt.roomId);
        if (app.screen === 'lobby') renderLobbyList(getFreshServerlessRooms());
      }
      return;
    }

    if (topic === TOPIC_PEER_PREFIX + app.myClientId) {
      if (pkt.kind === 'srv') {
        handleIncomingNetMessage(pkt.msg);
      } else if (pkt.kind === 'cmd' && hostedServerlessRoom) {
        handleServerlessHostCmd(pkt.fromId, pkt.payload);
      }
    }
  }

  function getFreshServerlessRooms() {
    const now = Date.now();
    const arr = [];
    for (const [k, v] of serverlessRooms.entries()) {
      if (now - v.updatedAt > 15000) serverlessRooms.delete(k);
      else arr.push(v);
    }
    return arr;
  }

  function handleServerlessHostCmd(fromId, msg) {
    const r = hostedServerlessRoom;
    if (!r || !msg) return;

    if (msg.type === 'join_room') {
      if (r.status !== 'waiting') {
        sendToServerlessPeer(fromId, { type: 'error', message: '이미 게임이 진행 중인 방입니다.' });
        return;
      }
      if (r.players.length >= 4) {
        sendToServerlessPeer(fromId, { type: 'error', message: '방 인원(최대 4명)이 가득 찼습니다.' });
        return;
      }
      if (!r.players.some((p) => p.id === fromId)) {
        r.players.push({
          id: fromId,
          nickname: (msg.nickname || '유저').slice(0, 10),
          tankType: msg.tankType || 'cannon',
          stats: msg.stats || { wins: 0, losses: 0, draws: 0 }
        });
      }
      broadcastHostedWaitingRoom();
      for (const p of r.players) {
        sendToServerlessPeer(p.id, {
          type: 'room_notice',
          text: `👋 ${msg.nickname || '유저'}님이 입장했습니다! (현재 ${r.players.length}인용)`
        });
      }
    } else if (msg.type === 'select_tank') {
      const p = r.players.find((x) => x.id === fromId);
      if (p && Engine.TANK_TYPES[msg.tankType]) {
        p.tankType = msg.tankType;
        broadcastHostedWaitingRoom();
      }
    } else if (msg.type === 'select_map' && fromId === app.myClientId) {
      r.mapType = msg.mapType || 'random';
      broadcastHostedWaitingRoom();
    } else if (msg.type === 'room_chat') {
      const p = r.players.find((x) => x.id === fromId);
      if (!p) return;
      for (const peer of r.players) {
        sendToServerlessPeer(peer.id, {
          type: 'room_chat',
          senderId: fromId,
          nickname: p.nickname,
          text: String(msg.text || '').slice(0, 40)
        });
      }
    } else if (msg.type === 'start_match' && fromId === app.myClientId) {
      if (r.players.length < 2) return;
      r.match = Engine.createMatch({
        mapType: r.mapType,
        players: r.players.map((p, idx) => ({
          id: p.id,
          nickname: p.nickname,
          isAi: false,
          tankType: p.tankType || 'cannon',
          slotIndex: idx
        }))
      });
      r.status = 'playing';
      // Keep packet compact by sending seed + mapType + players; terrain reconstructed deterministically or sent
      const exported = Engine.exportMatchState(r.match);
      for (const p of r.players) {
        sendToServerlessPeer(p.id, {
          type: 'match_started',
          myId: p.id,
          roomId: r.id,
          roomTitle: r.title,
          playerCount: r.players.length,
          match: exported
        });
      }
      announceServerlessRoom();
    } else if (msg.type === 'move_tank' && r.status === 'playing' && r.match) {
      const active = r.match.players[r.match.turnIndex];
      if (!active || active.id !== fromId) return;
      Engine.moveTank(r.match, r.match.turnIndex, msg.dir, msg.dist || 4);
      for (const p of r.players) {
        if (p.id === fromId) continue;
        sendToServerlessPeer(p.id, {
          type: 'tank_moved',
          playerId: active.id,
          x: +active.x.toFixed(1),
          y: +active.y.toFixed(1),
          facing: active.facing,
          fuel: +active.fuel.toFixed(1),
          alive: active.alive
        });
      }
    } else if (msg.type === 'aim_sync' && r.status === 'playing' && r.match) {
      const active = r.match.players[r.match.turnIndex];
      if (!active || active.id !== fromId) return;
      if (msg.facing) active.facing = msg.facing;
      if (typeof msg.angle === 'number') active.angle = msg.angle;
      if (msg.weapon) active.selectedWeapon = msg.weapon;
      for (const p of r.players) {
        if (p.id === fromId) continue;
        sendToServerlessPeer(p.id, {
          type: 'tank_aimed',
          playerId: active.id,
          facing: active.facing,
          angle: active.angle,
          weapon: active.selectedWeapon
        });
      }
    } else if (msg.type === 'fire_turn' && r.status === 'playing' && r.match) {
      const active = r.match.players[r.match.turnIndex];
      if (!active || active.id !== fromId) return;
      const res = Engine.executeTurnAction(r.match, msg);
      if (!res) return;
      for (const p of r.players) {
        sendToServerlessPeer(p.id, { type: 'turn_resolved', result: res });
      }
      if (r.match.status === 'finished') {
        const sorted = [...r.match.players].sort((a, b) => {
          if (a.alive !== b.alive) return a.alive ? -1 : 1;
          return b.deathOrder - a.deathOrder;
        });
        const rankings = sorted.map((pl, idx) => ({
          rank: idx + 1,
          id: pl.id,
          nickname: pl.nickname,
          badge: pl.badge,
          kills: pl.kills,
          damageDealt: pl.damageDealt
        }));
        const winnerId = r.match.winnerId;
        setTimeout(() => {
          for (const pl of r.players) {
            const out = !winnerId ? 'draw' : pl.id === winnerId ? 'win' : 'lose';
            if (out === 'win') pl.stats.wins += 1;
            else if (out === 'lose') pl.stats.losses += 1;
            else pl.stats.draws += 1;
            sendToServerlessPeer(pl.id, {
              type: 'match_over',
              result: out,
              winnerId,
              rankings,
              meStats: pl.stats
            });
          }
          r.status = 'waiting';
          r.match = null;
          announceServerlessRoom();
        }, 3200);
      }
    } else if (msg.type === 'back_to_room') {
      if (r.status === 'waiting') broadcastHostedWaitingRoom();
    } else if (msg.type === 'leave_room') {
      r.players = r.players.filter((p) => p.id !== fromId);
      if (r.status === 'waiting') broadcastHostedWaitingRoom();
    }
  }

  function netSend(obj) {
    const isReady =
      ws &&
      ws.readyState === WebSocket.OPEN &&
      (transportMode === 'server' || (transportMode === 'serverless' && mqttConnectedOnce));
    if (!isReady) {
      if (obj.type !== 'aim_sync' && obj.type !== 'move_tank') {
        pendingNetQueue.push(obj);
      }
      ensureNetworkConnected();
      return;
    }

    if (transportMode === 'server') {
      ws.send(JSON.stringify(obj));
      return;
    }

    if (transportMode !== 'serverless') return;

    if (obj.type === 'get_rooms') {
      mqttPub(TOPIC_LOBBY, { kind: 'discover', fromId: app.myClientId });
      renderLobbyList(getFreshServerlessRooms());
    } else if (obj.type === 'create_room') {
      hostedServerlessRoom = {
        id: 'room_' + app.myClientId,
        title: obj.title || `${app.nickname}의 탱크 클래시 방`,
        mapType: obj.mapType || 'random',
        status: 'waiting',
        players: [
          {
            id: app.myClientId,
            nickname: app.nickname,
            tankType: app.myTankType,
            stats: { ...app.stats }
          }
        ],
        match: null
      };
      joinedHostPeerId = app.myClientId;
      broadcastHostedWaitingRoom();
      if (hostAnnounceTimer) clearInterval(hostAnnounceTimer);
      hostAnnounceTimer = setInterval(announceServerlessRoom, 4000);
    } else if (obj.type === 'join_room') {
      const target = serverlessRooms.get(obj.roomId);
      joinedHostPeerId = target ? target.hostId : obj.roomId.replace('room_', '');
      mqttPub(TOPIC_PEER_PREFIX + joinedHostPeerId, {
        kind: 'cmd',
        fromId: app.myClientId,
        payload: obj
      });
    } else if (obj.type === 'leave_room') {
      if (hostedServerlessRoom) {
        if (hostAnnounceTimer) clearInterval(hostAnnounceTimer);
        for (const p of hostedServerlessRoom.players) {
          if (p.id !== app.myClientId) {
            sendToServerlessPeer(p.id, { type: 'left_room', rooms: [] });
          }
        }
        mqttPub(TOPIC_LOBBY, { kind: 'remove', roomId: hostedServerlessRoom.id });
        serverlessRooms.delete(hostedServerlessRoom.id);
        hostedServerlessRoom = null;
        joinedHostPeerId = null;
        showScreen('lobby');
      } else if (joinedHostPeerId) {
        mqttPub(TOPIC_PEER_PREFIX + joinedHostPeerId, {
          kind: 'cmd',
          fromId: app.myClientId,
          payload: { type: 'leave_room' }
        });
        joinedHostPeerId = null;
        showScreen('lobby');
      }
    } else if (joinedHostPeerId) {
      if (joinedHostPeerId === app.myClientId) {
        handleServerlessHostCmd(app.myClientId, obj);
      } else {
        mqttPub(TOPIC_PEER_PREFIX + joinedHostPeerId, {
          kind: 'cmd',
          fromId: app.myClientId,
          payload: obj
        });
      }
    }
  }

  // ==========================================
  // Handle Server / Host Messages
  // ==========================================
  function handleIncomingNetMessage(msg) {
    switch (msg.type) {
      case 'welcome':
      case 'room_list':
        renderLobbyList(msg.rooms || []);
        break;

      case 'error':
        alert(msg.message || '오류가 발생했습니다.');
        break;

      case 'left_room':
        app.currentRoom = null;
        clearTurnCountdown();
        document.getElementById('gameover-modal').classList.add('hidden');
        renderLobbyList(msg.rooms || []);
        showScreen('lobby');
        break;

      case 'room_update':
        if (msg.myId) app.myClientId = msg.myId;
        app.currentRoom = msg.room;
        document.getElementById('gameover-modal').classList.add('hidden');
        renderWaitingRoomUI(msg.room);
        if (app.screen !== 'room') {
          document.getElementById('room-chat-log').innerHTML = '';
          showScreen('room');
        }
        break;

      case 'room_notice':
        appendRoomChatLine(null, msg.text, true);
        break;

      case 'room_chat':
        appendRoomChatLine(msg.nickname, msg.text, false);
        break;

      case 'match_started':
        if (msg.myId) app.myClientId = msg.myId;
        app.mode = 'multi';
        document.getElementById('gameover-modal').classList.add('hidden');
        hydrateRenderMatchFromExport(msg.match);
        showScreen('game');
        resizeBattleCanvas();
        focusActiveTank(true);
        syncAllBattleHud();
        showToast(
          `🌐 ${msg.playerCount}인용 온라인 탱크 클래시 (Tank Clash) 시작!`,
          2600
        );
        beginTurnPhase();
        break;

      case 'tank_moved': {
        if (!app.renderMatch) break;
        const p = app.renderMatch.players.find((x) => x.id === msg.playerId);
        if (p) {
          p.x = msg.x;
          p.y = msg.y;
          p.facing = msg.facing;
          p.fuel = msg.fuel;
          p.alive = msg.alive;
          if (app.camera.mode === 'followTank') centerCameraOnWorldX(p.x, false);
          syncAllBattleHud();
        }
        break;
      }

      case 'tank_aimed': {
        if (!app.renderMatch) break;
        const p = app.renderMatch.players.find((x) => x.id === msg.playerId);
        if (p) {
          p.facing = msg.facing;
          p.angle = msg.angle;
          if (msg.weapon) p.selectedWeapon = msg.weapon;
        }
        break;
      }

      case 'turn_resolved':
        clearTurnCountdown();
        playTurnResultAnimation(msg.result, () => {
          if (app.renderMatch && app.renderMatch.status === 'playing') {
            beginTurnPhase();
          }
        });
        break;

      case 'player_left_match':
        if (app.renderMatch && msg.playersSnapshot) {
          app.renderMatch.players = msg.playersSnapshot;
          syncAllBattleHud();
          showToast(`🚪 ${msg.nickname}님이 퇴장했습니다.`, 2200);
        }
        break;

      case 'turn_skipped':
        if (app.renderMatch) {
          app.renderMatch.turnIndex = msg.turnIndex;
          app.renderMatch.turnNumber = msg.turnNumber;
          if (msg.playersSnapshot) app.renderMatch.players = msg.playersSnapshot;
          beginTurnPhase();
        }
        break;

      case 'match_over': {
        clearTurnCountdown();
        if (msg.meStats) {
          app.stats = {
            wins: Number(msg.meStats.wins) || 0,
            losses: Number(msg.meStats.losses) || 0,
            draws: Number(msg.meStats.draws) || 0
          };
          saveProfile();
        }
        const winnerRow = (msg.rankings || [])[0];
        const titleTxt =
          msg.result === 'win'
            ? '🏆 1위 최종 승리!'
            : msg.result === 'lose'
            ? `💔 패배 (${winnerRow ? winnerRow.nickname + ' 우승' : '아쉬운 결과'})`
            : '🤝 무승부!';
        const subTxt = '방 대기실로 돌아가 바로 재경기할 수 있습니다.';

        // Wait briefly if shot animation is still wrapping up
        const showNow = () => openResultModal(msg.result, titleTxt, subTxt, msg.rankings || []);
        if (app.isAnimatingTurn) {
          setTimeout(showNow, 900);
        } else {
          showNow();
        }
        break;
      }
    }
  }

  // ==========================================
  // Lobby & 2~4P Waiting Room UI Rendering
  // ==========================================
  function renderLobbyList(rooms) {
    const container = document.getElementById('room-list-container');
    const badge = document.getElementById('room-count-badge');
    if (!container || !badge) return;

    badge.textContent = String(rooms.length);
    if (rooms.length === 0) {
      container.innerHTML =
        '<div class="empty-room-msg">현재 생성된 방이 없습니다 — 상단의 [＋ 방 만들기]로 새 방을 만들어보세요!</div>';
      return;
    }

    container.innerHTML = '';
    const mapNames = {
      random: '🎲 랜덤지형',
      mountains: '🏔️ 설산',
      canyon: '🏜️ 대계곡',
      hills: '🌿 구릉지',
      twinpeaks: '🌋 쌍봉분지',
      terrace: '🏜️ 단차고원'
    };

    const compactUi = isSmartphoneScreen();
    rooms.forEach((r) => {
      const isBusy = r.status !== 'waiting' || r.playerCount >= r.maxPlayers;
      const row = document.createElement('div');
      row.className = 'room-row-card';

      const statusLabel =
        r.status === 'playing'
          ? compactUi
            ? `전투 ${r.playerCount}인`
            : `전투중 (${r.playerCount}인)`
          : r.playerCount >= 2
          ? compactUi
            ? `${r.playerCount}/${r.maxPlayers} 입장`
            : `입장가능 ${r.playerCount}/${r.maxPlayers} (${r.playerCount}인용 가능)`
          : compactUi
          ? `${r.playerCount}/${r.maxPlayers} 대기`
          : `대기중 ${r.playerCount}/${r.maxPlayers}`;

      row.innerHTML = `
        <div class="room-row-left">
          <div class="room-row-title">${escapeHtml(r.title)}</div>
          <div class="room-row-meta">
            <span>👑 ${escapeHtml(r.hostName)}</span>
            <span>${mapNames[r.mapType] || '🎲 랜덤지형'}</span>
          </div>
        </div>
        <div class="room-row-right">
          <span class="cap-badge ${isBusy ? 'busy' : 'open'}">${statusLabel}</span>
          <button class="join-room-btn" type="button" ${isBusy ? 'disabled' : ''}>
            ${r.status === 'playing' ? '게임중' : isBusy ? '만원' : '참여 ▶'}
          </button>
        </div>
      `;

      const joinBtn = row.querySelector('.join-room-btn');
      if (!isBusy) {
        joinBtn.addEventListener('click', () => {
          playUiClick(580);
          netSend({
            type: 'join_room',
            roomId: r.id,
            nickname: app.nickname,
            tankType: app.myTankType,
            stats: app.stats
          });
        });
      }
      container.appendChild(row);
    });
  }

  function renderWaitingRoomUI(room) {
    if (!room) return;
    const titleEl = document.getElementById('room-view-title');
    const modePill = document.getElementById('room-mode-pill');
    const slotsEl = document.getElementById('room-player-slots');
    const startBtn = document.getElementById('btn-host-start-match');
    const guestBanner = document.getElementById('guest-wait-banner');
    const mapLockHint = document.getElementById('room-map-lock-hint');

    const count = room.players.length;
    const isHost = room.hostId === app.myClientId;

    if (titleEl) titleEl.textContent = room.title;
    if (modePill) {
      const compactUi = isSmartphoneScreen();
      modePill.textContent =
        count >= 2
          ? compactUi
            ? `${count}인용 (${count}/4)`
            : `현재 ${count}명 → ${count}인용 게임`
          : compactUi
          ? `대기 (${count}/4)`
          : `유저 대기중 (${count}/4명)`;
    }

    // Render 4 Player Slots
    slotsEl.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const p = room.players[i];
      const pal = Engine.PLAYER_PALETTE[i];
      const card = document.createElement('div');

      if (p) {
        const tankSpec = Engine.TANK_TYPES[p.tankType] || Engine.TANK_TYPES.cannon;
        const isMe = p.id === app.myClientId;
        card.className = `slot-card occupied ${isMe ? 'me-slot' : ''}`;
        const w = (p.stats && p.stats.wins) || 0;
        const l = (p.stats && p.stats.losses) || 0;

        card.innerHTML = `
          <div class="slot-top">
            <span class="slot-name">${pal.badge} ${escapeHtml(p.nickname)} ${isMe ? '(나)' : ''}</span>
            ${p.isHost ? '<span class="host-crown">👑 방장</span>' : ''}
          </div>
          <div class="slot-sub">
            <span>${tankSpec.icon} ${tankSpec.name} (${tankSpec.subtitle})</span>
            <span>${w}승 ${l}패</span>
          </div>
        `;
      } else {
        card.className = 'slot-card empty';
        card.innerHTML = `
          <div><strong>${i + 1}P 빈 슬롯</strong></div>
          <div>유저 참여 대기중...</div>
        `;
      }
      slotsEl.appendChild(card);
    }

    // Highlight my tank button & room map button
    const meObj = room.players.find((p) => p.id === app.myClientId);
    const myTank = meObj ? meObj.tankType : app.myTankType;
    document.querySelectorAll('#room-tank-selector .mini-tank-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tank') === myTank);
    });

    if (mapLockHint) mapLockHint.textContent = isHost ? '(방장 변경 가능)' : '(방장 전용)';
    document.querySelectorAll('#room-map-selector .mini-map-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-map') === (room.mapType || 'random'));
      b.disabled = !isHost;
    });

    // Dynamic 2~4P Start Button for Host vs Waiting Banner for Guest
    if (isHost) {
      startBtn.classList.remove('hidden');
      guestBanner.classList.add('hidden');
      if (count < 2) {
        startBtn.disabled = true;
        startBtn.textContent = '⏳ 최소 2명 이상 참여 시 시작 가능 (1/4명)';
      } else {
        startBtn.disabled = false;
        startBtn.textContent = `🚀 ${count}인용 멀티게임 시작! (${count}/4명 참여중)`;
      }
    } else {
      startBtn.classList.add('hidden');
      guestBanner.classList.remove('hidden');
      guestBanner.textContent = `⏳ 방장이 시작하면 ${count}인용 대포 게임이 바로 시작됩니다! (${count}/4명)`;
    }
  }

  function appendRoomChatLine(nick, text, isNotice) {
    const log = document.getElementById('room-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = `chat-line ${isNotice ? 'notice' : ''}`;
    div.textContent = isNotice ? text : `[${nick}] ${text}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==========================================
  // Hold-Repeat Button Binding & Touch/Mouse Panning
  // ==========================================
  function bindHoldButton(btnId, stepFn, intervalMs = 65) {
    const el = document.getElementById(btnId);
    if (!el) return;
    let holdTimer = null;

    const stop = () => {
      if (holdTimer) {
        clearInterval(holdTimer);
        holdTimer = null;
      }
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ensureAudio();
      stepFn();
      stop();
      holdTimer = setInterval(stepFn, intervalMs);
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('pointerleave', stop);
  }

  function setupBattleCanvasDragAndMinimap() {
    // 1. Horizontal Touch/Mouse Drag on Battlefield Canvas to inspect distant enemies!
    gameCanvas.addEventListener('pointerdown', (e) => {
      ensureAudio();
      if (app.isAnimatingTurn) return;
      app.camera.isDragging = true;
      app.camera.dragStartClientX = e.clientX;
      app.camera.dragStartCamX = app.camera.x;
      gameCanvas.setPointerCapture(e.pointerId);
    });

    gameCanvas.addEventListener('pointermove', (e) => {
      if (!app.camera.isDragging) return;
      const deltaPx = e.clientX - app.camera.dragStartClientX;
      if (Math.abs(deltaPx) > 5) {
        app.camera.mode = 'manual';
        const scale = getWorldScale();
        const nextCam = app.camera.dragStartCamX - deltaPx / scale;
        app.camera.x = Engine.clamp(nextCam, 0, getMaxCameraX());
        app.camera.targetX = app.camera.x;
        updateFloatingRecenterBtn();
      }
    });

    const endDrag = () => {
      app.camera.isDragging = false;
    };
    gameCanvas.addEventListener('pointerup', endDrag);
    gameCanvas.addEventListener('pointercancel', endDrag);

    // 2. Minimap Tap/Drag to jump horizontally anywhere across the 2800m battlefield
    let miniDragging = false;
    const scrubMinimap = (e) => {
      if (app.isAnimatingTurn) return;
      const rect = minimapCanvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Engine.clamp((e.clientX - rect.left) / rect.width, 0, 1);
      app.camera.mode = 'manual';
      centerCameraOnWorldX(ratio * Engine.WORLD_WIDTH, false);
      updateFloatingRecenterBtn();
    };

    minimapCanvas.addEventListener('pointerdown', (e) => {
      miniDragging = true;
      minimapCanvas.setPointerCapture(e.pointerId);
      scrubMinimap(e);
    });
    minimapCanvas.addEventListener('pointermove', (e) => {
      if (miniDragging) scrubMinimap(e);
    });
    minimapCanvas.addEventListener('pointerup', () => {
      miniDragging = false;
    });
    minimapCanvas.addEventListener('pointercancel', () => {
      miniDragging = false;
    });

    // 3. Interactive Power Gauge Track (Touch/Drag)
    const powerTrack = document.getElementById('power-gauge-track');
    let pwrDragging = false;
    const updatePwrFromEvent = (e) => {
      const rect = powerTrack.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Engine.clamp((e.clientX - rect.left) / rect.width, 0, 1);
      setPowerDirect(10 + ratio * 90);
    };

    powerTrack.addEventListener('pointerdown', (e) => {
      if (!isMyControllableTurn()) return;
      pwrDragging = true;
      powerTrack.setPointerCapture(e.pointerId);
      updatePwrFromEvent(e);
    });
    powerTrack.addEventListener('pointermove', (e) => {
      if (pwrDragging) updatePwrFromEvent(e);
    });
    powerTrack.addEventListener('pointerup', () => {
      pwrDragging = false;
    });
    powerTrack.addEventListener('pointercancel', () => {
      pwrDragging = false;
    });
  }

  function setupKeyboardControls() {
    window.addEventListener('keydown', (e) => {
      if (app.screen !== 'game') return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (!isMyControllableTurn()) return;

      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        performTankMove(-1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        performTankMove(1);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        adjustCannonAngle(e.shiftKey ? 3 : 1);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        adjustCannonAngle(e.shiftKey ? -3 : -1);
      } else if (e.code === 'Digit1') {
        selectWeapon('normal');
      } else if (e.code === 'Digit2') {
        selectWeapon('double');
      } else if (e.code === 'Digit3') {
        selectWeapon('power');
      } else if (e.code === 'Digit4') {
        selectWeapon('teleport');
      } else if (e.code === 'Digit5') {
        selectWeapon('heal');
      } else if (e.code === 'Space') {
        e.preventDefault();
        const active = getActivePlayer();
        if (active && active.selectedWeapon === 'heal') {
          triggerPlayerFire();
          return;
        }
        if (!app.spaceCharging && active) {
          app.spaceCharging = true;
          active.power = 10;
          syncControlDeckUI();
        }
      } else if (e.code === 'Enter') {
        e.preventDefault();
        triggerPlayerFire();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && app.spaceCharging) {
        e.preventDefault();
        app.spaceCharging = false;
        triggerPlayerFire();
      }
    });
  }

  // ==========================================
  // Shortcut & PWA Installer
  // ==========================================
  let deferredInstallPrompt = null;

  function initShortcutHelper() {
    if (isNativeAndroidApp()) {
      const openBtn = document.getElementById('btn-open-install');
      if (openBtn) openBtn.classList.add('hidden');
      return;
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    const openBtn = document.getElementById('btn-open-install');
    const modal = document.getElementById('install-modal');
    const confirmBtn = document.getElementById('btn-install-confirm');
    const laterBtn = document.getElementById('btn-install-later');
    const guideBox = document.getElementById('install-guide-box');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (openBtn) openBtn.classList.remove('hidden');
    });

    fetch('/api/shortcut-status')
      .then((r) => r.json())
      .then((data) => {
        if (data && data.platform === 'win32' && !data.exists) {
          if (openBtn) openBtn.classList.remove('hidden');
        }
      })
      .catch(() => {});

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        guideBox.classList.add('hidden');
        modal.classList.remove('hidden');
      });
    }

    if (laterBtn) {
      laterBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (deferredInstallPrompt) {
          deferredInstallPrompt.prompt();
          await deferredInstallPrompt.userChoice.catch(() => {});
          deferredInstallPrompt = null;
          modal.classList.add('hidden');
          return;
        }
        try {
          const res = await fetch('/api/create-shortcut', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: location.href })
          });
          const data = await res.json();
          if (data && data.ok) {
            guideBox.textContent = '✅ 바탕화면에 [탱크 클래시] 바로가기 아이콘이 생성되었습니다!';
            guideBox.classList.remove('hidden');
            setTimeout(() => modal.classList.add('hidden'), 1400);
            return;
          }
        } catch (e) {}

        guideBox.textContent =
          '📱 모바일 브라우저 메뉴(⋮ 또는 공유 버튼)에서 [홈 화면에 추가]를 선택해 주세요!';
        guideBox.classList.remove('hidden');
      });
    }
  }

  // ==========================================
  // Wire All UI Event Listeners
  // ==========================================
  document.addEventListener('DOMContentLoaded', () => {
    loadSavedProfile();
    const nickInput = document.getElementById('input-nickname');
    if (nickInput) nickInput.value = app.nickname;
    renderHeaderStats();
    showScreen('menu');

    // Sound & Stat Reset
    const toggleSound = () => {
      app.soundEnabled = !app.soundEnabled;
      saveProfile();
      if (app.soundEnabled) {
        playUiClick(600);
      } else {
        stopShellFlightSound();
      }
    };
    document.getElementById('btn-sound-toggle').addEventListener('click', toggleSound);
    document.getElementById('btn-battle-sound').addEventListener('click', toggleSound);

    document.getElementById('btn-reset-stats').addEventListener('click', () => {
      if (!confirm('승/패 전적을 초기화할까요?')) return;
      app.stats = { wins: 0, losses: 0, draws: 0 };
      saveProfile();
      if (transportMode === 'server') {
        netSend({ type: 'set_profile', nickname: app.nickname, tankType: app.myTankType, stats: app.stats });
      }
    });

    // Nickname live clear error
    nickInput.addEventListener('input', () => {
      if (nickInput.value.trim()) {
        document.getElementById('name-input-pill').classList.remove('input-error');
        document.getElementById('id-warning-msg').classList.add('hidden');
      }
    });

    // Home Menu -> Single Setup / Multi Lobby
    document.getElementById('btn-go-single').addEventListener('click', () => {
      if (!validateNickname()) return;
      playUiClick(540);
      showScreen('single-setup');
    });

    document.getElementById('btn-go-multi').addEventListener('click', () => {
      if (!validateNickname()) return;
      playUiClick(580);
      app.mode = 'multi';
      showScreen('lobby');
      ensureNetworkConnected();
      netSend({ type: 'get_rooms' });
    });

    // Home Menu -> Game Guide & Spec Encyclopedia
    const btnGoGuide = document.getElementById('btn-go-guide');
    if (btnGoGuide) {
      btnGoGuide.addEventListener('click', () => {
        playUiClick(560);
        showScreen('guide');
        const guideScroll = document.querySelector('#screen-guide .guide-scroll');
        if (guideScroll) guideScroll.scrollTop = 0;
      });
    }

    const btnGuideBack = document.getElementById('btn-guide-back');
    if (btnGuideBack) {
      btnGuideBack.addEventListener('click', () => {
        playUiClick(420);
        showScreen('menu');
      });
    }

    const btnGuideBottomBack = document.getElementById('btn-guide-bottom-back');
    if (btnGuideBottomBack) {
      btnGuideBottomBack.addEventListener('click', () => {
        playUiClick(420);
        showScreen('menu');
      });
    }

    // Single Setup Navigation & Selections
    document.getElementById('btn-single-back').addEventListener('click', () => {
      playUiClick(420);
      showScreen('menu');
    });

    const tabAi = document.getElementById('tab-single-ai');
    const tabLocal = document.getElementById('tab-single-local');
    const panelAi = document.getElementById('panel-ai-count');
    const panelLocal = document.getElementById('panel-local-count');

    tabAi.addEventListener('click', () => {
      app.singleSubMode = 'ai';
      tabAi.classList.add('active');
      tabLocal.classList.remove('active');
      panelAi.classList.remove('hidden');
      panelLocal.classList.add('hidden');
      playUiClick(520);
    });

    tabLocal.addEventListener('click', () => {
      app.singleSubMode = 'local';
      tabLocal.classList.add('active');
      tabAi.classList.remove('active');
      panelLocal.classList.remove('hidden');
      panelAi.classList.add('hidden');
      playUiClick(520);
    });

    document.querySelectorAll('#panel-ai-count .count-card').forEach((card) => {
      card.addEventListener('click', () => {
        app.aiCount = Number(card.getAttribute('data-ai-count'));
        document.querySelectorAll('#panel-ai-count .count-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        playUiClick(550);
      });
    });

    document.querySelectorAll('#panel-local-count .count-card').forEach((card) => {
      card.addEventListener('click', () => {
        app.localCount = Number(card.getAttribute('data-local-count'));
        document.querySelectorAll('#panel-local-count .count-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        playUiClick(550);
      });
    });

    document.querySelectorAll('#single-tank-grid .tank-card').forEach((card) => {
      card.addEventListener('click', () => {
        app.myTankType = card.getAttribute('data-tank');
        document.querySelectorAll('#single-tank-grid .tank-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        saveProfile();
        playUiClick(560);
      });
    });

    document.querySelectorAll('#single-map-chips .map-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        app.selectedMapType = chip.getAttribute('data-map');
        document.querySelectorAll('#single-map-chips .map-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        playUiClick(560);
      });
    });

    document.getElementById('btn-start-single').addEventListener('click', () => {
      playUiClick(660);
      app.aiLevel = 1;
      app.lastSingleAiOutcome = null;
      startSingleGame();
    });

    // Multiplayer Lobby Actions
    document.getElementById('btn-lobby-back').addEventListener('click', () => {
      playUiClick(420);
      showScreen('menu');
    });

    document.getElementById('btn-refresh-rooms').addEventListener('click', () => {
      playUiClick(500);
      ensureNetworkConnected();
      netSend({ type: 'get_rooms' });
    });

    document.getElementById('btn-create-room').addEventListener('click', () => {
      playUiClick(620);
      ensureNetworkConnected();
      const titleInput = document.getElementById('input-room-title');
      const title = titleInput.value.trim() || `${app.nickname}의 탱크 클래시 방`;
      netSend({
        type: 'create_room',
        title,
        nickname: app.nickname,
        tankType: app.myTankType,
        mapType: 'random',
        stats: app.stats
      });
      titleInput.value = '';
    });

    // Multiplayer Waiting Room Actions
    document.getElementById('btn-room-leave').addEventListener('click', () => {
      playUiClick(420);
      netSend({ type: 'leave_room' });
      if (transportMode !== 'server') showScreen('lobby');
    });

    document.querySelectorAll('#room-tank-selector .mini-tank-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-tank');
        app.myTankType = t;
        saveProfile();
        playUiClick(540);
        netSend({ type: 'select_tank', tankType: t });
      });
    });

    document.querySelectorAll('#room-map-selector .mini-map-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const m = btn.getAttribute('data-map');
        playUiClick(540);
        netSend({ type: 'select_map', mapType: m });
      });
    });

    document.querySelectorAll('.stamp-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        playUiClick(580);
        netSend({ type: 'room_chat', text: btn.getAttribute('data-msg') });
      });
    });

    document.getElementById('btn-host-start-match').addEventListener('click', () => {
      playUiClick(700);
      netSend({ type: 'start_match' });
    });

    // Battle Screen Top & Camera Controls
    document.getElementById('btn-battle-exit').addEventListener('click', () => {
      clearTurnCountdown();
      clearAiTimer();
      app.activeShell = null;
      document.getElementById('gameover-modal').classList.add('hidden');
      if (app.mode === 'multi') {
        netSend({ type: 'leave_room' });
        showScreen('lobby');
      } else {
        showScreen('single-setup');
      }
    });

    document.getElementById('btn-focus-me').addEventListener('click', () => {
      playUiClick(520);
      focusActiveTank(false);
    });
    document.getElementById('btn-floating-recenter').addEventListener('click', () => {
      playUiClick(520);
      focusActiveTank(false);
    });

    // Weapon Strip Buttons
    document.querySelectorAll('.wpn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectWeapon(btn.getAttribute('data-wpn'));
      });
    });

    // Hold-Repeat Move / Angle / Power Fine Controls
    bindHoldButton('btn-move-left', () => performTankMove(-1), 60);
    bindHoldButton('btn-move-right', () => performTankMove(1), 60);
    bindHoldButton('btn-angle-up', () => adjustCannonAngle(1), 75);
    bindHoldButton('btn-angle-down', () => adjustCannonAngle(-1), 75);
    bindHoldButton('btn-power-minus', () => adjustPower(-1), 70);
    bindHoldButton('btn-power-plus', () => adjustPower(1), 70);

    document.getElementById('btn-fire').addEventListener('click', () => {
      ensureAudio();
      triggerPlayerFire();
    });

    // Game Over Modal Buttons
    document.getElementById('btn-modal-rematch').addEventListener('click', () => {
      document.getElementById('gameover-modal').classList.add('hidden');
      playUiClick(620);
      if (app.mode === 'single') {
        if (app.singleSubMode === 'ai' && app.aiCount > 0) {
          const maxLv = Engine.MAX_AI_LEVEL || 30;
          if (app.lastSingleAiOutcome === 'win') {
            app.aiLevel = app.aiLevel < maxLv ? app.aiLevel + 1 : 1;
          }
          app.lastSingleAiOutcome = null;
        }
        startSingleGame();
      } else {
        netSend({ type: 'back_to_room' });
        showScreen('room');
      }
    });

    document.getElementById('btn-modal-exit').addEventListener('click', () => {
      document.getElementById('gameover-modal').classList.add('hidden');
      clearTurnCountdown();
      clearAiTimer();
      if (app.mode === 'multi') {
        netSend({ type: 'leave_room' });
        showScreen('lobby');
      } else {
        showScreen('menu');
      }
    });

    renderTankCardPreviews();
    setupBattleCanvasDragAndMinimap();
    setupKeyboardControls();
    initShortcutHelper();
    requestAnimationFrame(frameLoop);

    // Native Android hardware Back button / gesture handler
    window.handleAndroidBack = function () {
      const installModal = document.getElementById('install-modal');
      if (installModal && !installModal.classList.contains('hidden')) {
        installModal.classList.add('hidden');
        return true;
      }
      const gameoverModal = document.getElementById('gameover-modal');
      if (gameoverModal && !gameoverModal.classList.contains('hidden')) {
        const exitBtn = document.getElementById('btn-modal-exit');
        if (exitBtn) exitBtn.click();
        return true;
      }
      if (app.screen === 'game') {
        const battleExit = document.getElementById('btn-battle-exit');
        if (battleExit) battleExit.click();
        return true;
      }
      if (app.screen === 'room') {
        const roomLeave = document.getElementById('btn-room-leave');
        if (roomLeave) roomLeave.click();
        return true;
      }
      if (app.screen === 'lobby' || app.screen === 'single-setup' || app.screen === 'guide') {
        playUiClick(420);
        showScreen('menu');
        return true;
      }
      return false;
    };
  });
})();
