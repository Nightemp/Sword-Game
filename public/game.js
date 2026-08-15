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
const hpBars = {
  0: {
    head: document.getElementById('hp0-head'),
    torso: document.getElementById('hp0-torso'),
    legs: document.getElementById('hp0-legs'),
  },
  1: {
    head: document.getElementById('hp1-head'),
    torso: document.getElementById('hp1-torso'),
    legs: document.getElementById('hp1-legs'),
  },
};
const staminaBar = document.getElementById('stamina-bar');

let mySlot = null;
let players = {};
let attackFlashSlot = null;
let attackTarget = {};
let attackStartTime = {};
const prevX = {};
const walkPhase = {};
let particles = [];
let sparks = [];
let shake = 0;

document.getElementById('play-btn').addEventListener('click', function () {
  document.getElementById('menu-overlay').style.display = 'none';
});

const socket = io();
socket.emit('get_stats');
socket.emit('join_room', { roomId: roomId });

socket.on('stats_update', function (data) {
  const el = document.getElementById('online-count');
  if (el) el.textContent = data.online;
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
  attackTarget[data.slot] = data.target;
  attackStartTime[data.slot] = performance.now();
  setTimeout(function () { attackFlashSlot = null; }, 220);
});
socket.on('hit_landed', function (data) {
  shake = data.part === 'legs' ? 12 : 8;
  const p = Object.values(players).find(function (pl) { return pl.slot === data.targetSlot; });
  if (p) spawnHitEffect(p, data.part);
  spawnHudBlood(data.targetSlot, data.part);
});
socket.on('too_tired', function () {
  statusEl.textContent = 'Не хватает выносливости';
  setTimeout(function () {
    if (statusEl.textContent === 'Не хватает выносливости') statusEl.textContent = '';
  }, 500);
});
socket.on('room_full', function () { statusEl.textContent = 'Комната уже занята'; });
socket.on('opponent_left', function () { statusEl.textContent = 'Соперник вышел из боя'; });
socket.on('game_over', function (data) {
  statusEl.textContent = data.winnerSlot === mySlot ? '🏆 Победа!' : '💀 Поражение';
});

function updateHpBars() {
  Object.values(players).forEach(function (p) {
    const bars = hpBars[p.slot];
    if (bars) {
      bars.head.style.width = p.parts.head + '%';
      bars.torso.style.width = p.parts.torso + '%';
      bars.legs.style.width = p.parts.legs + '%';
    }
    if (p.slot === mySlot && staminaBar) {
      staminaBar.style.width = p.stamina + '%';
    }
  });
}

// ---------- КРОВЬ НА ШКАЛЕ ----------
function spawnHudBlood(slot, part) {
  const bar = hpBars[slot] && hpBars[slot][part];
  if (!bar) return;
  const parentRect = bar.parentElement.getBoundingClientRect();
  const pct = parseFloat(bar.style.width) || 0;
  const edgeX = parentRect.left + parentRect.width * (pct / 100);
  for (let i = 0; i < 3; i++) {
    const drop = document.createElement('div');
    drop.style.position = 'fixed';
    drop.style.left = (edgeX - 2 + Math.random() * 4) + 'px';
    drop.style.top = parentRect.top + 'px';
    drop.style.width = '4px';
    drop.style.height = '4px';
    drop.style.borderRadius = '50%';
    drop.style.background = '#c8102e';
    drop.style.zIndex = '20';
    drop.style.pointerEvents = 'none';
    drop.style.transition = 'transform 0.45s ease-in, opacity 0.45s ease-in';
    document.body.appendChild(drop);
    requestAnimationFrame(function () {
      drop.style.transform = 'translateY(' + (10 + Math.random() * 8) + 'px)';
      drop.style.opacity = '0';
    });
    setTimeout(function () { drop.remove(); }, 500);
  }
}

