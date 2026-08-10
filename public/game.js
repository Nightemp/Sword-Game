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
setTimeout(resize, 300);
if (tg) {
  tg.onEvent('viewportChanged', resize);
}

const statusEl = document.getElementById('status');
const hpBars = [document.getElementById('hp0'), document.getElementById('hp1')];

let mySlot = null;
let players = {};
let attackFlashSlot = null;
let prevHp = {};
let bloodEffects = [];
let sparkEffects = [];
let screenShake = 0;

function spawnBlood(x, y) {
  for (let i = 0; i < 14; i++) {
    bloodEffects.push({
      x, y,
      vx: (Math.random() - 0.5) * 5,
      vy: -Math.random() * 4 - 1,
      life: 34,
      maxLife: 34,
      size: Math.random() * 3.2 + 1.8
    });
  }
}

function spawnSparks(x, y, facing) {
  for (let i = 0; i < 10; i++) {
    sparkEffects.push({
      x, y,
      vx: facing * (Math.random() * 5 + 2),
      vy: (Math.random() - 0.5) * 5,
      life: 16,
      maxLife: 16,
      size: Math.random() * 2 + 1
    });
  }
}

const socket = io();

const onlineCountEl = document.getElementById('online-count');
socket.on('online_count', (count) => {
  onlineCountEl.textContent = count;
});

const menuOverlay = document.getElementById('menu-overlay');
const playBtn = document.getElementById('play-btn');

playBtn.addEventListener('click', () => {
  if (playBtn.textContent === 'ИГРАТЬ СНОВА') {
    location.reload();
    return;
  }
  menuOverlay.style.display = 'none';
  socket.emit('join_room', { roomId });
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
  const scale = canvas.width / 800;
  Object.values(p).forEach(np => {
    const old = prevHp[np.slot];
    if (old !== undefined && np.hp < old) {
      const hitX = np.x * scale;
      const hitY = canvas.height - 65;
      spawnBlood(hitX, hitY);
      spawnSparks(hitX, hitY, -np.facing);
      screenShake = 8;
    }
    prevHp[np.slot] = np.hp;
  });
  players = p;
  updateHpBars();
});

socket.on('attack_anim', ({ slot }) => {
  attackFlashSlot = slot;
  setTimeout(() => (attackFlashSlot = null), 200);
});

socket.on('room_full', () => {
  statusEl.textContent = 'Комната уже занята';
});

socket.on('opponent_left', () => {
  statusEl.textContent = 'Соперник вышел из боя';
});

socket.on('game_over', ({ winnerSlot }) => {
  statusEl.textContent = winnerSlot === mySlot ? '🏆 Победа!' : '💀 Поражение';
  setTimeout(() => {
    playBtn.textContent = 'ИГРАТЬ СНОВА';
    menuOverlay.style.display = 'flex';
  }, 1500);
});

function updateHpBars() {
  Object.values(players).forEach(p => {
    if (hpBars[p.slot]) hpBars[p.slot].style.width = p.hp + '%';
  });
}

