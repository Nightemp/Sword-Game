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
setTimeout(resize, 300);
if (tg) {
  tg.onEvent('viewportChanged', resize);
}

const statusEl = document.getElementById('status');
const hpBars = [document.getElementById('hp0'), document.getElementById('hp1')];

let mySlot = null;
let players = {};
let attackFlashSlot = null;
let attackStartTime = {};
const prevX = {};
const walkPhase = {};
let particles = [];
let sparks = [];
let shake = 0;

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
soundToggle.addEventListener('click', () => {
  settings.sound = !settings.sound;
  localStorage.setItem('sword_sound', settings.sound ? 'on' : 'off');
  syncToggles();
});
goreToggle.addEventListener('click', () => {
  settings.gore = !settings.gore;
  localStorage.setItem('sword_gore', settings.gore ? 'on' : 'off');
  syncToggles();
});
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.add('open');
});
document.getElementById('close-settings').addEventListener('click', () => {
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
function playStep() { beep({ freq: 90, duration: 0.05, type: 'triangle', volume: 0.06 }); }
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
});
socket.on('state_update', function (p) {
  players = p;
  updateHpBars();
});
socket.on('attack_anim', function (data) {
  attackFlashSlot = data.slot;
  attackStartTime[data.slot] = performance.now();
  playSwing();
  setTimeout(function () { attackFlashSlot = null; }, 220);
});
socket.on('hit_landed', function (data) {
  playClash();
  setTimeout(playHit, 60);
  shake = 10;
  const p = Object.values(players).find(function (pl) { return pl.slot === data.targetSlot; });
  if (p) spawnHitEffect(p);
});
socket.on('room_full', function () { statusEl.textContent = 'Комната уже занята'; });
socket.on('opponent_left', function () { statusEl.textContent = 'Соперник вышел из боя'; });
socket.on('game_over', function (data) {
  statusEl.textContent = data.winnerSlot === mySlot ? '🏆 Победа!' : '💀 Поражение';
});

function updateHpBars() {
  Object.values(players).forEach(function (p) {
    if (hpBars[p.slot]) hpBars[p.slot].style.width = p.hp + '%';
  });
}

