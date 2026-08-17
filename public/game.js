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
const koOverlay = document.getElementById('ko-overlay');
const koText = document.getElementById('ko-text');
const koSub = document.getElementById('ko-sub');

let mySlot = null;
let players = {};

// у каждого бойца — своё независимое состояние атаки (исправляет "перенос" анимации)
let attackActive = {};
let attackTarget = {};
let attackStartTime = {};
let attackTimers = {};
let hitStun = {};

const prevX = {};
const walkPhase = {};
let particles = [];
let sparks = [];
let bloodPools = [];
let headHits = {};
let bruiseMarks = {};
let critPopups = [];
let shake = 0;
let finished = false;
let koSlot = null;
let fallStart = 0;

function hideMenu(e) {
  if (e) e.preventDefault();
  document.getElementById('menu-overlay').style.display = 'none';
}
const playBtn = document.getElementById('play-btn');
playBtn.addEventListener('touchstart', hideMenu, { passive: false });
playBtn.addEventListener('mousedown', hideMenu);
playBtn.addEventListener('click', hideMenu);

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
  finished = false;
  koSlot = null;
  headHits = {};
  bruiseMarks = {};
  critPopups = [];
  bloodPools = [];
  hitStun = {};
  attackActive = {};
  Object.keys(attackTimers).forEach(function (k) { clearTimeout(attackTimers[k]); });
  attackTimers = {};
  if (koOverlay) koOverlay.classList.remove('show');
});
socket.on('state_update', function (p) {
  players = p;
  updateHpBars();
});
socket.on('attack_anim', function (data) {
  const slot = data.slot;
  attackActive[slot] = true;
  attackTarget[slot] = data.target;
  attackStartTime[slot] = performance.now();
  clearTimeout(attackTimers[slot]);
  const dur = (data.target === 'power_kick' || data.target === 'power_punch') ? 320 : 220;
  attackTimers[slot] = setTimeout(function () { attackActive[slot] = false; }, dur);
});
socket.on('hit_landed', function (data) {
  const p = Object.values(players).find(function (pl) { return pl.slot === data.targetSlot; });
  if (data.blocked) {
    shake = 4;
    if (p) spawnBlockSpark(p, data.part);
    return;
  }
  const crit = !!data.crit;
  shake = crit ? (data.part === 'legs' ? 18 : 14) : (data.part === 'legs' ? 12 : 8);
  hitStun[data.targetSlot] = { time: performance.now(), part: data.part };
  if (p) {
    spawnHitEffect(p, data.part, crit);
    spawnArenaBlood(p, data.part, crit);
    if (crit) spawnCritPopup(p, data.part);
  }
  spawnHudBlood(data.targetSlot, data.part);
  if (data.part === 'head') {
    headHits[data.targetSlot] = (headHits[data.targetSlot] || 0) + 1;
  }
  if (crit) {
    if (!bruiseMarks[data.targetSlot]) bruiseMarks[data.targetSlot] = { head: 0, torso: 0, legs: 0 };
    bruiseMarks[data.targetSlot][data.part] = Math.min((bruiseMarks[data.targetSlot][data.part] || 0) + 1, 4);
  }
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
  finished = true;
  koSlot = data.winnerSlot === 0 ? 1 : 0;
  fallStart = performance.now();
  shake = 22;

  let title = '🥊 НОКАУТ!';
  if (data.reason === 'legs_broken') title = '🦵 ТЕХНИЧЕСКИЙ НОКАУТ';
  else if (data.reason === 'blood') title = '🩸 ОСТАНОВКА БОЯ';

  const won = data.winnerSlot === mySlot;
  let sub;
  if (data.reason === 'legs_broken') sub = won ? 'Ты сломал сопернику ногу!' : 'Соперник сломал тебе ногу';
  else if (data.reason === 'blood') sub = won ? 'Решение судей в твою пользу' : 'Решение судей не в твою пользу';
  else sub = won ? 'Ты победил нокаутом!' : 'Соперник победил нокаутом';

  if (koText) koText.textContent = title;
  if (koSub) koSub.textContent = sub;
  setTimeout(function () {
    if (koOverlay) koOverlay.classList.add('show');
  }, 750);
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

// ---------- КРОВЬ НА АРЕНЕ (лужи) ----------
function spawnArenaBlood(p, part, crit) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  bloodPools.push({
    x: px + (Math.random() - 0.5) * 14,
    y: groundY,
    r: 0,
    maxR: (part === 'head' ? 16 : 11) * (crit ? 1.6 : 1),
    life: 1,
  });
  if (bloodPools.length > 40) bloodPools.shift();
}

// ---------- ЭФФЕКТЫ НА АРЕНЕ ----------
function spawnHitEffect(p, part, crit) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  const partY = part === 'head' ? groundY - 80 : part === 'legs' ? groundY - 15 : groundY - 50;
  const count = crit ? 12 : 6;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: px, y: partY,
      vx: (Math.random() - 0.5) * (crit ? 7 : 5), vy: -Math.random() * (crit ? 6 : 4) - 1,
      life: 1, color: '#c8102e', size: (crit ? 3 : 2) + Math.random() * 2,
    });
  }
  const sparkCount = crit ? 14 : 8;
  for (let i = 0; i < sparkCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    sparks.push({
      x: px, y: partY,
      vx: Math.cos(angle) * (2 + Math.random() * (crit ? 5 : 3)),
      vy: Math.sin(angle) * (2 + Math.random() * (crit ? 5 : 3)),
      life: 1, color: '#ffb3b3',
    });
  }
}
function spawnCritPopup(p, part) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  const py = part === 'head' ? groundY - 100 : part === 'legs' ? groundY - 35 : groundY - 70;
  critPopups.push({ x: px, y: py, life: 1 });
}
function spawnBlockSpark(p, part) {
  const scale = cssW / 800;
  const px = p.x * scale;
  const groundY = cssH * 0.82;
  const partY = part === 'head' ? groundY - 80 : part === 'legs' ? groundY - 15 : groundY - 50;
  for (let i = 0; i < 8; i++) {
    const angle = Math.random() * Math.PI * 2;
    sparks.push({
      x: px, y: partY,
      vx: Math.cos(angle) * (3 + Math.random() * 3),
      vy: Math.sin(angle) * (3 + Math.random() * 3),
      life: 1, color: '#fff6c8',
    });
  }
}
function updateParticles() {
  particles.forEach(function (pt) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.35; pt.life -= 0.04; });
  particles = particles.filter(function (pt) { return pt.life > 0; });
  sparks.forEach(function (s) { s.x += s.vx; s.y += s.vy; s.life -= 0.07; });
  sparks = sparks.filter(function (s) { return s.life > 0; });
  bloodPools.forEach(function (b) { if (b.r < b.maxR) b.r += 0.8; b.life -= 0.0015; });
  bloodPools = bloodPools.filter(function (b) { return b.life > 0; });
  critPopups.forEach(function (cp) { cp.y -= 0.6; cp.life -= 0.02; });
  critPopups = critPopups.filter(function (cp) { return cp.life > 0; });
}
function drawParticles() {
  bloodPools.forEach(function (b) {
    ctx.globalAlpha = Math.min(b.life, 0.55);
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
    ctx.strokeStyle = s.color || '#ffb3b3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.vx * 1.5, s.y - s.vy * 1.5);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  critPopups.forEach(function (cp) {
    ctx.globalAlpha = Math.max(cp.life, 0);
    ctx.fillStyle = '#ffde59';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 6;
    ctx.fillText('КРИТ!', cp.x, cp.y);
    ctx.shadowBlur = 0;
  });
  ctx.textAlign = 'left';
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
  // при ходьбе — вертикальный перенос веса, в стойке — лёгкое дыхание/покачивание
  const bob = moving
    ? Math.abs(Math.sin(walkPhase[p.slot])) * 3
    : Math.sin(performance.now() / 420 + p.slot * 3) * 1.2 + 1.2;
  const lean = moving ? p.facing * 1.5 : 0;

  const isNormalKick = isAttacking && target === 'legs';
  const isPowerKick = isAttacking && target === 'power_kick';
  const isPunchType = isAttacking && (target === 'head' || target === 'torso' || target === 'power_punch');
  const isPowerPunch = target === 'power_punch';

  let fallAngle = 0, fallLift = 0;
  if (koSlot === p.slot) {
    const fallT = Math.min(1, (performance.now() - fallStart) / 650);
    fallAngle = fallT * (Math.PI / 2) * p.facing * -1;
    fallLift = Math.sin(fallT * Math.PI) * -10;
  }
  let spinAngle = 0;
  if (isPowerKick) {
    spinAngle = Math.sin(swingT * Math.PI) * Math.PI * 1.4 * p.facing;
  }

  // реакция на попадание — короткий отшатывание назад
  let knockback = 0;
  const stun = hitStun[p.slot];
  if (stun && performance.now() - stun.time < 260) {
    const ease = 1 - (performance.now() - stun.time) / 260;
    knockback = -p.facing * ease * (stun.part === 'legs' ? 3 : 7);
  }

  ctx.save();
  ctx.translate(x + knockback, y + fallLift);
  ctx.rotate(lean * 0.02 + fallAngle + spinAngle);
  ctx.translate(-x, -y);

  if (isPowerKick) {
    ctx.strokeStyle = 'rgba(210,150,255,' + (0.5 * (1 - swingT)) + ')';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y - 45, 34, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (p.blocking) {
    ctx.strokeStyle = 'rgba(110,170,255,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y - 45, 26, 42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // тень
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(x, y + 3, 23, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // задняя (опорная) нога — бедро + голень
  const legGrad = ctx.createLinearGradient(x - 14, y - 28, x + 14, y);
  legGrad.addColorStop(0, '#241a12');
  legGrad.addColorStop(1, '#3a2a1c');
  ctx.fillStyle = legGrad;
  ctx.fillRect(x - 13 - p.facing * 2 - legSwing * 0.3, y - 30 - bob, 10, 14);
  ctx.fillStyle = '#2e2116';
  ctx.fillRect(x - 12 - p.facing * 2 - legSwing * 0.5, y - 16 - bob, 8, 16);

  // передняя нога
  if (isNormalKick || isPowerKick) {
    const kickExt = Math.sin(swingT * Math.PI);
    const reach = isPowerKick ? 16 : 10;
    ctx.save();
    ctx.translate(x + p.facing * 6, y - 20 - bob);
    ctx.rotate(p.facing * (0.3 + kickExt * (isPowerKick ? 1.5 : 1.1)));
    ctx.fillStyle = legGrad;
    ctx.fillRect(-6, -10, 12, 24 + kickExt * reach);
    ctx.restore();
  } else {
    ctx.fillStyle = legGrad;
    ctx.fillRect(x + 3 + p.facing * 2 + legSwing * 0.3, y - 30 - bob, 10, 14);
    ctx.fillStyle = '#2e2116';
    ctx.fillRect(x + 4 + p.facing * 2 + legSwing * 0.5, y - 16 - bob, 8, 16);
  }

  // синяки на ногах
  const lb = (bruiseMarks[p.slot] && bruiseMarks[p.slot].legs) || 0;
  if (lb > 0) {
    ctx.fillStyle = 'rgba(70,10,60,0.5)';
    for (let i = 0; i < lb; i++) {
      ctx.beginPath();
      ctx.ellipse(x + p.facing * (4 + i * 3), y - 10 - bob, 4, 3, 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
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
  bodyGrad.addColorStop(0, p.blocking ? '#5a80b8' : color);
  bodyGrad.addColorStop(1, p.blocking ? '#25406e' : colorDark);
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.3;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, shT + 6);
  ctx.lineTo(x, shB - 4);
  ctx.stroke();

  ctx.fillStyle = colorDark;
  ctx.fillRect(x - 13, shB - 2, 26, 10);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(x - 13, shB - 2, 3, 10);
  ctx.fillRect(x + 10, shB - 2, 3, 10);

  // синяки на торсе
  const tb = (bruiseMarks[p.slot] && bruiseMarks[p.slot].torso) || 0;
  if (tb > 0) {
    ctx.fillStyle = 'rgba(70,10,60,0.55)';
    for (let i = 0; i < tb; i++) {
      const bx = x + (i % 2 === 0 ? -6 : 6);
      const by = shT + 12 + i * 6;
      ctx.beginPath();
      ctx.ellipse(bx, by, 5, 4, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // задняя рука
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
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.ellipse(x, y - 72 - bob, 8, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#1a1410';
  const eyeShift = p.facing * 4;
  ctx.beginPath();
  ctx.arc(x + eyeShift - 3, y - 81 - bob, 1.6, 0, Math.PI * 2);
  ctx.arc(x + eyeShift + 3, y - 81 - bob, 1.6, 0, Math.PI * 2);
  ctx.fill();

  // кровь на лице
  const hits = Math.min(headHits[p.slot] || 0, 5);
  if (hits > 0) {
    ctx.fillStyle = 'rgba(150,10,20,0.85)';
    for (let i = 0; i < hits; i++) {
      const ang = (i / hits) * Math.PI - Math.PI / 2;
      ctx.save();
      ctx.translate(x + Math.cos(ang) * 6, y - 78 - bob + Math.sin(ang) * 4 + 6);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.ellipse(0, 0, 2, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // передняя (ударная) рука
  const shoulderX = x + p.facing * 15;
  const shoulderY = y - 63 - bob;
  const guardAngle = p.facing === 1 ? -0.95 : Math.PI + 0.95;
  const punchAngleNormal = p.facing === 1 ? -0.08 : Math.PI + 0.08;
  const punchAngleWide = p.facing === 1 ? 0.6 : Math.PI - 0.6;
  const punchAngleTarget = isPowerPunch ? punchAngleWide : punchAngleNormal;
  const extension = isPunchType ? Math.sin(swingT * Math.PI) : 0;
  const armAngle = guardAngle + (punchAngleTarget - guardAngle) * extension;
  const aimLift = isPunchType && (target === 'head' || target === 'power_punch') ? -6 * extension : 0;

  const upperLen = 11;
  const forearmLen = 11 + (isPowerPunch ? 30 : 20) * extension;

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

  if (isPunchType && extension > 0.15) {
    ctx.strokeStyle = isPowerPunch
      ? 'rgba(255,210,90,' + (0.55 * extension) + ')'
      : 'rgba(255,255,255,' + (0.4 * extension) + ')';
    ctx.lineWidth = isPowerPunch ? 7 : 5;
    ctx.beginPath();
    ctx.moveTo(0, forearmLen * 0.15);
    ctx.lineTo(0, forearmLen * 0.9);
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
    const isAttacking = !!attackActive[p.slot];
    let swingT = 0;
    if (isAttacking && attackStartTime[p.slot]) {
      const dur = (attackTarget[p.slot] === 'power_kick' || attackTarget[p.slot] === 'power_punch') ? 320 : 220;
      swingT = Math.min((performance.now() - attackStartTime[p.slot]) / dur, 1);
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
    if (!finished && currentDir !== 0) socket.emit('move', { dir: currentDir });
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

// ---------- ОБЫЧНЫЕ УДАРЫ (простой тап) ----------
function bindAttack(id, target) {
  const btn = document.getElementById(id);
  if (!btn) return;
  function fire(e) {
    e.preventDefault();
    if (finished) return;
    socket.emit('attack', { target: target });
  }
  btn.addEventListener('touchstart', fire, { passive: false });
  btn.addEventListener('mousedown', fire);
}

// ---------- УДАРЫ С УДЕРЖАНИЕМ (тап = обычный, зажал = усиленный) ----------
function bindHoldAttack(id, normalTarget, powerTarget, holdMs) {
  const btn = document.getElementById(id);
  if (!btn) return;
  let timer = null;
  let firedPower = false;
  function start(e) {
    e.preventDefault();
    if (finished) return;
    firedPower = false;
    btn.classList.add('charging');
    timer = setTimeout(function () {
      firedPower = true;
      btn.classList.remove('charging');
      btn.classList.add('charged-flash');
      setTimeout(function () { btn.classList.remove('charged-flash'); }, 200);
      socket.emit('attack', { target: powerTarget });
    }, holdMs);
  }
  function end(e) {
    if (e) e.preventDefault();
    clearTimeout(timer);
    btn.classList.remove('charging');
    if (!firedPower && !finished) {
      socket.emit('attack', { target: normalTarget });
    }
  }
  btn.addEventListener('touchstart', start, { passive: false });
  btn.addEventListener('touchend', end);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', end);
}

bindHoldAttack('kick-btn', 'legs', 'power_kick', 380);
bindHoldAttack('attack-btn', 'head', 'power_punch', 380);
bindAttack('hand-btn', 'torso');

// ---------- БЛОК ----------
const blockBtn = document.getElementById('block-btn');
if (blockBtn) {
  function blockStart(e) {
    e.preventDefault();
    if (finished) return;
    socket.emit('block_start');
    blockBtn.classList.add('active');
  }
  function blockEnd(e) {
    if (e) e.preventDefault();
    socket.emit('block_end');
    blockBtn.classList.remove('active');
  }
  blockBtn.addEventListener('touchstart', blockStart, { passive: false });
  blockBtn.addEventListener('touchend', blockEnd);
  blockBtn.addEventListener('mousedown', blockStart);
  blockBtn.addEventListener('mouseup', blockEnd);
}