// ---------- ФОН АРЕНЫ ----------
function drawBackground() {
  const w = canvas.width, h = canvas.height;

  // небо
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#2b1f3a');
  sky.addColorStop(0.5, '#5a3a52');
  sky.addColorStop(1, '#c97b5a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h * 0.62);

  // солнце/луна
  const sunX = w * 0.78, sunY = h * 0.22, sunR = Math.min(w, h) * 0.09;
  const sunGlow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 2.4);
  sunGlow.addColorStop(0, 'rgba(255,210,140,0.55)');
  sunGlow.addColorStop(1, 'rgba(255,210,140,0)');
  ctx.fillStyle = sunGlow;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffe3ad';
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
  ctx.fill();

  // дальние горы
  ctx.fillStyle = '#241a2e';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5);
  for (let x = 0; x <= w; x += w / 8) {
    const peak = h * 0.5 - Math.sin(x * 0.008 + 1) * h * 0.06 - h * 0.03;
    ctx.lineTo(x, peak);
  }
  ctx.lineTo(w, h * 0.62);
  ctx.lineTo(0, h * 0.62);
  ctx.closePath();
  ctx.fill();

  // ближние холмы
  ctx.fillStyle = '#3a2a2a';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.6);
  for (let x = 0; x <= w; x += w / 6) {
    const peak = h * 0.6 - Math.sin(x * 0.01 + 3) * h * 0.035;
    ctx.lineTo(x, peak);
  }
  ctx.lineTo(w, h * 0.66);
  ctx.lineTo(0, h * 0.66);
  ctx.closePath();
  ctx.fill();

  // земля арены
  const ground = ctx.createLinearGradient(0, h * 0.6, 0, h);
  ground.addColorStop(0, '#6b5644');
  ground.addColorStop(0.15, '#4a3b2f');
  ground.addColorStop(1, '#241c16');
  ctx.fillStyle = ground;
  ctx.fillRect(0, h * 0.6, w, h * 0.4);

  // текстура земли — трещины/полосы
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const y = h * 0.65 + i * (h * 0.35 / 6);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + Math.sin(i) * 6);
    ctx.stroke();
  }

  // виньетка
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

function drawFighter(p, scale) {
  const x = p.x * scale;
  const y = canvas.height - 5;
  const isFlash = attackFlashSlot === p.slot;
  const bodyColor = p.slot === 0 ? '#3f7a4f' : '#8a3d3d';
  const bodyShade = p.slot === 0 ? '#2b5638' : '#602a2a';
  const skin = '#e8b88a';

  // тень
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 22, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // плащ/накидка сзади
  ctx.fillStyle = bodyShade;
  ctx.beginPath();
  ctx.moveTo(x - 12 * p.facing, y - 62);
  ctx.quadraticCurveTo(x - 26 * p.facing, y - 35, x - 16 * p.facing, y - 2);
  ctx.lineTo(x - 4 * p.facing, y - 2);
  ctx.closePath();
  ctx.fill();

  // ноги
  ctx.fillStyle = '#241c18';
  ctx.fillRect(x - 12, y - 26, 9, 26);
  ctx.fillRect(x + 3, y - 26, 9, 26);
  ctx.fillStyle = '#100c0a';
  ctx.fillRect(x - 13, y - 4, 11, 4);
  ctx.fillRect(x + 2, y - 4, 11, 4);

  // тело (торс с бронёй)
  const bodyGrad = ctx.createLinearGradient(x - 16, y - 62, x + 16, y - 20);
  bodyGrad.addColorStop(0, bodyColor);
  bodyGrad.addColorStop(1, bodyShade);
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(x - 16, y - 62, 32, 42);

  // ремень
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(x - 16, y - 26, 32, 5);

  // нагрудная полоса брони
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 60);
  ctx.lineTo(x, y - 24);
  ctx.stroke();

  // задняя рука
  ctx.fillStyle = bodyShade;
  ctx.fillRect(x - 18 * p.facing, y - 58, 6, 26);

  // голова
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(x, y - 76, 14, 0, Math.PI * 2);
  ctx.fill();

  // волосы/шлем-полоса
  ctx.fillStyle = bodyShade;
  ctx.beginPath();
  ctx.arc(x, y - 80, 14.5, Math.PI, 0);
  ctx.fill();

  // глаза
  ctx.fillStyle = '#1a1410';
  const eyeShift = p.facing * 4;
  ctx.beginPath();
  ctx.arc(x + eyeShift - 3, y - 76, 1.6, 0, Math.PI * 2);
  ctx.arc(x + eyeShift + 3, y - 76, 1.6, 0, Math.PI * 2);
  ctx.fill();

  // передняя рука (держит меч)
  ctx.fillStyle = bodyColor;
  const armSwing = isFlash ? -18 : 0;
  ctx.save();
  ctx.translate(x + 15 * p.facing, y - 56);
  ctx.rotate((armSwing * p.facing * Math.PI) / 180);
  ctx.fillRect(0, 0, p.facing * 6, 26);
  ctx.restore();

  // меч
  const swingAngle = isFlash ? -40 : 0;
  ctx.save();
  ctx.translate(x + 20 * p.facing, y - 48);
  ctx.rotate((swingAngle * p.facing * Math.PI) / 180);

  // клинок с бликом
  const bladeLen = 44;
  const bladeGrad = ctx.createLinearGradient(0, 0, p.facing * bladeLen, 0);
  bladeGrad.addColorStop(0, isFlash ? '#fff4c2' : '#e4ecf0');
  bladeGrad.addColorStop(1, isFlash ? '#ffe066' : '#9fb0b8');
  ctx.strokeStyle = bladeGrad;
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(p.facing * bladeLen, 0);
  ctx.stroke();

  // гарда
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p.facing * -2, -6);
  ctx.lineTo(p.facing * -2, 6);
  ctx.stroke();

  // рукоять
  ctx.strokeStyle = '#4a3222';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(p.facing * -10, 0);
  ctx.stroke();

  ctx.restore();

  // вспышка удара
  if (isFlash) {
    ctx.fillStyle = 'rgba(255,224,102,0.45)';
    ctx.beginPath();
    ctx.arc(x + 55 * p.facing, y - 50, 16, 0, Math.PI * 2);
    ctx.fill();
  }
}