// ---------- ЭФФЕКТЫ НА АРЕНЕ ----------
function spawnHitEffect(p, part) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  const partY = part === 'head' ? groundY - 80 : part === 'legs' ? groundY - 15 : groundY - 50;
  for (let i = 0; i < 6; i++) {
    particles.push({
      x: px, y: partY,
      vx: (Math.random() - 0.5) * 5, vy: -Math.random() * 4 - 1,
      life: 1, color: '#c8102e', size: 2 + Math.random() * 2,
    });
  }
  for (let i = 0; i < 8; i++) {
    const angle = Math.random() * Math.PI * 2;
    sparks.push({
      x: px, y: partY,
      vx: Math.cos(angle) * (2 + Math.random() * 3),
      vy: Math.sin(angle) * (2 + Math.random() * 3),
      life: 1,
    });
  }
}
function updateParticles() {
  particles.forEach(function (pt) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.35; pt.life -= 0.04; });
  particles = particles.filter(function (pt) { return pt.life > 0; });
  sparks.forEach(function (s) { s.x += s.vx; s.y += s.vy; s.life -= 0.07; });
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
    ctx.strokeStyle = '#ffb3b3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.vx * 1.5, s.y - s.vy * 1.5);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

function drawGlove(cx, cy, teamColor) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = teamColor;
  ctx.fillRect(-4, -9, 8, 6);
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

