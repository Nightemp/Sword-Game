cat > /mnt/user-data/outputs/game.js << 'GAMEEOF'
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || tg?.initDataUnsafe?.start_param || 'default';
const myName = tg?.initDataUnsafe?.user?.first_name || 'Игрок';

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
const nameEls = { 0: document.getElementById('name-0'), 1: document.getElementById('name-1') };
const hpBarEls = {
  0: { head: document.getElementById('hp0-head'), torso: document.getElementById('hp0-torso'), legs: document.getElementById('hp0-legs') },
  1: { head: document.getElementById('hp1-head'), torso: document.getElementById('hp1-torso'), legs: document.getElementById('hp1-legs') },
};
const staminaWrap = document.getElementById('stamina-wrap');
const staminaBar = document.getElementById('stamina-bar');
const hitFlash = document.getElementById('hit-flash');

let mySlot = null;
let players = {};
let attackFlash = null;
let bloodEffects = [];
let sparkEffects = [];
let dmgTexts = [];
let confetti = [];
let screenShake = 0;
let fightStartAt = 0;
let showFightBanner = 0;

let lastX = {};
let movingUntil = {};
let walkPhase = { 0: 0, 1: 0 };

// ---------- ЗВУК (Web Audio, без файлов) ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function playTone({ freq = 440, duration = 0.12, type = 'sine', volume = 0.2, slideTo = null }) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, audioCtx.currentTime + duration);
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}
function sndSwordSwing() { playTone({ freq: 700, slideTo: 250, duration: 0.15, type: 'sawtooth', volume: 0.12 }); }
function sndKick() { playTone({ freq: 150, slideTo: 60, duration: 0.18, type: 'square', volume: 0.18 }); }
function sndHit() { playTone({ freq: 180, slideTo: 40, duration: 0.15, type: 'square', volume: 0.25 }); }
function sndFailed() { playTone({ freq: 200, duration: 0.1, type: 'triangle', volume: 0.15 }); }
function sndCountdownBeep() { playTone({ freq: 500, duration: 0.1, type: 'sine', volume: 0.2 }); }
function sndFightGo() { playTone({ freq: 300, slideTo: 900, duration: 0.3, type: 'sawtooth', volume: 0.22 }); }
function sndVictory() {
  [523, 659, 784, 1046].forEach((f, i) => {
    setTimeout(() => playTone({ freq: f, duration: 0.25, type: 'triangle', volume: 0.2 }), i * 110);
  });
}
function sndDefeat() {
  [400, 320, 240, 160].forEach((f, i) => {
    setTimeout(() => playTone({ freq: f, duration: 0.3, type: 'sawtooth', volume: 0.18 }), i * 130);
  });
}

function haptic(style) {
  try {
    if (style === 'notif') tg?.HapticFeedback?.notificationOccurred('success');
    else if (style === 'error') tg?.HapticFeedback?.notificationOccurred('error');
    else tg?.HapticFeedback?.impactOccurred(style || 'light');
  } catch (e) {}
}