function draw() {
  const w = canvas.width, h = canvas.height;

  ctx.save();
  if (screenShake > 0) {
    const dx = (Math.random() - 0.5) * screenShake;
    const dy = (Math.random() - 0.5) * screenShake;
    ctx.translate(dx, dy);
    screenShake *= 0.85;
    if (screenShake < 0.3) screenShake = 0;
  }

  ctx.clearRect(-20, -20, w + 40, h + 40);
  drawBackground();

  const scale = w / 800;
  Object.values(players).forEach((p) => drawFighter(p, scale));

  // искры
  sparkEffects.forEach(s => {
    const alpha = Math.max(s.life / s.maxLife, 0);
    ctx.strokeStyle = `rgba(255,224,120,${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.vx * 1.5, s.y - s.vy * 1.5);
    ctx.stroke();
    s.x += s.vx;
    s.y += s.vy;
    s.vy += 0.15;
    s.life--;
  });
  sparkEffects = sparkEffects.filter(s => s.life > 0);

  // кровь
  bloodEffects.forEach(b => {
    const alpha = Math.max(b.life / b.maxLife, 0);
    ctx.fillStyle = `rgba(161,29,29,${alpha})`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
    ctx.fill();
    b.x += b.vx;
    b.y += b.vy;
    b.vy += 0.22;
    b.life--;
  });
  bloodEffects = bloodEffects.filter(b => b.life > 0);

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
  const max = 45;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = 51 + clampedX + 'px';
  knob.style.top = '51px';
}

function startMoveLoop() {
  if (moveInterval) return;
  moveInterval = setInterval(() => {
    if (currentDir !== 0) socket.emit('move', { dir: currentDir });
  }, 50);
}
function stopMoveLoop() {
  clearInterval(moveInterval);
  moveInterval = null;
}

function handleStart() {
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
  knob.style.left = '51px';
  stopMoveLoop();
}

zone.addEventListener('touchstart', handleStart);
zone.addEventListener('touchmove', handleMove);
zone.addEventListener('touchend', handleEnd);
zone.addEventListener('mousedown', handleStart);
window.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

const attackBtn = document.getElementById('attack-btn');
function doAttack(e) {
  e.preventDefault();
  socket.emit('attack');
}
attackBtn.addEventListener('touchstart', doAttack);
attackBtn.addEventListener('mousedown', doAttack);

