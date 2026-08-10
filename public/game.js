const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || tg?.initDataUnsafe?.start_param || 'default';

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');
function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
window.addEventListener('resize', resize);
resize();

const statusEl = document.getElementById('status');
const hpBars = [document.getElementById('hp0'), document.getElementById('hp1')];

let mySlot = null;
let players = {};
let attackFlashSlot = null;
let attackStartTime = {};
const prevX = {};
const walkPhase = {};
let particles = [];

// ---------- НАСТРОЙКИ ----------
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

// ---------- ЗВУК (синтез, без внешних файлов) ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function beep({ freq = 440, duration = 0.1, type = 'sine', volume = 0.15, sweep = null }) {
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

// ---------- МЕНЮ ----------
document.getElementById('play-btn').addEventListener('click', () => {
  ensureAudio();
  startAmbient();
  document.getElementById('menu-screen').style.display = 'none';
});

// ---------- SOCKET ----------
const socket = io();
socket.emit('get_stats');
socket.emit('join_room', { roomId });

socket.on('stats_update', ({ online, totalGames }) => {
  document.getElementById('stat-online').textContent = online;
  document.getElementById('stat-games').textContent = totalGames;
});

socket.on('joined', (data) => {
  mySlot = data.slot;
  players = data.players;
  statusEl.textContent = 'Ждём соперника...';
});

socket.on('opponent_joined', (data) => {
  players = data.players;
});

socket.on('start_game', (data) => {
  players = data.players;
  statusEl.textContent = '';
});

socket.on('state_update', (p) => {
  players = p;
  updateHpBars();
});

socket.on('attack_anim', ({ slot }) => {
  attackFlashSlot = slot;
  attackStartTime[slot] = performance.now();
  playSwing();
  setTimeout(() => (attackFlashSlot = null), 220);
});

socket.on('hit_landed', ({ targetSlot }) => {
  playClash();
  setTimeout(playHit, 60);
  const p = Object.values(players).find((pl) => pl.slot === targetSlot);
  if (p) spawnHitEffect(p);
});

socket.on('room_full', () => {
  statusEl.textContent = 'Комната уже занята';
});

socket.on('opponent_left', () => {
  statusEl.textContent = 'Соперник вышел из боя';
});

socket.on('game_over', ({ winnerSlot }) => {
  statusEl.textContent = winnerSlot === mySlot ? '🏆 Победа!' : '💀 Поражение';
});

function updateHpBars() {
  Object.values(players).forEach((p) => {
    if (hpBars[p.slot]) hpBars[p.slot].style.width = p.hp + '%';
  });
}

