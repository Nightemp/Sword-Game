const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || tg?.initDataUnsafe?.start_param || 'default';

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');

let dpr = Math.min(window.devicePixelRatio || 1, 3);
let cssW = 0, cssH = 0;
function resize() {
  cssW = canvas.clientWidth;
  cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const statusEl = document.getElementById('status');
const zoneBars = {
  head: [document.getElementById('head0'), document.getElementById('head1')],
  body: [document.getElementById('body0'), document.getElementById('body1')],
  leg: [document.getElementById('legs0'), document.getElementById('legs1')],
};
const stBars = [document.getElementById('st0'), document.getElementById('st1')];
const winEls = [document.getElementById('wins0'), document.getElementById('wins1')];
const koScreen = document.getElementById('ko-screen');
const koSub = document.getElementById('ko-sub');

let mySlot = null;
let players = {};
let attackFlashSlot = null;
let attackFlashZone = null;
let attackFlashLimb = null; // 'tri' | 'sq' | 'cross' | 'circle'
let attackStartTime = {};
const prevX = {};
const walkPhase = {};
let particles = [];
let sparks = [];
let bloodPools = [];
const bloodDecals = {}; // slot -> [{zone, ox, oy, r}]
let shake = 0;
const fallProgress = {};
const blockFlashBody = {};
const blockFlashHead = {};

let history = [];
const HISTORY_MAX = 90;
let replay = null;
let floaters = [];
let countdown = null; // {value, startTime}
let matchStartPending = false;

const settings = {
  sound: localStorage.getItem('sword_sound') !== 'off',
  gore: localStorage.getItem('sword_gore') === 'on',
};
const soundToggle = document.getElementById('toggle-sound');
const goreToggle = document.getElementById('toggle-gore');
function syncToggles() {
  soundToggle.classList.toggle('on', settings.sound);
  goreToggle.classList.toggle('on', settings.gore);
}
syncToggles();
soundToggle.addEventListener('click', function () {
  settings.sound = !settings.sound;
  localStorage.setItem('sword_sound', settings.sound ? 'on' : 'off');
  syncToggles();
});
goreToggle.addEventListener('click', function () {
  settings.gore = !settings.gore;
  localStorage.setItem('sword_gore', settings.gore ? 'on' : 'off');
  syncToggles();
});
document.getElementById('settings-btn').addEventListener('click', function () {
  document.getElementById('settings-modal').classList.add('open');
});
document.getElementById('close-settings').addEventListener('click', function () {
  document.getElementById('settings-modal').classList.remove('open');
});

let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function beep(opts) {
  const freq = opts.freq || 440;
  const duration = opts.duration || 0.1;
  const type = opts.type || 'sine';
  const volume = opts.volume || 0.15;
  const sweep = opts.sweep || null;
  if (!settings.sound || !audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(sweep, audioCtx.currentTime + duration);
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}
function noiseSwing() {
  if (!settings.sound || !audioCtx) return;
  const bufferSize = audioCtx.sampleRate * 0.15;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 1500;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.2;
  src.connect(filter).connect(gain).connect(audioCtx.destination);
  src.start();
}
function playSwing() { noiseSwing(); }
function playClash() { beep({ freq: 1200, duration: 0.12, type: 'square', volume: 0.18, sweep: 400 }); }
function playHit() { beep({ freq: 180, duration: 0.15, type: 'sawtooth', volume: 0.2, sweep: 60 }); }
function playBlock() { beep({ freq: 700, duration: 0.08, type: 'square', volume: 0.14, sweep: 500 }); }
function playStep() { beep({ freq: 90, duration: 0.05, type: 'triangle', volume: 0.06 }); }
function playKO() { beep({ freq: 90, duration: 0.5, type: 'sawtooth', volume: 0.25, sweep: 30 }); }
let ambientStarted = false;
function startAmbient() {
  if (ambientStarted || !settings.sound) return;
  ensureAudio();
  ambientStarted = true;
  const drone = audioCtx.createOscillator();
  const droneGain = audioCtx.createGain();
  drone.type = 'sine';
  drone.frequency.value = 55;
  droneGain.gain.value = 0.02;
  drone.connect(droneGain).connect(audioCtx.destination);
  drone.start();
}

function haptic(kind) {
  try {
    if (!tg || !tg.HapticFeedback) return;
    if (kind === 'hit') tg.HapticFeedback.impactOccurred('rigid');
    else if (kind === 'light') tg.HapticFeedback.impactOccurred('light');
    else if (kind === 'ko') tg.HapticFeedback.notificationOccurred('error');
    else if (kind === 'win') tg.HapticFeedback.notificationOccurred('success');
  } catch (e) {}
}

document.getElementById('play-btn').addEventListener('click', function () {
  ensureAudio();
  startAmbient();
  document.getElementById('menu-screen').style.display = 'none';
});

const socket = io();
socket.emit('get_stats');
socket.emit('join_room', { roomId: roomId });

socket.on('stats_update', function (data) {
  document.getElementById('stat-online').textContent = data.online;
  document.getElementById('stat-games').textContent = data.totalGames;
});
socket.on('joined', function (data) {
  mySlot = data.slot;
  players = data.players;
  statusEl.textContent = 'Ждём соперника...';
});
socket.on('opponent_joined', function (data) { players = data.players; });
socket.on('start_game', function (data) {
  players = data.players;
  statusEl.textContent = '';
  koScreen.classList.remove('show');
  fallProgress[0] = 0;
  fallProgress[1] = 0;
  replay = null;
  history = [];
  floaters = [];
  bloodDecals[0] = [];
  bloodDecals[1] = [];
  countdown = { value: 3, startTime: performance.now() };
  updateBars();
});
socket.on('state_update', function (p) {
  players = p;
  updateBars();
});
socket.on('attack_anim', function (data) {
  attackFlashSlot = data.slot;
  attackFlashZone = data.zone;
  attackStartTime[data.slot] = performance.now();
  playSwing();
  const dur = data.power ? 380 : 220;
  setTimeout(function () { attackFlashSlot = null; attackFlashZone = null; }, dur);
});
socket.on('hit_landed', function (data) {
  playClash();
  setTimeout(playHit, 60);
  shake = (data.zone === 'head' ? 12 : 8) * (data.power ? 1.6 : 1);
  haptic(data.zone === 'head' ? 'ko' : 'hit');
  const p = Object.values(players).find(function (pl) { return pl.slot === data.targetSlot; });
  if (p) {
    spawnHitEffect(p, data.zone === 'head' || data.power, data.zone);
    addBloodDecal(p.slot, data.zone);
    const baseDmg = data.zone === 'leg' ? 9 : data.zone === 'head' ? 11 : 14;
    const dmg = data.power ? Math.round(baseDmg * 1.8) : baseDmg;
    const scale = cssW / 800;
    const zoneY = data.zone === 'head' ? cssH * 0.82 - 95 : data.zone === 'leg' ? cssH * 0.82 - 30 : cssH * 0.82 - 60;
    floaters.push({ x: p.x * scale, y: zoneY, text: '-' + dmg, life: 1, vy: -1.2 });
  }
});
socket.on('block_landed', function (data) {
  playBlock();
  shake = 4;
  haptic('light');
  blockFlashBody[data.targetSlot] = performance.now();
  blockFlashHead[data.targetSlot] = performance.now();
});
socket.on('attack_denied', function () {
  beep({ freq: 220, duration: 0.1, type: 'square', volume: 0.1 });
});
socket.on('knockout', function (data) {
  playKO();
  shake = 18;
  haptic(data.winnerSlot === mySlot ? 'win' : 'ko');
  const p = Object.values(players).find(function (pl) { return pl.slot === data.loserSlot; });
  if (p) spawnHitEffect(p, true, 'head');

  const frames = history.slice(-40);
  if (frames.length > 4) {
    replay = { frames: frames, index: 0, winnerSlot: data.winnerSlot, loserSlot: data.loserSlot };
  } else {
    scheduleKoScreen(data.winnerSlot);
  }
});
socket.on('room_full', function () { statusEl.textContent = 'Комната уже занята'; });
socket.on('opponent_left', function () { statusEl.textContent = 'Соперник вышел из боя'; });

document.getElementById('rematch-btn').addEventListener('click', function () {
  socket.emit('rematch');
});

function scheduleKoScreen(winnerSlot) {
  setTimeout(function () {
    koSub.textContent = winnerSlot === mySlot ? 'Ты победил нокаутом!' : 'Соперник победил нокаутом';
    koScreen.classList.add('show');
  }, 900);
}

function updateBars() {
  Object.values(players).forEach(function (p) {
    if (zoneBars.head[p.slot]) zoneBars.head[p.slot].style.width = p.head + '%';
    if (zoneBars.body[p.slot]) zoneBars.body[p.slot].style.width = p.body + '%';
    if (zoneBars.leg[p.slot]) zoneBars.leg[p.slot].style.width = p.legs + '%';
    if (stBars[p.slot]) stBars[p.slot].style.width = p.stamina + '%';
    if (winEls[p.slot]) winEls[p.slot].textContent = p.wins;
  });
}

// ---------- ЭФФЕКТЫ ----------
function addBloodDecal(slot, zone) {
  if (!settings.gore) return;
  if (!bloodDecals[slot]) bloodDecals[slot] = [];
  const list = bloodDecals[slot];
  if (list.length > 8) list.shift();
  const oy = zone === 'head' ? -78 + Math.random() * 10 : zone === 'leg' ? -15 + Math.random() * 10 : -48 + Math.random() * 14;
  const ox = -8 + Math.random() * 16;
  list.push({ zone: zone, ox: ox, oy: oy, r: 2.5 + Math.random() * 2.5 });
}

function spawnHitEffect(p, big, zone) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  const zoneY = zone === 'head' ? groundY - 78 : zone === 'leg' ? groundY - 15 : groundY - 45;
  const count = settings.gore ? (big ? 26 : 16) : (big ? 12 : 8);
  const color = settings.gore ? '#c8102e' : '#ffe066';
  for (let i = 0; i < count; i++) {
    particles.push({
      x: px, y: zoneY,
      vx: (Math.random() - 0.5) * (big ? 8 : 6), vy: -Math.random() * (big ? 7 : 5) - 1,
      life: 1, color: color, size: settings.gore ? 3 + Math.random() * 3 : 2 + Math.random() * 2,
      gravity: settings.gore ? 0.45 : 0.35,
    });
  }
  for (let i = 0; i < (big ? 16 : 10); i++) {
    const angle = Math.random() * Math.PI * 2;
    sparks.push({
      x: px, y: zoneY,
      vx: Math.cos(angle) * (2 + Math.random() * 4),
      vy: Math.sin(angle) * (2 + Math.random() * 4),
      life: 1,
    });
  }
  if (settings.gore) {
    bloodPools.push({ x: px, y: groundY, r: 0, maxR: big ? 26 : 14, life: 1 });
  }
}
function updateParticles() {
  particles.forEach(function (pt) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += pt.gravity || 0.35; pt.life -= 0.03; });
  particles = particles.filter(function (pt) { return pt.life > 0; });
  sparks.forEach(function (s) { s.x += s.vx; s.y += s.vy; s.life -= 0.06; });
  sparks = sparks.filter(function (s) { return s.life > 0; });
  bloodPools.forEach(function (b) { if (b.r < b.maxR) b.r += 0.6; b.life -= 0.003; });
  bloodPools = bloodPools.filter(function (b) { return b.life > 0; });
}
function drawParticles() {
  bloodPools.forEach(function (b) {
    ctx.globalAlpha = Math.min(b.life, 0.6);
    ctx.fillStyle = '#7a0d1a';
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, b.r, b.r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  particles.forEach(function (pt) {
    ctx.globalAlpha = Math.max(pt.life, 0);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    ctx.fill();
  });
  sparks.forEach(function (s) {
    ctx.globalAlpha = Math.max(s.life, 0);
    ctx.strokeStyle = '#fff6c8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.vx * 1.5, s.y - s.vy * 1.5);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

function drawGlove(cx, cy, angle, teamColor) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle || 0);
  ctx.fillStyle = teamColor;
  ctx.fillRect(-4, -9, 8, 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(-4, -9, 8, 6);
  const gGrad = ctx.createRadialGradient(-2, -2, 1, 0, 0, 8);
  gGrad.addColorStop(0, '#ff6b6b');
  gGrad.addColorStop(0.6, '#d81f2e');
  gGrad.addColorStop(1, '#8c0f1a');
  ctx.fillStyle = gGrad;
  ctx.beginPath();
  ctx.ellipse(0, 1, 7, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#c8182a';
  ctx.beginPath();
  ctx.ellipse(-6, -1, 3, 4, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-4, -3); ctx.lineTo(4, -3);
  ctx.moveTo(-4, 1); ctx.lineTo(4, 1);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(-2, -3, 2, 1.4, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawArenaBackground(groundY) {
  const g = ctx.createLinearGradient(0, 0, 0, cssH);
  g.addColorStop(0, '#1c2b3a');
  g.addColorStop(0.55, '#2c3b2c');
  g.addColorStop(0.55, '#4a3626');
  g.addColorStop(1, '#26160c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);

  const light = ctx.createRadialGradient(cssW / 2, 0, 20, cssW / 2, groundY, cssW * 0.7);
  light.addColorStop(0, 'rgba(255,255,255,0.18)');
  light.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.save();
  ctx.strokeStyle = 'rgba(200,200,200,0.25)';
  ctx.lineWidth = 2;
  const cx = cssW / 2;
  const cy = groundY - cssH * 0.16;
  const r = cssW * 0.62;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i - Math.PI / 8;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r * 0.32;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(180,180,180,0.12)';
  ctx.lineWidth = 1;
  for (let i = -6; i <= 6; i++) {
    ctx.beginPath();
    ctx.moveTo(cx + i * (cssW / 14), cy - cssH * 0.05);
    ctx.lineTo(cx + i * (cssW / 14), groundY);
    ctx.stroke();
  }
  ctx.restore();

  const floor = ctx.createLinearGradient(0, groundY, 0, cssH);
  floor.addColorStop(0, 'rgba(0,0,0,0.5)');
  floor.addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, groundY, cssW, cssH - groundY);

  ctx.strokeStyle = 'rgba(255,220,150,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(cssW, groundY);
  ctx.stroke();
}

function drawFighter(p, groundY, scale, isAttacking, swingT, zone) {
  const isBlocking = p.blockingBody || p.blockingHead;
  const x = p.x * scale;
  const y = groundY;
  const color = p.slot === 0 ? '#3f8a5c' : '#a13f3f';
  const colorDark = p.slot === 0 ? '#255c3a' : '#6e2323';
  const skin = '#e8b088';
  const skinDark = '#b87d54';

  if (fallProgress[p.slot] === undefined) fallProgress[p.slot] = 0;
  if (p.knockedOut && fallProgress[p.slot] < 1) {
    fallProgress[p.slot] = Math.min(1, fallProgress[p.slot] + 0.045);
  }
  const fallT = fallProgress[p.slot];
  const fallAngle = fallT * (Math.PI / 2) * p.facing * -1;
  const fallLift = Math.sin(fallT * Math.PI) * -8;

  const last = prevX[p.slot];
  const moving = !p.knockedOut && last !== undefined && Math.abs(x - last) > 0.3;
  prevX[p.slot] = x;
  if (!walkPhase[p.slot]) walkPhase[p.slot] = 0;
  if (moving) {
    walkPhase[p.slot] += 0.35;
    if (Math.floor(walkPhase[p.slot]) % 6 === 0) playStep();
  }
  const legSwingIdle = moving ? Math.sin(walkPhase[p.slot]) * 7 : 0;
  const bob = moving ? Math.abs(Math.sin(walkPhase[p.slot])) * 3 : 0;
  const blockGlow = (blockFlashBody[p.slot] && performance.now() - blockFlashBody[p.slot] < 200) ||
                     (blockFlashHead[p.slot] && performance.now() - blockFlashHead[p.slot] < 200);

  const kicking = isAttacking && zone === 'leg';
  const kickExt = kicking ? Math.sin(swingT * Math.PI) : 0;

  ctx.save();
  ctx.translate(x, y + fallLift);
  ctx.rotate(fallAngle);
  ctx.translate(-x, -y);

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(x, y + 3, 23, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // опорная нога
  const legGrad = ctx.createLinearGradient(x - 14, y - 28, x + 14, y);
  legGrad.addColorStop(0, '#241a12');
  legGrad.addColorStop(1, '#3a2a1c');
  ctx.fillStyle = legGrad;
  ctx.fillRect(x - 12 - legSwingIdle * 0.3, y - 30 - bob, 10, 16);
  ctx.fillRect(x - 11 - legSwingIdle * 0.5, y - 15 - bob, 8, 15);

  // ударная/передняя нога (может бить вперёд при kicking)
  ctx.save();
  ctx.translate(x + 8 + legSwingIdle * 0.3, y - 30 - bob);
  const kickAngle = p.facing * kickExt * 1.1;
  ctx.rotate(kickAngle);
  ctx.fillStyle = legGrad;
  ctx.fillRect(-5, 0, 10, 16 + kickExt * 10);
  ctx.fillRect(-4, 15, 8, 15);
  ctx.restore();

  const shT = y - 66 - bob, shB = y - 26 - bob;
  ctx.beginPath();
  ctx.moveTo(x - 17, shT);
  ctx.lineTo(x + 17, shT);
  ctx.lineTo(x + 11, shB);
  ctx.lineTo(x - 11, shB);
  ctx.closePath();
  const bodyGrad = ctx.createLinearGradient(x - 17, shT, x + 17, shB);
  bodyGrad.addColorStop(0, isBlocking ? '#5a80b8' : color);
  bodyGrad.addColorStop(1, isBlocking ? '#25406e' : colorDark);
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.strokeStyle = blockGlow ? 'rgba(120,180,255,0.9)' : 'rgba(0,0,0,0.3)';
  ctx.lineWidth = blockGlow ? 3 : 1.3;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, shT + 6);
  ctx.lineTo(x, shB - 2);
  ctx.stroke();

  ctx.fillStyle = colorDark;
  ctx.fillRect(x - 13, shB - 2, 26, 10);

  // накопленные пятна крови (только при включённой расчленёнке)
  if (settings.gore && bloodDecals[p.slot]) {
    bloodDecals[p.slot].forEach(function (d) {
      ctx.fillStyle = 'rgba(122,13,26,0.75)';
      ctx.beginPath();
      ctx.ellipse(x + d.ox, y + d.oy - bob, d.r, d.r * 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  ctx.fillStyle = skinDark;
  ctx.fillRect(x - p.facing * 21 - 3, y - 63 - bob, 6, 12);
  ctx.fillStyle = colorDark;
  ctx.fillRect(x - p.facing * 21 - 3, y - 52 - bob, 6, 12);
  drawGlove(x - p.facing * 21, y - 38 - bob, 0, colorDark);

  ctx.fillStyle = skinDark;
  ctx.fillRect(x - 4, y - 70 - bob, 8, 6);
  const headGrad = ctx.createRadialGradient(x - 5, y - 84 - bob, 2, x, y - 79 - bob, 14);
  headGrad.addColorStop(0, skin);
  headGrad.addColorStop(1, skinDark);
  ctx.fillStyle = headGrad;
  ctx.beginPath();
  ctx.arc(x, y - 80 - bob, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2a1c12';
  ctx.beginPath();
  ctx.arc(x, y - 87 - bob, 13, Math.PI, 0);
  ctx.fill();

  ctx.fillStyle = '#1a1410';
  if (p.knockedOut) {
    ctx.beginPath();
    ctx.moveTo(x - 6, y - 83 - bob); ctx.lineTo(x - 2, y - 79 - bob);
    ctx.moveTo(x - 2, y - 83 - bob); ctx.lineTo(x - 6, y - 79 - bob);
    ctx.moveTo(x + 2, y - 83 - bob); ctx.lineTo(x + 6, y - 79 - bob);
    ctx.moveTo(x + 6, y - 83 - bob); ctx.lineTo(x + 2, y - 79 - bob);
    ctx.strokeStyle = '#1a1410';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    const eyeShift = p.facing * 4;
    ctx.beginPath();
    ctx.arc(x + eyeShift - 3, y - 81 - bob, 1.6, 0, Math.PI * 2);
    ctx.arc(x + eyeShift + 3, y - 81 - bob, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  if (!p.knockedOut) {
    const shoulderX = x + p.facing * 15;
    const shoulderY = y - 63 - bob;

    const guardAngle = isBlocking
      ? (p.facing === 1 ? -1.35 : Math.PI + 1.35)
      : (p.facing === 1 ? -0.95 : Math.PI + 0.95);
    const punchAngle = p.facing === 1 ? -0.08 : Math.PI + 0.08;
    const punching = isAttacking && (zone === 'head' || zone === 'body');
    const extension = punching ? Math.sin(swingT * Math.PI) : 0;
    const armAngle = guardAngle + (punchAngle - guardAngle) * extension;

    const upperLen = 11;
    const forearmBase = 11;
    const forearmExtra = 20 * extension;
    const forearmLen = forearmBase + forearmExtra;

    ctx.save();
    ctx.translate(shoulderX, shoulderY);
    ctx.rotate(armAngle);

    const armGrad = ctx.createLinearGradient(-4, 0, 4, upperLen);
    armGrad.addColorStop(0, color);
    armGrad.addColorStop(1, colorDark);
    ctx.fillStyle = armGrad;
    ctx.beginPath();
    ctx.ellipse(0, upperLen / 2, 5, upperLen / 2 + 1, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(0, upperLen);
    ctx.fillStyle = skinDark;
    ctx.fillRect(-3.5, 0, 7, forearmLen);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-3.5, 0, 7, forearmLen);

    if (punching && extension > 0.15) {
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.4 * extension) + ')';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, forearmLen * 0.2);
      ctx.lineTo(0, forearmLen * 0.85);
      ctx.stroke();
    }

    drawGlove(0, forearmLen, 0, colorDark);
    ctx.restore();
  }

  ctx.restore();
}

function pushHistory() {
  const snap = { p: {} };
  Object.keys(players).forEach(function (id) {
    const p = players[id];
    snap.p[p.slot] = { x: p.x, facing: p.facing, blockingBody: p.blockingBody, blockingHead: p.blockingHead };
  });
  snap.atkSlot = attackFlashSlot;
  snap.atkZone = attackFlashZone;
  snap.atkT = attackFlashSlot !== null && attackStartTime[attackFlashSlot]
    ? Math.min((performance.now() - attackStartTime[attackFlashSlot]) / 220, 1)
    : 0;
  history.push(snap);
  if (history.length > HISTORY_MAX) history.shift();
}

function drawReplay(groundY, scale) {
  const frame = replay.frames[Math.floor(replay.index)];
  if (!frame) { const w = replay.winnerSlot; replay = null; scheduleKoScreen(w); return; }

  const p0 = frame.p[0], p1 = frame.p[1];
  const midX = ((p0 ? p0.x : 0) + (p1 ? p1.x : 0)) / 2 * scale;

  ctx.save();
  const zoom = 1.6;
  ctx.translate(cssW / 2, cssH * 0.55);
  ctx.scale(zoom, zoom);
  ctx.translate(-midX, -cssH * 0.55);

  drawArenaBackground(groundY);
  [p0, p1].forEach(function (pd, slot) {
    if (!pd) return;
    const isAtk = frame.atkSlot === slot;
    drawFighter({ x: pd.x, facing: pd.facing, slot: slot, blockingBody: pd.blockingBody, blockingHead: pd.blockingHead, knockedOut: false },
      groundY, scale, isAtk, frame.atkT, frame.atkZone);
  });
  ctx.restore();

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#ff3b3b';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 8;
  ctx.fillText('⏪ ПОВТОР', cssW / 2, 40);
  ctx.shadowBlur = 0;

  replay.index += 0.45;
  if (replay.index >= replay.frames.length) {
    const winnerSlot = replay.winnerSlot;
    replay = null;
    scheduleKoScreen(winnerSlot);
  }
}

function updateFloaters() {
  floaters.forEach(function (f) { f.y += f.vy; f.life -= 0.02; });
  floaters = floaters.filter(function (f) { return f.life > 0; });
}
function drawFloaters() {
  floaters.forEach(function (f) {
    ctx.globalAlpha = Math.max(f.life, 0);
    ctx.fillStyle = '#ffe066';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.fillText(f.text, f.x, f.y);
    ctx.shadowBlur = 0;
  });
  ctx.globalAlpha = 1;
}

function drawLowHpVignette() {
  if (mySlot === null || !players) return;
  const me = Object.values(players).find(function (p) { return p.slot === mySlot; });
  if (!me || me.knockedOut) return;
  if (me.head > 30) return;
  const t = 1 - me.head / 30;
  const pulse = 0.25 + 0.2 * Math.abs(Math.sin(performance.now() / 220));
  const g = ctx.createRadialGradient(cssW / 2, cssH / 2, cssH * 0.25, cssW / 2, cssH / 2, cssH * 0.7);
  g.addColorStop(0, 'rgba(180,0,0,0)');
  g.addColorStop(1, 'rgba(180,0,0,' + (t * pulse) + ')');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);
}

function drawCountdown() {
  if (!countdown) return;
  const elapsed = (performance.now() - countdown.startTime) / 1000;
  const step = Math.floor(elapsed);
  const value = 3 - step;
  const localT = elapsed - step;
  if (value <= 0) {
    if (elapsed < 3.7) {
      ctx.save();
      const t = elapsed - 3;
      ctx.globalAlpha = Math.max(0, 1 - t / 0.7);
      ctx.fillStyle = '#ff3b3b';
      ctx.font = 'bold ' + (34 + t * 14) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 10;
      ctx.fillText('БОЙ!', cssW / 2, cssH / 2);
      ctx.restore();
    } else {
      countdown = null;
    }
    return;
  }
  ctx.save();
  const scalePulse = 1 + (1 - localT) * 0.5;
  ctx.globalAlpha = 1 - localT * 0.3;
  ctx.translate(cssW / 2, cssH / 2);
  ctx.scale(scalePulse, scalePulse);
  ctx.fillStyle = '#ffe066';
  ctx.font = 'bold 46px sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 12;
  ctx.fillText(String(value), 0, 16);
  ctx.restore();
}

function draw() {
  ctx.save();
  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake *= 0.85;
    if (shake < 0.5) shake = 0;
  }

  ctx.clearRect(-20, -20, cssW + 40, cssH + 40);
  const scale = cssW / 800;
  const groundY = cssH * 0.82;

  if (replay) {
    drawReplay(groundY, scale);
  } else {
    drawArenaBackground(groundY);
    pushHistory();
    Object.values(players).forEach(function (p) {
      const isAttacking = attackFlashSlot === p.slot;
      let swingT = 0;
      if (isAttacking && attackStartTime[p.slot]) {
        swingT = Math.min((performance.now() - attackStartTime[p.slot]) / 220, 1);
      }
      drawFighter(p, groundY, scale, isAttacking, swingT, isAttacking ? attackFlashZone : null);
    });
    updateParticles();
    drawParticles();
    updateFloaters();
    drawFloaters();
    drawLowHpVignette();
    drawCountdown();
  }

  ctx.restore();
  requestAnimationFrame(draw);
}
draw();

// ---------- ДЖОЙСТИК ----------
const zone = document.getElementById('joystick-zone');
const knob = document.getElementById('joystick-knob');
let dragging = false;
let moveInterval = null;
let currentDir = 0;

function setKnob(dx) {
  const max = 30;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = 30 + clampedX + 'px';
  knob.style.top = '30px';
}
function startMoveLoop() {
  if (moveInterval) return;
  moveInterval = setInterval(function () {
    if (currentDir !== 0 && !countdown) socket.emit('move', { dir: currentDir });
  }, 40);
}
function stopMoveLoop() { clearInterval(moveInterval); moveInterval = null; }
function handleStart() { ensureAudio(); dragging = true; startMoveLoop(); }
function handleMove(e) {
  if (!dragging) return;
  const touch = e.touches ? e.touches[0] : e;
  const rect = zone.getBoundingClientRect();
  const dx = touch.clientX - (rect.left + rect.width / 2);
  setKnob(dx);
  currentDir = dx > 15 ? 1 : dx < -15 ? -1 : 0;
}
function handleEnd() { dragging = false; currentDir = 0; knob.style.left = '30px'; stopMoveLoop(); }

zone.style.touchAction = 'none';
zone.addEventListener('pointerdown', function (e) { handleStart(); zone.setPointerCapture && zone.setPointerCapture(e.pointerId); });
zone.addEventListener('pointermove', handleMove);
zone.addEventListener('pointerup', handleEnd);
zone.addEventListener('pointercancel', handleEnd);
zone.addEventListener('pointerleave', handleEnd);

// ---------- БЛОК (L2 = тело, R2 = голова) ----------
function bindHoldButton(el, onStart, onEnd) {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    ensureAudio();
    el.classList.add('active');
    onStart();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evt) {
    el.addEventListener(evt, function (e) {
      e.preventDefault();
      el.classList.remove('active');
      onEnd();
    });
  });
}

const l2Btn = document.getElementById('l2-btn');
const r2Btn = document.getElementById('r2-btn');
bindHoldButton(l2Btn,
  function () { socket.emit('block_start', { zone: 'body' }); },
  function () { socket.emit('block_end', { zone: 'body' }); });
bindHoldButton(r2Btn,
  function () { socket.emit('block_start', { zone: 'head' }); },
  function () { socket.emit('block_end', { zone: 'head' }); });

// ---------- УДАРЫ: △ правая рука (голова), □ левая рука (тело), ✕ правая нога, ○ левая нога ----------
function bindTapButton(el, onTap) {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    ensureAudio();
    el.classList.add('active');
    if (!countdown) onTap();
    setTimeout(function () { el.classList.remove('active'); }, 120);
  });
}

bindTapButton(document.getElementById('tri-btn'), function () { socket.emit('attack', { zone: 'head' }); });
bindTapButton(document.getElementById('sq-btn'), function () { socket.emit('attack', { zone: 'body' }); });
bindTapButton(document.getElementById('cross-btn'), function () { socket.emit('attack', { zone: 'leg' }); });
bindTapButton(document.getElementById('circle-btn'), function () { socket.emit('attack', { zone: 'leg' }); });

// ---------- УСИЛЕННЫЕ УДАРЫ: L1 = мощный по голове, R1 = мощный по ногам ----------
bindTapButton(document.getElementById('l1-btn'), function () { socket.emit('attack', { zone: 'head', power: true }); });
bindTapButton(document.getElementById('r1-btn'), function () { socket.emit('attack', { zone: 'leg', power: true }); });

