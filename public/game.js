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
const hpBarEls = {
  0: { head: document.getElementById('hp0-head'), torso: document.getElementById('hp0-torso'), legs: document.getElementById('hp0-legs') },
  1: { head: document.getElementById('hp1-head'), torso: document.getElementById('hp1-torso'), legs: document.getElementById('hp1-legs') },
};
const staminaWrap = document.getElementById('stamina-wrap');
const staminaBar = document.getElementById('stamina-bar');
// Счётчик побед ("ПОБЕДЫ 0" на экране). Если в вашей верстке другой id — поменяйте здесь.
const winsCountEl = document.getElementById('wins-count');

let mySlot = null;
let players = {};
let attackFlash = null; // { slot, type }
let bloodEffects = [];
let sparkEffects = [];
let hitMarkers = [];    // маркеры места попадания прямо на бойце
let critFlash = 0;      // кадры вспышки "критический удар"
let screenShake = 0;
let gameEnded = false;

const PART_LABEL = { head: 'ГОЛОВА', torso: 'ТОРС', legs: 'НОГИ' };

// анимация движения
let lastX = {};
let movingUntil = {};
let walkPhase = { 0: 0, 1: 0 };

function spawnBloodAt(x, y, count = 14) {
  for (let i = 0; i < count; i++) {
    bloodEffects.push({
      x, y,
      vx: (Math.random() - 0.5) * 5,
      vy: -Math.random() * 3,
      life: 30,
      maxLife: 30,
      size: Math.random() * 2.6 + 1.4
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

// Координаты частей тела бойца на арене (совпадают с отрисовкой в drawFighter)
function bodyPartPoint(player, part, scale) {
  const x = player.x * scale;
  const groundY = canvas.height - 90;
  if (part === 'head') return { x, y: groundY - 76 };
  if (part === 'torso') return { x, y: groundY - 45 };
  return { x, y: groundY - 12 }; // legs
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
  socket.emit('join_room', { roomId, userId: tg?.initDataUnsafe?.user?.id || null });
});

socket.on('joined', (data) => {
  mySlot = data.slot;
  players = data.players;
  gameEnded = false;
  statusEl.textContent = 'Ждём соперника...';
  staminaWrap.style.display = 'block';
  if (winsCountEl && typeof data.wins === 'number') winsCountEl.textContent = data.wins;
  updateHpBars();
  updateStaminaBar();
});

socket.on('opponent_joined', (data) => {
  players = data.players;
  updateHpBars();
});

socket.on('start_game', (data) => {
  players = data.players;
  gameEnded = false;
  statusEl.textContent = '';
  updateHpBars();
});

socket.on('state_update', (p) => {
  Object.values(p).forEach(np => {
    const prevX = lastX[np.slot];
    if (prevX !== undefined && Math.abs(np.x - prevX) > 0.3) {
      movingUntil[np.slot] = Date.now() + 150;
    }
    lastX[np.slot] = np.x;
  });
  players = p;
  updateHpBars();
  updateStaminaBar();
});

socket.on('attack_anim', ({ slot, type }) => {
  attackFlash = { slot, type };
  const duration = type === 'kick' ? 260 : type === 'hand' ? 200 : 220;
  setTimeout(() => {
    if (attackFlash && attackFlash.slot === slot) attackFlash = null;
  }, duration);
});

socket.on('hit', ({ slot, part, critical }) => {
  screenShake = critical ? 15 : 8;

  const hitPlayer = Object.values(players).find(pl => pl.slot === slot);
  if (hitPlayer) {
    const scale = canvas.width / 800;
    const pt = bodyPartPoint(hitPlayer, part, scale);

    // кровь прямо на месте попадания (в том числе на лице, если part === 'head')
    const bloodCount = critical ? 26 : (part === 'head' ? 18 : 14);
    spawnBloodAt(pt.x, pt.y, bloodCount);
    spawnSparks(pt.x, pt.y, -hitPlayer.facing);

    // маркер на ринге, показывающий куда пришёлся удар
    hitMarkers.push({ x: pt.x, y: pt.y, part, critical: !!critical, life: 42, maxLife: 42 });

    if (critical) critFlash = 30;
  }
});

socket.on('attack_failed', () => {
  const old = statusEl.textContent;
  statusEl.textContent = 'Не хватает выносливости!';
  setTimeout(() => {
    if (statusEl.textContent === 'Не хватает выносливости!') statusEl.textContent = old === 'Не хватает выносливости!' ? '' : old;
  }, 700);
});

socket.on('room_full', () => {
  statusEl.textContent = 'Комната уже занята';
});

socket.on('opponent_left', () => {
  statusEl.textContent = 'Соперник вышел из боя';
});

// Тексты для разных типов добивания
const FINISHER_TEXT = {
  ko_head: '🥊 Нокаут в голову!',
  ko_legs: '🦵 Нокаут по ногам!',
  surrender: '😵 Технический нокаут!',
  body_break: '💥 Критический удар в корпус!',
};

socket.on('game_over', ({ winnerSlot, loserSlot, finisher, winnerWins }) => {
  gameEnded = true;

  const iAmWinner = winnerSlot === mySlot;
  const resultText = iAmWinner ? '🏆 Победа!' : '💀 Поражение';
  const finisherText = FINISHER_TEXT[finisher] || '';
  statusEl.textContent = `${resultText}  ${finisherText}`;

  if (iAmWinner && winsCountEl && typeof winnerWins === 'number') {
    winsCountEl.textContent = winnerWins;
  }

  // яркий эффект добивания на месте проигравшего
  const loser = Object.values(players).find(pl => pl.slot === loserSlot);
  if (loser) {
    const scale = canvas.width / 800;
    screenShake = 18;
    if (finisher === 'ko_head') {
      const pt = bodyPartPoint(loser, 'head', scale);
      spawnBloodAt(pt.x, pt.y, 40);
      spawnSparks(pt.x, pt.y, loser.facing);
    } else if (finisher === 'body_break') {
      const pt = bodyPartPoint(loser, 'torso', scale);
      spawnBloodAt(pt.x, pt.y, 45);
      spawnSparks(pt.x, pt.y, loser.facing);
      critFlash = 40;
    } else if (finisher === 'ko_legs') {
      const pt = bodyPartPoint(loser, 'legs', scale);
      spawnBloodAt(pt.x, pt.y, 30);
      spawnSparks(pt.x, pt.y, loser.facing);
    } else {
      const pt = bodyPartPoint(loser, 'torso', scale);
      spawnSparks(pt.x, pt.y, loser.facing);
    }
  }

  setTimeout(() => {
    playBtn.textContent = 'ИГРАТЬ СНОВА';
    menuOverlay.style.display = 'flex';
  }, 1800);
});

function updateHpBars() {
  Object.values(players).forEach(p => {
    const els = hpBarEls[p.slot];
    if (!els) return;
    if (els.head) els.head.style.width = Math.max(0, p.hp.head) + '%';
    if (els.torso) els.torso.style.width = Math.max(0, p.hp.torso) + '%';
    if (els.legs) els.legs.style.width = Math.max(0, p.hp.legs) + '%';
  });
}

function updateStaminaBar() {
  if (mySlot === null) return;
  const me = Object.values(players).find(pl => pl.slot === mySlot);
  if (me) staminaBar.style.width = Math.max(0, me.stamina) + '%';
}

// ---------- ФОН АРЕНЫ: ОКТАГОН ----------
function drawBackground() {
  const w = canvas.width, h = canvas.height;

  // тёмный потолок арены
  const top = ctx.createLinearGradient(0, 0, 0, h * 0.4);
  top.addColorStop(0, '#0a0b10');
  top.addColorStop(1, '#1a1c24');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h * 0.4);

  // прожекторы над рингом
  [0.22, 0.5, 0.78].forEach(fx => {
    const lx = w * fx, ly = h * 0.02;
    const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, h * 0.45);
    glow.addColorStop(0, 'rgba(255,255,255,0.16)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h * 0.6);
  });

  // сетка клетки (октагон)
  const fenceTop = h * 0.1, fenceBottom = h * 0.6;
  ctx.strokeStyle = 'rgba(190,195,205,0.28)';
  ctx.lineWidth = 1.5;
  for (let x = 0; x <= w; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, fenceTop);
    ctx.lineTo(x, fenceBottom);
    ctx.stroke();
  }
  for (let y = fenceTop; y <= fenceBottom; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // затемнение клетки, чтобы бойцы читались на фоне
  const fenceFade = ctx.createLinearGradient(0, fenceTop, 0, fenceBottom);
  fenceFade.addColorStop(0, 'rgba(8,8,12,0.6)');
  fenceFade.addColorStop(1, 'rgba(8,8,12,0.15)');
  ctx.fillStyle = fenceFade;
  ctx.fillRect(0, fenceTop, w, fenceBottom - fenceTop);

  // верхний трос клетки
  ctx.strokeStyle = 'rgba(220,220,230,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, fenceTop);
  ctx.lineTo(w, fenceTop);
  ctx.stroke();

  // мат октагона
  const mat = ctx.createLinearGradient(0, h * 0.58, 0, h);
  mat.addColorStop(0, '#7a1f1f');
  mat.addColorStop(0.5, '#551515');
  mat.addColorStop(1, '#280a0a');
  ctx.fillStyle = mat;
  ctx.fillRect(0, h * 0.58, w, h * 0.42);

  // белая кромка периметра мата
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.6);
  ctx.lineTo(w, h * 0.6);
  ctx.stroke();

  // надпись по центру мата
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.font = `bold ${Math.round(h * 0.05)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('OCTAGON', w / 2, h * 0.86);

  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

function drawFighter(p, scale) {
  const x = p.x * scale;
  const y = canvas.height - 90;
  const isFlash = attackFlash && attackFlash.slot === p.slot;
  const flashType = isFlash ? attackFlash.type : null;
  const skin = p.slot === 0 ? '#c98a5a' : '#d9a878';
  const shortsColor = p.slot === 0 ? '#2f6b3f' : '#7a2f2f';
  const shortsShade = p.slot === 0 ? '#1f4a2b' : '#571f1f';
  const gloveColor = p.slot === 0 ? '#1c1c1c' : '#c21e1e';
  const legsHurt = p.hp.legs <= 40;

  const isMoving = movingUntil[p.slot] && Date.now() < movingUntil[p.slot];
  if (isMoving) {
    walkPhase[p.slot] += legsHurt ? 0.14 : 0.22;
  } else {
    walkPhase[p.slot] *= 0.85;
  }
  const wp = walkPhase[p.slot];
  const legSwing = Math.sin(wp) * 10;
  const armSwing = Math.sin(wp + Math.PI) * 8;
  const bob = Math.abs(Math.sin(wp)) * 2;
  const torsoTilt = Math.sin(wp) * 2;

  // тень
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 22, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  const groundY = y - bob;

  // задняя нога
  ctx.save();
  ctx.translate(x - 5, groundY - 4);
  ctx.rotate((-legSwing * Math.PI) / 180 * 0.6);
  ctx.fillStyle = skin;
  ctx.fillRect(-4.5, -22, 9, 22);
  ctx.fillStyle = '#111';
  ctx.fillRect(-5.5, -2, 11, 5);
  ctx.restore();

  // передняя нога (с ударом при пинке)
  let kickAngle = 0;
  if (flashType === 'kick') {
    kickAngle = 55;
  } else if (isMoving) {
    kickAngle = -legSwing;
  }
  ctx.save();
  ctx.translate(x + 7 * p.facing, groundY - 4);
  ctx.rotate((kickAngle * p.facing * Math.PI) / 180);
  ctx.fillStyle = legsHurt ? '#8a5a3a' : skin;
  ctx.fillRect(-4.5, -22, 9, 22);
  ctx.fillStyle = '#111';
  ctx.fillRect(-5.5, -2, 11, 5);
  ctx.restore();

  // торс + шорты (лёгкий наклон при ходьбе / замахе)
  const punchWindup = (flashType === 'sword' || flashType === 'hand') ? -6 : 0;
  ctx.save();
  ctx.translate(x, groundY - 42);
  ctx.rotate(((torsoTilt + punchWindup) * p.facing * Math.PI) / 180);

  const bodyGrad = ctx.createLinearGradient(-16, -22, 16, 20);
  bodyGrad.addColorStop(0, skin);
  bodyGrad.addColorStop(1, shortsShade);
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(-15, -22, 30, 30);

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -14); ctx.lineTo(0, 6);
  ctx.moveTo(-8, -8); ctx.lineTo(8, -8);
  ctx.moveTo(-8, 0); ctx.lineTo(8, 0);
  ctx.stroke();

  ctx.fillStyle = shortsColor;
  ctx.fillRect(-16, 6, 32, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(-16, 6, 32, 2);
  ctx.restore();

  // задняя рука
  ctx.save();
  ctx.translate(x - 18 * p.facing, groundY - 58);
  ctx.rotate((armSwing * p.facing * Math.PI) / 180 * 0.7);
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, 6, 22);
  ctx.fillStyle = gloveColor;
  ctx.beginPath();
  ctx.arc(3, 24, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // голова
  ctx.save();
  ctx.translate(x, groundY - 76);
  ctx.rotate(((torsoTilt + punchWindup) * p.facing * Math.PI) / 180 * 0.5);
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shortsShade;
  ctx.beginPath();
  ctx.arc(0, -3, 14.5, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#1a1410';
  const eyeShift = p.facing * 4;
  ctx.beginPath();
  ctx.arc(eyeShift - 3, 0, 1.6, 0, Math.PI * 2);
  ctx.arc(eyeShift + 3, 0, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ударная рука: "sword" = джеб в голову, "hand" = хук в торс
  const isPunchHead = flashType === 'sword';
  const isPunchBody = flashType === 'hand';
  let armAngle = -armSwing * 0.7;
  let armLen = 22;
  let armY = groundY - 56;
  if (isPunchHead) { armAngle = -20; armLen = 34; armY = groundY - 62; }
  if (isPunchBody) { armAngle = -35; armLen = 30; armY = groundY - 46; }

  ctx.save();
  ctx.translate(x + 15 * p.facing, armY);
  ctx.rotate((armAngle * p.facing * Math.PI) / 180);
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, p.facing * 6, armLen);
  ctx.fillStyle = gloveColor;
  ctx.beginPath();
  ctx.arc(p.facing * 3, armLen, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // вспышка удара
  if (flashType === 'sword') {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(x + 50 * p.facing, groundY - 62, 14, 0, Math.PI * 2);
    ctx.fill();
  } else if (flashType === 'kick') {
    ctx.fillStyle = 'rgba(255,160,80,0.4)';
    ctx.beginPath();
    ctx.arc(x + 40 * p.facing, groundY - 10, 14, 0, Math.PI * 2);
    ctx.fill();
  } else if (flashType === 'hand') {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(x + 45 * p.facing, groundY - 40, 12, 0, Math.PI * 2);
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

  // маркеры попадания на теле бойца (показывают куда пришёлся удар)
  hitMarkers.forEach(m => {
    const t = 1 - m.life / m.maxLife;
    const alpha = Math.max(m.life / m.maxLife, 0);
    ctx.strokeStyle = m.critical ? `rgba(255,60,60,${alpha})` : `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 10 + t * 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = m.critical ? `rgba(255,90,90,${alpha})` : `rgba(255,255,255,${alpha})`;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(PART_LABEL[m.part] || '', m.x, m.y - 16 - t * 20);
    m.life--;
  });
  hitMarkers = hitMarkers.filter(m => m.life > 0);

  // вспышка критического удара
  if (critFlash > 0) {
    const alpha = Math.min(critFlash / 30, 1);
    ctx.fillStyle = `rgba(255,0,0,${alpha * 0.22})`;
    ctx.fillRect(-20, -20, w + 40, h + 40);
    ctx.fillStyle = `rgba(255,225,70,${alpha})`;
    ctx.font = `bold ${Math.round(h * 0.05)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('КРИТИЧЕСКИЙ УДАР!', w / 2, h * 0.3);
    critFlash--;
  }

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

const attackBtn = document.getElementById('attack-btn'); // ГОЛОВА (джеб)
const kickBtn = document.getElementById('kick-btn');     // НОГИ (пинок)
const handBtn = document.getElementById('hand-btn');     // ТОРС (хук, может стать критическим)

function doSwordAttack(e) {
  e.preventDefault();
  if (gameEnded) return;
  socket.emit('attack', { type: 'sword' });
}
function doKickAttack(e) {
  e.preventDefault();
  if (gameEnded) return;
  socket.emit('attack', { type: 'kick' });
}
function doHandAttack(e) {
  e.preventDefault();
  if (gameEnded) return;
  socket.emit('attack', { type: 'hand' });
}

attackBtn.addEventListener('touchstart', doSwordAttack);
attackBtn.addEventListener('mousedown', doSwordAttack);
kickBtn.addEventListener('touchstart', doKickAttack);
kickBtn.addEventListener('mousedown', doKickAttack);
if (handBtn) {
  handBtn.addEventListener('touchstart', doHandAttack);
  handBtn.addEventListener('mousedown', doHandAttack);
}