function spawnHitEffect(p) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  const count = settings.gore ? 16 : 8;
  const color = settings.gore ? '#d81e2c' : '#ffe066';
  for (let i = 0; i < count; i++) {
    particles.push({
      x: px, y: groundY - 55,
      vx: (Math.random() - 0.5) * 6, vy: -Math.random() * 5 - 1,
      life: 1, color: color, size: settings.gore ? 3 + Math.random() * 3 : 2 + Math.random() * 2,
    });
  }
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    sparks.push({
      x: px, y: groundY - 55,
      vx: Math.cos(angle) * (2 + Math.random() * 4),
      vy: Math.sin(angle) * (2 + Math.random() * 4),
      life: 1,
    });
  }
}
function updateParticles() {
  particles.forEach(function (pt) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.35; pt.life -= 0.03; });
  particles = particles.filter(function (pt) { return pt.life > 0; });
  sparks.forEach(function (s) { s.x += s.vx; s.y += s.vy; s.life -= 0.06; });
  sparks = sparks.filter(function (s) { return s.life > 0; });
}
function drawParticles() {
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
  drawArenaBackground(groundY);

  Object.values(players).forEach(function (p) {
    const x = p.x * scale;
    const y = groundY;
    const color = p.slot === 0 ? '#3f8a5c' : '#a13f3f';
    const colorDark = p.slot === 0 ? '#255c3a' : '#6e2323';

    const last = prevX[p.slot];
    const moving = last !== undefined && Math.abs(x - last) > 0.3;
    prevX[p.slot] = x;
    if (!walkPhase[p.slot]) walkPhase[p.slot] = 0;
    if (moving) {
      walkPhase[p.slot] += 0.35;
      if (Math.floor(walkPhase[p.slot]) % 6 === 0) playStep();
    }
    const legSwing = moving ? Math.sin(walkPhase[p.slot]) * 6 : 0;
    const bob = moving ? Math.abs(Math.sin(walkPhase[p.slot])) * 3 : 0;

    const isAttacking = attackFlashSlot === p.slot;
    let swingT = 0;
    if (isAttacking && attackStartTime[p.slot]) {
      swingT = Math.min((performance.now() - attackStartTime[p.slot]) / 220, 1);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(x, y + 3, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    const legGrad = ctx.createLinearGradient(x - 12, y - 25, x + 12, y);
    legGrad.addColorStop(0, '#1a1410');
    legGrad.addColorStop(1, '#332820');
    ctx.fillStyle = legGrad;
    ctx.fillRect(x - 12 + legSwing * 0.3, y - 25 - bob, 9, 25);
    ctx.fillRect(x + 3 - legSwing * 0.3, y - 25 - bob, 9, 25);

    const bodyGrad = ctx.createLinearGradient(x - 15, y - 60, x + 15, y - 20);
    bodyGrad.addColorStop(0, color);
    bodyGrad.addColorStop(1, colorDark);
    ctx.fillStyle = bodyGrad;
    ctx.fillRect(x - 15, y - 60 - bob, 30, 40);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 15, y - 60 - bob, 30, 40);

    ctx.fillStyle = colorDark;
    ctx.fillRect(x - p.facing * 20 - 3, y - 58 - bob, 6, 22);
    ctx.fillStyle = '#c94848';
    ctx.beginPath();
    ctx.arc(x - p.facing * 20, y - 36 - bob, 5, 0, Math.PI * 2);
    ctx.fill();

    const headGrad = ctx.createRadialGradient(x - 5, y - 80 - bob, 2, x, y - 75 - bob, 16);
    headGrad.addColorStop(0, '#f4cba0');
    headGrad.addColorStop(1, '#c98f5f');
    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(x, y - 75 - bob, 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1a1410';
    const eyeShift = p.facing * 4;
    ctx.beginPath();
    ctx.arc(x + eyeShift - 3, y - 77 - bob, 1.8, 0, Math.PI * 2);
    ctx.arc(x + eyeShift + 3, y - 77 - bob, 1.8, 0, Math.PI * 2);
    ctx.fill();

    const shoulderX = x + p.facing * 18;
    const shoulderY = y - 58 - bob;
    const baseAngle = p.facing === 1 ? -0.35 : Math.PI + 0.35;
    const swingAngle = isAttacking
      ? baseAngle - p.facing * Math.sin(swingT * Math.PI) * 1.6
      : baseAngle;

    ctx.save();
    ctx.translate(shoulderX, shoulderY);
    ctx.rotate(swingAngle);

    ctx.fillStyle = colorDark;
    ctx.fillRect(-3, 0, 6, 20);
    ctx.fillStyle = '#c94848';
    ctx.beginPath();
    ctx.arc(0, 20, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(0, 22);
    ctx.fillStyle = '#3a2a18';
    ctx.fillRect(-2, 0, 4, 9);
    ctx.fillStyle = '#8a7a5c';
    ctx.fillRect(-9, 8, 18, 4);

    if (isAttacking) {
      ctx.shadowColor = '#ffe066';
      ctx.shadowBlur = 14;
    }
    const bladeGrad = ctx.createLinearGradient(0, 12, 0, 12 + 46);
    bladeGrad.addColorStop(0, isAttacking ? '#fff8d6' : '#eef3f5');
    bladeGrad.addColorStop(0.5, isAttacking ? '#ffe066' : '#c3ccd1');
    bladeGrad.addColorStop(1, isAttacking ? '#ffb703' : '#8b969c');
    ctx.fillStyle = bladeGrad;
    ctx.beginPath();
    ctx.moveTo(-4, 12);
    ctx.lineTo(4, 12);
    ctx.lineTo(2, 12 + 46);
    ctx.lineTo(0, 12 + 55);
    ctx.lineTo(-2, 12 + 46);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    if (isAttacking) {
      ctx.strokeStyle = 'rgba(255,224,102,' + (0.55 * (1 - swingT)) + ')';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, -12, 58, -1.4, 0.6);
      ctx.stroke();
    }
    ctx.restore();
  });

  updateParticles();
  drawParticles();
  ctx.restore();

  requestAnimationFrame(draw);
}
draw();

const zone = document.getElementById('joystick-zone');
const knob = document.getElementById('joystick-knob');
let dragging = false;
let moveInterval = null;
let currentDir = 0;

function setKnob(dx) {
  const max = 35;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = 35 + clampedX + 'px';
  knob.style.top = '35px';
}

function startMoveLoop() {
  if (moveInterval) return;
  moveInterval = setInterval(function () {
    if (currentDir !== 0) socket.emit('move', { dir: currentDir });
  }, 50);
}
function stopMoveLoop() {
  clearInterval(moveInterval);
  moveInterval = null;
}

function handleStart(e) {
  e.preventDefault();
  ensureAudio();
  dragging = true;
  startMoveLoop();
}
function handleMove(e) {
  if (!dragging) return;
  const touch = e.touches ? e.touches[0] : e;
  const rect = zone.getBoundingClientRect();
  const dx = touch.clientX - (rect.left + rect.width / 2);
  setKnob(dx);
  currentDir = dx > 15 ? 1 : dx < -15 ? -1 : 0;
}
function handleEnd() {
  dragging = false;
  currentDir = 0;
  knob.style.left = '35px';
  stopMoveLoop();
}

zone.addEventListener('touchstart', handleStart, { passive: false });
zone.addEventListener('touchmove', handleMove, { passive: false });
zone.addEventListener('touchend', handleEnd);
zone.addEventListener('mousedown', handleStart);
window.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

const attackBtn = document.getElementById('attack-btn');
function doAttack(e) {
  e.preventDefault();
  ensureAudio();
  socket.emit('attack');
}
attackBtn.addEventListener('touchstart', doAttack, { passive: false });
attackBtn.addEventListener('mousedown', doAttack);