function spawnBloodAt(x, y) {
  for (let i = 0; i < 14; i++) {
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
function spawnDmgText(x, y, text, color) {
  dmgTexts.push({ x, y, text, color, life: 45, maxLife: 45 });
}
function spawnConfetti() {
  const colors = ['#ffe066', '#4a7c59', '#7c4a4a', '#e8b88a', '#66c2ff'];
  for (let i = 0; i < 80; i++) {
    confetti.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 2,
      vy: Math.random() * 2 + 2,
      size: Math.random() * 5 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * 360,
      vr: (Math.random() - 0.5) * 10,
      life: 240
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
  ensureAudio();
  if (playBtn.textContent === 'ИГРАТЬ СНОВА') {
    location.reload();
    return;
  }
  menuOverlay.style.display = 'none';
  socket.emit('join_room', { roomId, name: myName });
});

function applyNames() {
  Object.values(players).forEach(p => {
    if (nameEls[p.slot] && p.name) nameEls[p.slot].textContent = p.name;
  });
}

socket.on('joined', (data) => {
  mySlot = data.slot;
  players = data.players;
  statusEl.textContent = 'Ждём соперника...';
  staminaWrap.style.display = 'block';
  applyNames();
  updateHpBars();
  updateStaminaBar();
});

socket.on('opponent_joined', (data) => {
  players = data.players;
  applyNames();
  updateHpBars();
});

socket.on('start_game', (data) => {
  players = data.players;
  fightStartAt = data.startAt || (Date.now() + 3000);
  statusEl.textContent = '';
  applyNames();
  updateHpBars();
  let lastShown = null;
  const tick = setInterval(() => {
    const remain = Math.ceil((fightStartAt - Date.now()) / 1000);
    if (remain !== lastShown && remain > 0) {
      sndCountdownBeep();
      lastShown = remain;
    }
    if (Date.now() >= fightStartAt) {
      sndFightGo();
      haptic('medium');
      showFightBanner = 60;
      clearInterval(tick);
    }
  }, 50);
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
  if (type === 'kick') sndKick(); else sndSwordSwing();
  if (slot === mySlot) haptic('light');
  setTimeout(() => {
    if (attackFlash && attackFlash.slot === slot) attackFlash = null;
  }, type === 'kick' ? 260 : 220);
});

const PART_LABEL = { head: 'ГОЛОВА', torso: 'ТОРС', legs: 'НОГИ' };

socket.on('hit', ({ slot, part, damage }) => {
  screenShake = 8;
  sndHit();

  const barEl = hpBarEls[slot][part];
  if (barEl) {
    const rect = barEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const bx = slot === 0 ? rect.right - canvasRect.left : rect.left - canvasRect.left;
    const by = rect.top - canvasRect.top + rect.height / 2;
    spawnBloodAt(bx, by);
    spawnDmgText(bx, by - 10, '-' + (damage || ''), part === 'head' ? '#ffcf6b' : '#ff6b6b');
  }

  const hitPlayer = Object.values(players).find(pl => pl.slot === slot);
  if (hitPlayer) {
    const scale = canvas.width / 800;
    spawnSparks(hitPlayer.x * scale, canvas.height - 140, -hitPlayer.facing);
  }

  if (slot === mySlot) {
    haptic('heavy');
    hitFlash.style.opacity = '1';
    setTimeout(() => (hitFlash.style.opacity = '0'), 120);
  } else {
    haptic('light');
  }
});

socket.on('attack_failed', () => {
  sndFailed();
  haptic('error');
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

socket.on('game_over', ({ winnerSlot }) => {
  const won = winnerSlot === mySlot;
  statusEl.textContent = won ? '🏆 Победа!' : '💀 Поражение';
  if (won) {
    sndVictory();
    haptic('notif');
    spawnConfetti();
  } else {
    sndDefeat();
    haptic('error');
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

const attackBtn = document.getElementById('attack-btn');
const kickBtn = document.getElementById('kick-btn');

function updateStaminaBar() {
  if (mySlot === null) return;
  const me = Object.values(players).find(pl => pl.slot === mySlot);
  if (!me) return;
  staminaBar.style.width = Math.max(0, me.stamina) + '%';
  staminaBar.style.background = me.stamina < 20
    ? 'linear-gradient(#ff6b6b, #c94040)'
    : 'linear-gradient(#ffe066, #d9a521)';
  attackBtn.classList.toggle('btn-disabled', me.stamina < 20);
  kickBtn.classList.toggle('btn-disabled', me.stamina < 15);
}

// ---------- ФОН АРЕНЫ ----------
function drawBackground() {
  const w = canvas.width, h = canvas.height;

  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#2b1f3a');
  sky.addColorStop(0.5, '#5a3a52');
  sky.addColorStop(1, '#c97b5a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h * 0.62);

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

  const ground = ctx.createLinearGradient(0, h * 0.6, 0, h);
  ground.addColorStop(0, '#6b5644');
  ground.addColorStop(0.15, '#4a3b2f');
  ground.addColorStop(1, '#241c16');
  ctx.fillStyle = ground;
  ctx.fillRect(0, h * 0.6, w, h * 0.4);

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const y = h * 0.65 + i * (h * 0.35 / 6);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + Math.sin(i) * 6);
    ctx.stroke();
  }

  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

function drawFighter(p, scale) {
  const x = p.x * scale;
  const y = canvas.height - 90;
  const isFlash = attackFlash && attackFlash.slot === p.slot;
  const flashType = isFlash ? attackFlash.type : null;
  const bodyColor = p.slot === 0 ? '#3f7a4f' : '#8a3d3d';
  const bodyShade = p.slot === 0 ? '#2b5638' : '#602a2a';
  const skin = '#e8b88a';
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

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 22, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  const groundY = y - bob;

  ctx.fillStyle = bodyShade;
  ctx.beginPath();
  ctx.moveTo(x - 12 * p.facing, groundY - 62);
  ctx.quadraticCurveTo(x - 26 * p.facing, groundY - 35, x - 16 * p.facing, groundY - 2);
  ctx.lineTo(x - 4 * p.facing, groundY - 2);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.translate(x - 5, groundY - 4);
  ctx.rotate((-legSwing * Math.PI) / 180 * 0.6);
  ctx.fillStyle = '#241c18';
  ctx.fillRect(-4.5, -22, 9, 22);
  ctx.fillStyle = '#100c0a';
  ctx.fillRect(-5.5, -2, 11, 4);
  ctx.restore();

  let kickAngle = 0;
  if (flashType === 'kick') {
    kickAngle = 55;
  } else if (isMoving) {
    kickAngle = -legSwing;
  }
  ctx.save();
  ctx.translate(x + 7 * p.facing, groundY - 4);
  ctx.rotate((kickAngle * p.facing * Math.PI) / 180);
  ctx.fillStyle = legsHurt ? '#3a2018' : '#241c18';
  ctx.fillRect(-4.5, -22, 9, 22);
  ctx.fillStyle = '#100c0a';
  ctx.fillRect(-5.5, -2, 11, 4);
  ctx.restore();

  const swordWindup = flashType === 'sword' ? -8 : 0;
  ctx.save();
  ctx.translate(x, groundY - 42);
  ctx.rotate(((torsoTilt + swordWindup) * p.facing * Math.PI) / 180);
  const bodyGrad = ctx.createLinearGradient(-16, -20, 16, 20);
  bodyGrad.addColorStop(0, bodyColor);
  bodyGrad.addColorStop(1, bodyShade);
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(-16, -20, 32, 42);
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(-16, 16, 32, 5);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.lineTo(0, 18);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.translate(x - 18 * p.facing, groundY - 58);
  ctx.rotate((armSwing * p.facing * Math.PI) / 180 * 0.7);
  ctx.fillStyle = bodyShade;
  ctx.fillRect(0, 0, 6, 26);
  ctx.restore();

  ctx.save();
  ctx.translate(x, groundY - 76);
  ctx.rotate(((torsoTilt + swordWindup) * p.facing * Math.PI) / 180 * 0.5);
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bodyShade;
  ctx.beginPath();
  ctx.arc(0, -4, 14.5, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#1a1410';
  const eyeShift = p.facing * 4;
  ctx.beginPath();
  ctx.arc(eyeShift - 3, 0, 1.6, 0, Math.PI * 2);
  ctx.arc(eyeShift + 3, 0, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const armSwingAttack = flashType === 'sword' ? -18 : -armSwing * 0.7;
  ctx.save();
  ctx.translate(x + 15 * p.facing, groundY - 56);
  ctx.rotate((armSwingAttack * p.facing * Math.PI) / 180);
  ctx.fillStyle = bodyColor;
  ctx.fillRect(0, 0, p.facing * 6, 26);
  ctx.restore();

  const swingAngle = flashType === 'sword' ? -40 : 0;
  ctx.save();
  ctx.translate(x + 20 * p.facing, groundY - 48);
  ctx.rotate((swingAngle * p.facing * Math.PI) / 180);

  const bladeLen = 44;
  const bladeGrad = ctx.createLinearGradient(0, 0, p.facing * bladeLen, 0);
  const swordActive = flashType === 'sword';
  bladeGrad.addColorStop(0, swordActive ? '#fff4c2' : '#e4ecf0');
  bladeGrad.addColorStop(1, swordActive ? '#ffe066' : '#9fb0b8');
  ctx.strokeStyle = bladeGrad;
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(p.facing * bladeLen, 0);
  ctx.stroke();

  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p.facing * -2, -6);
  ctx.lineTo(p.facing * -2, 6);
  ctx.stroke();

  ctx.strokeStyle = '#4a3222';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(p.facing * -10, 0);
  ctx.stroke();

  ctx.restore();

  if (flashType === 'sword') {
    ctx.fillStyle = 'rgba(255,224,102,0.45)';
    ctx.beginPath();
    ctx.arc(x + 55 * p.facing, groundY - 50, 16, 0, Math.PI * 2);
    ctx.fill();
  } else if (flashType === 'kick') {
    ctx.fillStyle = 'rgba(255,160,80,0.4)';
    ctx.beginPath();
    ctx.arc(x + 40 * p.facing, groundY - 10, 14, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCountdown() {
  if (!fightStartAt) return;
  const remainMs = fightStartAt - Date.now();
  const w = canvas.width, h = canvas.height;

  if (remainMs > 0) {
    const secLeft = Math.ceil(remainMs / 1000);
    const frac = (remainMs % 1000) / 1000;
    const scale = 1 + frac * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.translate(w / 2, h * 0.4);
    ctx.scale(scale, scale);
    ctx.font = 'bold 64px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe066';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillText(secLeft, 0, 0);
    ctx.restore();
  } else if (showFightBanner > 0) {
    const alpha = Math.min(showFightBanner / 20, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(w / 2, h * 0.4);
    ctx.font = 'bold 46px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff6b6b';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 12;
    ctx.fillText('БОЙ!', 0, 0);
    ctx.restore();
    showFightBanner--;
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

  dmgTexts.forEach(t => {
    const alpha = Math.max(t.life / t.maxLife, 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = t.color;
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    ctx.fillText(t.text, t.x, t.y);
    ctx.restore();
    t.y -= 0.6;
    t.life--;
  });
  dmgTexts = dmgTexts.filter(t => t.life > 0);

  confetti.forEach(c => {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate((c.rot * Math.PI) / 180);
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size);
    ctx.restore();
    c.x += c.vx;
    c.y += c.vy;
    c.rot += c.vr;
    c.life--;
  });
  confetti = confetti.filter(c => c.life > 0 && c.y < canvas.height + 30);

  drawCountdown();

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

function doSwordAttack(e) {
  e.preventDefault();
  socket.emit('attack', { type: 'sword' });
}
function doKickAttack(e) {
  e.preventDefault();
  socket.emit('attack', { type: 'kick' });
}

attackBtn.addEventListener('touchstart', doSwordAttack);
attackBtn.addEventListener('mousedown', doSwordAttack);
kickBtn.addEventListener('touchstart', doKickAttack);
kickBtn.addEventListener('mousedown', doKickAttack);
GAMEEOF
echo done