// ---------- ЭФФЕКТЫ ----------
function spawnHitEffect(p) {
  const scale = canvas.width / 800;
  const px = p.x * scale;
  const groundY = canvas.height * 0.82;
  const count = settings.gore ? 14 : 6;
  const color = settings.gore ? '#c1121f' : '#ffe066';
  for (let i = 0; i < count; i++) {
    particles.push({
      x: px,
      y: groundY - 55,
      vx: (Math.random() - 0.5) * 6,
      vy: -Math.random() * 5 - 1,
      life: 1,
      color,
      size: settings.gore ? 3 + Math.random() * 3 : 2 + Math.random() * 2,
    });
  }
}
function updateParticles() {
  particles.forEach((pt) => {
    pt.x += pt.vx;
    pt.y += pt.vy;
    pt.vy += 0.35;
    pt.life -= 0.03;
  });
  particles = particles.filter((pt) => pt.life > 0);
}
function drawParticles() {
  particles.forEach((pt) => {
    ctx.globalAlpha = Math.max(pt.life, 0);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
}

// ---------- ОТРИСОВКА ----------
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = canvas.width / 800;
  const groundY = canvas.height * 0.82;

  // линия земли
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(canvas.width, groundY);
  ctx.stroke();

  Object.values(players).forEach((p) => {
    const x = p.x * scale;
    const y = groundY;
    const color = p.slot === 0 ? '#4a7c59' : '#7c4a4a';

    // определяем, движется ли персонаж (для анимации ходьбы)
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

    // ноги (с покачиванием при ходьбе)
    ctx.fillStyle = '#2b2320';
    ctx.fillRect(x - 12 + legSwing * 0.3, y - 25 - bob, 9, 25);
    ctx.fillRect(x + 3 - legSwing * 0.3, y - 25 - bob, 9, 25);

    // тело
    ctx.fillStyle = color;
    ctx.fillRect(x - 15, y - 60 - bob, 30, 40);

    // рука без меча
    ctx.fillStyle = color;
    ctx.fillRect(x - p.facing * 20 - 3, y - 58 - bob, 6, 26);

    // голова
    ctx.fillStyle = '#e8b88a';
    ctx.beginPath();
    ctx.arc(x, y - 75 - bob, 15, 0, Math.PI * 2);
    ctx.fill();

    // глаза
    ctx.fillStyle = '#1a1410';
    const eyeShift = p.facing * 4;
    ctx.beginPath();
    ctx.arc(x + eyeShift - 3, y - 77 - bob, 1.8, 0, Math.PI * 2);
    ctx.arc(x + eyeShift + 3, y - 77 - bob, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // рука с мечом + сам меч (анимация замаха)
    const shoulderX = x + p.facing * 18;
    const shoulderY = y - 58 - bob;
    const baseAngle = p.facing === 1 ? -0.35 : Math.PI + 0.35;
    const swingAngle = isAttacking
      ? baseAngle - p.facing * Math.sin(swingT * Math.PI) * 1.6
      : baseAngle;

    ctx.save();
    ctx.translate(shoulderX, shoulderY);
    ctx.rotate(swingAngle);

    // рука
    ctx.fillStyle = color;
    ctx.fillRect(-3, 0, 6, 22);

    // меч: рукоять + гарда + клинок
    ctx.translate(0, 20);
    ctx.fillStyle = '#3a2a18';
    ctx.fillRect(-2, 0, 4, 10);
    ctx.fillStyle = '#7a6a50';
    ctx.fillRect(-8, 9, 16, 4);
    const bladeGrad = ctx.createLinearGradient(0, 13, 0, 13 + 46);
    bladeGrad.addColorStop(0, isAttacking ? '#fff6c8' : '#dfe6ea');
    bladeGrad.addColorStop(1, isAttacking ? '#ffe066' : '#aeb8bd');
    ctx.fillStyle = bladeGrad;
    ctx.beginPath();
    ctx.moveTo(-4, 13);
    ctx.lineTo(4, 13);
    ctx.lineTo(2, 13 + 46);
    ctx.lineTo(0, 13 + 54);
    ctx.lineTo(-2, 13 + 46);
    ctx.closePath();
    ctx.fill();

    // след взмаха
    if (isAttacking) {
      ctx.strokeStyle = `rgba(255,224,102,${0.5 * (1 - swingT)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 55, -1.4, 0.6);
      ctx.stroke();
    }
    ctx.restore();
  });

  updateParticles();
  drawParticles();

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
  const max = 35;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = 35 + clampedX + 'px';
  knob.style.top = '35px';
}

function startMoveLoop() {
  if (moveInterval) return;
  moveInterval = setInterval(() => {
    if (currentDir !== 0) socket.emit('move', { dir: currentDir });
  }, 40);
}
function stopMoveLoop() {
  clearInterval(moveInterval);
  moveInterval = null;
}

function handleStart() {
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

zone.addEventListener('touchstart', handleStart);
zone.addEventListener('touchmove', handleMove);
zone.addEventListener('touchend', handleEnd);
zone.addEventListener('mousedown', handleStart);
window.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

// ---------- КНОПКА УДАРА ----------
const attackBtn = document.getElementById('attack-btn');
function doAttack(e) {
  e.preventDefault();
  ensureAudio();
  socket.emit('attack');
}
attackBtn.addEventListener('touchstart', doAttack);
attackBtn.addEventListener('mousedown', doAttack);