// ---------- БОЕЦ ----------
function drawFighter(p, groundY, scale, isAttacking, swingT, target) {
  const x = p.x * scale;
  const y = groundY;
  const color = p.slot === 0 ? '#3f8a5c' : '#a13f3f';
  const colorDark = p.slot === 0 ? '#255c3a' : '#6e2323';
  const skin = '#e8b088';
  const skinDark = '#b87d54';

  const last = prevX[p.slot];
  const moving = last !== undefined && Math.abs(x - last) > 0.3;
  prevX[p.slot] = x;
  if (!walkPhase[p.slot]) walkPhase[p.slot] = 0;
  if (moving) walkPhase[p.slot] += 0.35;
  const legSwing = moving ? Math.sin(walkPhase[p.slot]) * 7 : 0;
  const armCounterSwing = moving ? -Math.sin(walkPhase[p.slot]) * 8 : 0;
  const bob = moving ? Math.abs(Math.sin(walkPhase[p.slot])) * 3 : 0;
  const lean = moving ? p.facing * 1.5 : 0;

  const isKick = isAttacking && target === 'legs';

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(lean * 0.02);
  ctx.translate(-x, -y);

  // тень
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(x, y + 3, 23, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // задняя (опорная) нога
  const legGrad = ctx.createLinearGradient(x - 14, y - 28, x + 14, y);
  legGrad.addColorStop(0, '#241a12');
  legGrad.addColorStop(1, '#3a2a1c');
  ctx.fillStyle = legGrad;
  ctx.fillRect(x - 13 - p.facing * 2 - legSwing * 0.3, y - 30 - bob, 10, 30);

  // передняя нога — обычная ходьба, либо удар ногой
  if (isKick) {
    const kickExt = Math.sin(swingT * Math.PI);
    ctx.save();
    ctx.translate(x + p.facing * 6, y - 20 - bob);
    ctx.rotate(p.facing * (0.3 + kickExt * 1.1));
    ctx.fillStyle = legGrad;
    ctx.fillRect(-6, -10, 12, 24 + kickExt * 10);
    ctx.restore();
  } else {
    ctx.fillStyle = legGrad;
    ctx.fillRect(x + 3 + p.facing * 2 + legSwing * 0.3, y - 30 - bob, 10, 30);
  }

  // торс
  const shT = y - 66 - bob, shB = y - 26 - bob;
  ctx.beginPath();
  ctx.moveTo(x - 17, shT);
  ctx.lineTo(x + 17, shT);
  ctx.lineTo(x + 11, shB);
  ctx.lineTo(x - 11, shB);
  ctx.closePath();
  const bodyGrad = ctx.createLinearGradient(x - 17, shT, x + 17, shB);
  bodyGrad.addColorStop(0, color);
  bodyGrad.addColorStop(1, colorDark);
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.3;
  ctx.stroke();

  ctx.fillStyle = colorDark;
  ctx.fillRect(x - 13, shB - 2, 26, 10);

  // задняя рука (противофаза шагу)
  ctx.fillStyle = skinDark;
  ctx.fillRect(x - p.facing * 21 - 3 + armCounterSwing * 0.2, y - 63 - bob, 6, 12);
  ctx.fillStyle = colorDark;
  ctx.fillRect(x - p.facing * 21 - 3 + armCounterSwing * 0.2, y - 52 - bob, 6, 12);
  drawGlove(x - p.facing * 21 + armCounterSwing * 0.2, y - 38 - bob, colorDark);

  // голова
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
  const eyeShift = p.facing * 4;
  ctx.beginPath();
  ctx.arc(x + eyeShift - 3, y - 81 - bob, 1.6, 0, Math.PI * 2);
  ctx.arc(x + eyeShift + 3, y - 81 - bob, 1.6, 0, Math.PI * 2);
  ctx.fill();

  // передняя (ударная) рука
  const shoulderX = x + p.facing * 15;
  const shoulderY = y - 63 - bob;
  const guardAngle = p.facing === 1 ? -0.95 : Math.PI + 0.95;
  const punchAngle = p.facing === 1 ? -0.08 : Math.PI + 0.08;
  const isPunch = isAttacking && !isKick;
  const extension = isPunch ? Math.sin(swingT * Math.PI) : 0;
  const armAngle = guardAngle + (punchAngle - guardAngle) * extension;
  const aimLift = isPunch && target === 'head' ? -6 * extension : 0;

  const upperLen = 11;
  const forearmLen = 11 + 20 * extension;

  ctx.save();
  ctx.translate(shoulderX, shoulderY + aimLift);
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

  if (isPunch && extension > 0.15) {
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.4 * extension) + ')';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, forearmLen * 0.2);
    ctx.lineTo(0, forearmLen * 0.85);
    ctx.stroke();
  }

  drawGlove(0, forearmLen, colorDark);
  ctx.restore();

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
  drawArenaBackground(groundY);

  Object.values(players).forEach(function (p) {
    const isAttacking = attackFlashSlot === p.slot;
    let swingT = 0;
    if (isAttacking && attackStartTime[p.slot]) {
      swingT = Math.min((performance.now() - attackStartTime[p.slot]) / 220, 1);
    }
    drawFighter(p, groundY, scale, isAttacking, swingT, attackTarget[p.slot]);
  });

  updateParticles();
  drawParticles();
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
  const max = 45;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = (51 + clampedX) + 'px';
  knob.style.top = '51px';
}
function startMoveLoop() {
  if (moveInterval) return;
  moveInterval = setInterval(function () {
    if (currentDir !== 0) socket.emit('move', { dir: currentDir });
  }, 40);
}
function stopMoveLoop() { clearInterval(moveInterval); moveInterval = null; }
function handleStart(e) { e.preventDefault(); dragging = true; startMoveLoop(); }
function handleMove(e) {
  if (!dragging) return;
  const touch = e.touches ? e.touches[0] : e;
  const rect = zone.getBoundingClientRect();
  const dx = touch.clientX - (rect.left + rect.width / 2);
  setKnob(dx);
  currentDir = dx > 15 ? 1 : dx < -15 ? -1 : 0;
}
function handleEnd() { dragging = false; currentDir = 0; knob.style.left = '51px'; stopMoveLoop(); }

zone.addEventListener('touchstart', handleStart, { passive: false });
zone.addEventListener('touchmove', handleMove, { passive: false });
zone.addEventListener('touchend', handleEnd);
zone.addEventListener('mousedown', handleStart);
window.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

// ---------- АТАКИ ----------
function bindAttack(id, target) {
  const btn = document.getElementById(id);
  if (!btn) return;
  function fire(e) {
    e.preventDefault();
    socket.emit('attack', { target: target });
  }
  btn.addEventListener('touchstart', fire, { passive: false });
  btn.addEventListener('mousedown', fire);
}
bindAttack('attack-btn', 'head');
bindAttack('hand-btn', 'torso');
bindAttack('kick-btn', 'legs');
