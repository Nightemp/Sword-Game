const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || tg?.initDataUnsafe?.start_param || 'default';
const myName = tg?.initDataUnsafe?.user?.first_name || 'Игрок';

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');
function resize() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; }
window.addEventListener('resize', resize);
resize();
setTimeout(resize, 300);
if (tg) tg.onEvent('viewportChanged', resize);

const statusEl = document.getElementById('status');
const nameEls = { 0: document.getElementById('name-0'), 1: document.getElementById('name-1') };
const hpBarEls = {
  0: { head: document.getElementById('hp0-head'), torso: document.getElementById('hp0-torso'), legs: document.getElementById('hp0-legs') },
  1: { head: document.getElementById('hp1-head'), torso: document.getElementById('hp1-torso'), legs: document.getElementById('hp1-legs') },
};
const staminaWrap = document.getElementById('stamina-wrap');
const staminaBar = document.getElementById('stamina-bar');
const hitFlash = document.getElementById('hit-flash');
const escapeWrap = document.getElementById('escape-wrap');
const escapeBar = document.getElementById('escape-bar');

let mySlot = null;
let players = {};
let attackFlash = null;
let bloodEffects = [];
let sparkEffects = [];
let dmgTexts = [];
let confetti = [];
let bodyStains = { 0: [], 1: [] };
let groundStains = [];
let screenShake = 0;
let fightStartAt = 0;
let showFightBanner = 0;
let comboBanner = 0;
let takedownBanner = null;
let koSlot = null, koStart = 0;

let lastX = {};
let movingUntil = {};
let walkPhase = { 0: 0, 1: 0 };
let displayX = {};

// ---------- ЗВУК ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + duration);
}
function sndSwordSwing() { playTone({ freq: 700, slideTo: 250, duration: 0.15, type: 'sawtooth', volume: 0.12 }); }
function sndKick() { playTone({ freq: 150, slideTo: 60, duration: 0.18, type: 'square', volume: 0.18 }); }
function sndHit() { playTone({ freq: 180, slideTo: 40, duration: 0.15, type: 'square', volume: 0.25 }); }
function sndCombo() { playTone({ freq: 500, slideTo: 900, duration: 0.18, type: 'triangle', volume: 0.2 }); }
function sndTakedown() { playTone({ freq: 220, slideTo: 50, duration: 0.35, type: 'sawtooth', volume: 0.25 }); }
function sndThud() { playTone({ freq: 90, duration: 0.25, type: 'square', volume: 0.3 }); }
function sndFailed() { playTone({ freq: 200, duration: 0.1, type: 'triangle', volume: 0.15 }); }
function sndCountdownBeep() { playTone({ freq: 500, duration: 0.1, type: 'sine', volume: 0.2 }); }
function sndFightGo() { playTone({ freq: 300, slideTo: 900, duration: 0.3, type: 'sawtooth', volume: 0.22 }); }
function sndVictory() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => playTone({ freq: f, duration: 0.25, type: 'triangle', volume: 0.2 }), i * 110)); }
function sndDefeat() { [400, 320, 240, 160].forEach((f, i) => setTimeout(() => playTone({ freq: f, duration: 0.3, type: 'sawtooth', volume: 0.18 }), i * 130)); }

function haptic(style) {
  try {
    if (style === 'notif') tg?.HapticFeedback?.notificationOccurred('success');
    else if (style === 'error') tg?.HapticFeedback?.notificationOccurred('error');
    else tg?.HapticFeedback?.impactOccurred(style || 'light');
  } catch (e) {}
}

function spawnBloodAt(x, y) {
  for (let i = 0; i < 14; i++) bloodEffects.push({ x, y, vx: (Math.random() - 0.5) * 5, vy: -Math.random() * 3, life: 30, maxLife: 30, size: Math.random() * 2.6 + 1.4 });
}
function spawnSparks(x, y, facing) {
  for (let i = 0; i < 10; i++) sparkEffects.push({ x, y, vx: facing * (Math.random() * 5 + 2), vy: (Math.random() - 0.5) * 5, life: 16, maxLife: 16, size: Math.random() * 2 + 1 });
}
function spawnDmgText(x, y, text, color) { dmgTexts.push({ x, y, text, color, life: 45, maxLife: 45 }); }
function spawnConfetti() {
  const colors = ['#ffe066', '#4a7c59', '#7c4a4a', '#e8b88a', '#66c2ff'];
  for (let i = 0; i < 80; i++) confetti.push({ x: Math.random() * canvas.width, y: -20 - Math.random() * 200, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2 + 2, size: Math.random() * 5 + 3, color: colors[Math.floor(Math.random() * colors.length)], rot: Math.random() * 360, vr: (Math.random() - 0.5) * 10, life: 240 });
}
function addBodyStain(slot, part) {
  const dy = part === 'head' ? -76 : part === 'legs' ? -15 : -42;
  const arr = bodyStains[slot];
  arr.push({ dx: (Math.random() - 0.5) * 20, dy: dy + (Math.random() - 0.5) * 10, size: Math.random() * 3 + 2.5 });
  if (arr.length > 40) arr.shift();
}
function addGroundStain(arenaX) {
  groundStains.push({ arenaX, size: Math.random() * 10 + 8, offset: (Math.random() - 0.5) * 24 });
  if (groundStains.length > 60) groundStains.shift();
}

// =====================================================================
// МИНИ-ЭМИТТЕР
// =====================================================================
class MiniEmitter {
  constructor() { this.handlers = {}; }
  on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); }
  emit(event, data) { (this.handlers[event] || []).forEach(fn => fn(data)); }
}

// =====================================================================
// ЛОКАЛЬНЫЙ "СЕРВЕР" ДЛЯ ОФЛАЙН-БОТА (зеркалит правила server.js)
// =====================================================================
function createLocalServer(toClient) {
  const ARENA_WIDTH = 800;
  const SWORD_RANGE = 120, SWORD_COST = 20, SWORD_HEAD_CHANCE = 0.25, SWORD_HEAD_DMG = 20, SWORD_TORSO_DMG = 15;
  const KICK_RANGE = 70, KICK_COST = 15, KICK_LEGS_DMG = 22;
  const TAKEDOWN_RANGE = 55, TAKEDOWN_COST = 30;
  const GROUND_DURATION = 4000, GROUND_POUND_RANGE = 70, GROUND_POUND_MULT = 1.6;
  const KNOCKBACK_HEAD_TORSO = 26, KNOCKBACK_LEGS = 10, HITSTUN_MS = 180;
  const ESCAPE_INCREMENT = 14, ESCAPE_THRESHOLD = 100;
  const STAMINA_REGEN = 3, STAMINA_TICK_MS = 300, LEGS_SLOW_THRESHOLD = 40;
  const COUNTDOWN_MS = 3000, MIN_DIST = 44, COMBO_WINDOW_MS = 700, COMBO_MULT = 1.3;

  function newPlayer(slot, name) {
    return { x: slot === 0 ? 150 : ARENA_WIDTH - 150, facing: slot === 0 ? 1 : -1, hp: { head: 100, torso: 100, legs: 100 }, stamina: 100, attacking: false, slot, name, lastHitType: null, lastHitTime: 0, grounded: false, groundedUntil: 0, hitstunUntil: 0, escapeProgress: 0 };
  }

  const state = { players: { human: newPlayer(0, myName), bot: newPlayer(1, 'Бот') }, startAt: 0 };

  function isDead(p) { return p.hp.head <= 0 || p.hp.torso <= 0; }
  function inCountdown() { return state.startAt && Date.now() < state.startAt; }
  function inHitstun(p) { return p.hitstunUntil && Date.now() < p.hitstunUntil; }
  function clampX(x) { return Math.max(20, Math.min(ARENA_WIDTH - 20, x)); }
  function resolveCollision(mover, opp) {
    if (opp.grounded) return;
    const diff = mover.x - opp.x;
    if (Math.abs(diff) < MIN_DIST) mover.x = clampX(opp.x + MIN_DIST * (diff < 0 ? -1 : 1));
  }
  function other(id) { return id === 'human' ? 'bot' : 'human'; }

  function move(id, dir) {
    const p = state.players[id];
    if (!p || inCountdown() || isDead(p) || p.grounded || inHitstun(p)) return;
    const speed = p.hp.legs <= LEGS_SLOW_THRESHOLD ? 5 : 10;
    p.x = clampX(p.x + dir * speed);
    resolveCollision(p, state.players[other(id)]);
    p.facing = dir !== 0 ? dir : p.facing;
    toClient.emit('state_update', state.players);
  }

  function struggle(id) {
    const p = state.players[id];
    if (!p || !p.grounded) return;
    p.escapeProgress = Math.min(100, (p.escapeProgress || 0) + ESCAPE_INCREMENT);
    if (p.escapeProgress >= ESCAPE_THRESHOLD) { p.grounded = false; p.groundedUntil = 0; p.escapeProgress = 0; }
    toClient.emit('state_update', state.players);
  }

  function attack(id, type) {
    const attacker = state.players[id];
    if (!attacker || inCountdown() || attacker.attacking || isDead(attacker) || attacker.grounded || inHitstun(attacker)) return;
    const opponent = state.players[other(id)];

    if (type === 'takedown') {
      if (attacker.stamina < TAKEDOWN_COST) { if (id === 'human') toClient.emit('attack_failed'); return; }
      attacker.stamina -= TAKEDOWN_COST;
      attacker.attacking = true;
      toClient.emit('attack_anim', { slot: attacker.slot, type: 'takedown' });

      if (!isDead(opponent) && !opponent.grounded) {
        const dist = Math.abs(opponent.x - attacker.x);
        const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) || (attacker.facing === -1 && opponent.x < attacker.x);
        if (dist < TAKEDOWN_RANGE && facingCorrect) {
          const chance = Math.max(0.25, Math.min(0.85, 0.55 + (attacker.stamina - opponent.stamina) / 300));
          const success = Math.random() < chance;
          if (success) { opponent.grounded = true; opponent.groundedUntil = Date.now() + GROUND_DURATION; opponent.escapeProgress = 0; }
          toClient.emit('takedown_result', { slot: opponent.slot, success });
        } else {
          toClient.emit('takedown_result', { slot: opponent.slot, success: false, whiffed: true });
        }
      }
      toClient.emit('state_update', state.players);
      setTimeout(() => { attacker.attacking = false; }, 600);
      return;
    }

    const isKick = type === 'kick';
    const cost = isKick ? KICK_COST : SWORD_COST;
    if (attacker.stamina < cost) { if (id === 'human') toClient.emit('attack_failed'); return; }

    attacker.stamina -= cost;
    attacker.attacking = true;
    toClient.emit('attack_anim', { slot: attacker.slot, type: isKick ? 'kick' : 'sword' });

    if (!isDead(opponent)) {
      const dist = Math.abs(opponent.x - attacker.x);
      let landed = false;
      if (opponent.grounded) landed = dist < GROUND_POUND_RANGE;
      else {
        const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) || (attacker.facing === -1 && opponent.x < attacker.x);
        const range = isKick ? KICK_RANGE : SWORD_RANGE;
        landed = dist < range && facingCorrect;
      }

      if (landed) {
        let part, damage;
        if (isKick) { part = 'legs'; damage = KICK_LEGS_DMG; }
        else { part = Math.random() < SWORD_HEAD_CHANCE ? 'head' : 'torso'; damage = part === 'head' ? SWORD_HEAD_DMG : SWORD_TORSO_DMG; }
        if (opponent.grounded) damage = Math.round(damage * GROUND_POUND_MULT);

        const now = Date.now();
        let isCombo = false;
        if (!opponent.grounded && attacker.lastHitType && attacker.lastHitType !== type && now - attacker.lastHitTime < COMBO_WINDOW_MS) {
          damage = Math.round(damage * COMBO_MULT); isCombo = true;
        }
        attacker.lastHitType = type; attacker.lastHitTime = now;
        opponent.hp[part] = Math.max(0, opponent.hp[part] - damage);

        if (!opponent.grounded) {
          const kb = part === 'legs' ? KNOCKBACK_LEGS : KNOCKBACK_HEAD_TORSO;
          opponent.x = clampX(opponent.x + kb * attacker.facing);
          opponent.hitstunUntil = now + HITSTUN_MS;
        }

        toClient.emit('hit', { slot: opponent.slot, part, damage, isCombo, grounded: !!opponent.grounded });
      }
    }

    toClient.emit('state_update', state.players);
    if (isDead(opponent)) toClient.emit('game_over', { winnerSlot: attacker.slot });
    setTimeout(() => { attacker.attacking = false; }, 500);
  }

  setInterval(() => {
    let changed = false;
    Object.values(state.players).forEach(p => {
      if (p.stamina < 100) { p.stamina = Math.min(100, p.stamina + STAMINA_REGEN); changed = true; }
      if (p.grounded && p.groundedUntil <= Date.now()) { p.grounded = false; p.groundedUntil = 0; p.escapeProgress = 0; changed = true; }
    });
    if (changed) toClient.emit('state_update', state.players);
  }, STAMINA_TICK_MS);

  function start() {
    toClient.emit('joined', { slot: 0, players: state.players });
    setTimeout(() => {
      state.startAt = Date.now() + COUNTDOWN_MS;
      toClient.emit('start_game', { players: state.players, startAt: state.startAt });
      runBotAI();
    }, 50);
  }

  function runBotAI() {
    let nextActionAt = Date.now() + 700;
    let moveDir = 0, moveUntil = 0;

    setInterval(() => {
      const bot = state.players.bot, human = state.players.human;
      if (isDead(bot) || isDead(human) || inCountdown()) return;

      if (bot.grounded) { struggle('bot'); return; }
      if (human.grounded) {
        const dist = Math.abs(human.x - bot.x);
        if (dist > GROUND_POUND_RANGE - 15) move('bot', human.x > bot.x ? 1 : -1);
        else if (Date.now() > nextActionAt && bot.stamina >= SWORD_COST) {
          attack('bot', Math.random() < 0.6 ? 'sword' : 'kick');
          nextActionAt = Date.now() + 350 + Math.random() * 250;
        }
        return;
      }

      const dist = Math.abs(human.x - bot.x);
      const dirToHuman = human.x > bot.x ? 1 : -1;

      if (Date.now() > moveUntil) {
        if (dist > KICK_RANGE - 10) moveDir = dirToHuman;
        else if (dist < 35) moveDir = -dirToHuman;
        else moveDir = Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0;
        moveUntil = Date.now() + 200 + Math.random() * 200;
      }
      move('bot', moveDir);

      if (Date.now() > nextActionAt) {
        const facingCorrect = (bot.facing === 1 && human.x > bot.x) || (bot.facing === -1 && human.x < bot.x);
        if (facingCorrect && dist < SWORD_RANGE) {
          if (dist < TAKEDOWN_RANGE && bot.stamina >= TAKEDOWN_COST && Math.random() < 0.25) attack('bot', 'takedown');
          else if (dist < KICK_RANGE && bot.stamina >= KICK_COST && Math.random() < 0.5) attack('bot', 'kick');
          else if (bot.stamina >= SWORD_COST) attack('bot', 'sword');
        }
        nextActionAt = Date.now() + 450 + Math.random() * 500;
      }
    }, 100);
  }

  return {
    move: (dir) => move('human', dir),
    attack: (type) => attack('human', type),
    struggle: () => struggle('human'),
    start,
  };
}

// =====================================================================
// ОНЛАЙН / ОФЛАЙН ПОДКЛЮЧЕНИЕ
// =====================================================================
let socket = null;
let localEngine = null;
let isOffline = false;

const onlineCountEl = document.getElementById('online-count');
const menuOverlay = document.getElementById('menu-overlay');
const playBtn = document.getElementById('play-btn');
const botBtn = document.getElementById('bot-btn');

function applyNames() {
  Object.values(players).forEach(p => { if (nameEls[p.slot] && p.name) nameEls[p.slot].textContent = p.name; });
}

function attachHandlers(bus) {
  bus.on('online_count', (count) => { onlineCountEl.textContent = count; });

  bus.on('joined', (data) => {
    mySlot = data.slot;
    players = data.players;
    statusEl.textContent = isOffline ? '' : 'Ждём соперника...';
    staminaWrap.style.display = 'block';
    applyNames(); updateHpBars(); updateStaminaBar();
  });

  bus.on('opponent_joined', (data) => { players = data.players; applyNames(); updateHpBars(); });

  bus.on('start_game', (data) => {
    players = data.players;
    fightStartAt = data.startAt || (Date.now() + 3000);
    statusEl.textContent = '';
    applyNames(); updateHpBars();
    let lastShown = null;
    const tick = setInterval(() => {
      const remain = Math.ceil((fightStartAt - Date.now()) / 1000);
      if (remain !== lastShown && remain > 0) { sndCountdownBeep(); lastShown = remain; }
      if (Date.now() >= fightStartAt) { sndFightGo(); haptic('medium'); showFightBanner = 60; clearInterval(tick); }
    }, 50);
  });

  bus.on('state_update', (p) => {
    Object.values(p).forEach(np => {
      const prevX = lastX[np.slot];
      if (prevX !== undefined && Math.abs(np.x - prevX) > 0.3) movingUntil[np.slot] = Date.now() + 150;
      lastX[np.slot] = np.x;
    });
    players = p;
    updateHpBars(); updateStaminaBar(); updateEscapeBar();
  });

  bus.on('attack_anim', ({ slot, type }) => {
    attackFlash = { slot, type };
    if (type === 'kick') sndKick(); else if (type === 'takedown') sndTakedown(); else sndSwordSwing();
    if (slot === mySlot) haptic('light');
    setTimeout(() => { if (attackFlash && attackFlash.slot === slot) attackFlash = null; }, type === 'kick' ? 260 : type === 'takedown' ? 400 : 220);
  });

  bus.on('takedown_result', ({ slot, success, whiffed }) => {
    if (whiffed) return;
    takedownBanner = { text: success ? 'ТЕЙКДАУН!' : 'УСТОЯЛ!', life: 45, color: success ? '#ff9d3d' : '#9fb0b8' };
    if (success) { sndThud(); screenShake = 14; if (slot === mySlot) haptic('heavy'); }
  });

  bus.on('hit', ({ slot, part, damage, isCombo, grounded }) => {
    screenShake = isCombo || grounded ? 13 : 8;
    sndHit();
    if (isCombo) { sndCombo(); comboBanner = 40; }

    const barEl = hpBarEls[slot][part];
    if (barEl) {
      const rect = barEl.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const bx = slot === 0 ? rect.right - canvasRect.left : rect.left - canvasRect.left;
      const by = rect.top - canvasRect.top + rect.height / 2;
      spawnBloodAt(bx, by);
      spawnDmgText(bx, by - 10, (isCombo ? 'КОМБО -' : '-') + (damage || ''), part === 'head' ? '#ffcf6b' : '#ff6b6b');
    }

    const hitPlayer = Object.values(players).find(pl => pl.slot === slot);
    if (hitPlayer) {
      const scale = canvas.width / 800;
      spawnSparks(hitPlayer.x * scale, canvas.height - 140, -hitPlayer.facing);
      addBodyStain(slot, part);
      addGroundStain(hitPlayer.x);
    }

    if (slot === mySlot) { haptic('heavy'); hitFlash.style.opacity = '1'; setTimeout(() => (hitFlash.style.opacity = '0'), 120); }
    else haptic('light');
  });

  bus.on('attack_failed', () => {
    sndFailed(); haptic('error');
    const old = statusEl.textContent;
    statusEl.textContent = 'Не хватает выносливости!';
    setTimeout(() => { if (statusEl.textContent === 'Не хватает выносливости!') statusEl.textContent = old === 'Не хватает выносливости!' ? '' : old; }, 700);
  });

  bus.on('room_full', () => { statusEl.textContent = 'Комната уже занята'; });
  bus.on('opponent_left', () => { statusEl.textContent = 'Соперник вышел из боя'; });

  bus.on('game_over', ({ winnerSlot }) => {
    const won = winnerSlot === mySlot;
    statusEl.textContent = won ? '🏆 Победа!' : '💀 Поражение';
    koSlot = winnerSlot === 0 ? 1 : 0;
    koStart = Date.now();
    if (won) { sndVictory(); haptic('notif'); spawnConfetti(); } else { sndDefeat(); haptic('error'); }
    setTimeout(() => { playBtn.textContent = 'ЕЩЁ РАЗ'; botBtn.style.display = 'none'; menuOverlay.style.display = 'flex'; }, 2200);
  });
}

playBtn.addEventListener('click', () => {
  ensureAudio();
  if (playBtn.textContent === 'ЕЩЁ РАЗ') { location.reload(); return; }
  menuOverlay.style.display = 'none';
  isOffline = false;
  socket = io();
  attachHandlers(socket);
  socket.emit('join_room', { roomId, name: myName });
});

botBtn.addEventListener('click', () => {
  ensureAudio();
  menuOverlay.style.display = 'none';
  isOffline = true;
  const bus = new MiniEmitter();
  attachHandlers(bus);
  localEngine = createLocalServer(bus);
  localEngine.start();
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
const takedownBtn = document.getElementById('takedown-btn');

function updateStaminaBar() {
  if (mySlot === null) return;
  const me = Object.values(players).find(pl => pl.slot === mySlot);
  if (!me) return;
  staminaBar.style.width = Math.max(0, me.stamina) + '%';
  staminaBar.style.background = me.stamina < 20 ? 'linear-gradient(#ff6b6b, #c94040)' : 'linear-gradient(#ffe066, #d9a521)';
  attackBtn.classList.toggle('btn-disabled', me.stamina < 20 || me.grounded);
  kickBtn.classList.toggle('btn-disabled', me.stamina < 15 || me.grounded);
  takedownBtn.classList.toggle('btn-disabled', me.stamina < 30 || me.grounded);
}

function updateEscapeBar() {
  if (mySlot === null) return;
  const me = Object.values(players).find(pl => pl.slot === mySlot);
  if (!me) return;
  if (me.grounded) {
    escapeWrap.style.display = 'block';
    escapeBar.style.width = (me.escapeProgress || 0) + '%';
  } else {
    escapeWrap.style.display = 'none';
  }
}

// ---------- ФОН: КЛЕТКА-АРЕНА ----------
function drawBackground() {
  const w = canvas.width, h = canvas.height;
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, '#20161f'); sky.addColorStop(0.5, '#3d2530'); sky.addColorStop(1, '#5c3430');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h * 0.6);

  const glowX = w / 2, glowY = h * 0.05;
  const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, w * 0.6);
  glow.addColorStop(0, 'rgba(255,220,160,0.25)'); glow.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h * 0.6);

  // сетка "клетки" сверху
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const cageTop = h * 0.42, cageBottom = h * 0.6;
  for (let x = -20; x < w + 20; x += 18) {
    ctx.beginPath(); ctx.moveTo(x, cageTop); ctx.lineTo(x + 24, cageBottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 24, cageTop); ctx.lineTo(x, cageBottom); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, cageTop); ctx.lineTo(w, cageTop); ctx.stroke();

  // мат (пол) со скошенными углами — намёк на октагон
  const groundGrad = ctx.createLinearGradient(0, cageBottom, 0, h);
  groundGrad.addColorStop(0, '#5a4436'); groundGrad.addColorStop(0.2, '#3e2f26'); groundGrad.addColorStop(1, '#1c140f');
  ctx.fillStyle = groundGrad;
  const cut = w * 0.07;
  ctx.beginPath();
  ctx.moveTo(cut, cageBottom);
  ctx.lineTo(w - cut, cageBottom);
  ctx.lineTo(w, cageBottom + (h - cageBottom) * 0.25);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.lineTo(0, cageBottom + (h - cageBottom) * 0.25);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const y = cageBottom + i * ((h - cageBottom) / 5);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + Math.sin(i) * 4); ctx.stroke();
  }

  // кровавые пятна на полу (стойкие)
  const scale = w / 800;
  groundStains.forEach(s => {
    const gx = s.arenaX * scale + s.offset;
    ctx.fillStyle = 'rgba(120,15,15,0.5)';
    ctx.beginPath();
    ctx.ellipse(gx, h - 8, s.size, s.size * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h);
  vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, w, h);
}

function drawGroundedFighter(p, x, scale) {
  const y = canvas.height - 26;
  const bodyColor = p.slot === 0 ? '#3f7a4f' : '#8a3d3d';
  const bodyShade = p.slot === 0 ? '#2b5638' : '#602a2a';
  const skin = '#e8b88a';
  const dir = p.facing;

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.ellipse(x, y + 2, 34, 8, 0, 0, Math.PI * 2); ctx.fill();

  // ноги лёжа
  ctx.fillStyle = '#241c18';
  ctx.fillRect(x - 40 * dir, y - 10, 22 * dir, 9);
  ctx.fillRect(x - 30 * dir, y - 20, 20 * dir, 8);

  // тело лёжа
  const bodyGrad = ctx.createLinearGradient(x - 22, y - 24, x + 22, y);
  bodyGrad.addColorStop(0, bodyColor); bodyGrad.addColorStop(1, bodyShade);
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(x - 20, y - 22, 40, 20);

  // руки лёжа
  ctx.fillStyle = bodyShade;
  ctx.fillRect(x + 16 * dir, y - 20, 16 * dir, 7);

  // голова
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(x + 30 * dir, y - 14, 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = bodyShade;
  ctx.beginPath(); ctx.arc(x + 30 * dir, y - 14, 12.5, Math.PI * 0.9, Math.PI * 2.1); ctx.fill();

  // пятна крови на теле
  bodyStains[p.slot].forEach(st => {
    ctx.fillStyle = 'rgba(140,15,15,0.55)';
    ctx.beginPath();
    ctx.arc(x + st.dx * 0.6, y - 12 + st.dy * 0.25, st.size * 0.8, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawFighter(p, renderX, scale) {
  if (p.grounded) { drawGroundedFighter(p, renderX, scale); return; }

  const x = renderX;
  const y = canvas.height - 90;
  const isFlash = attackFlash && attackFlash.slot === p.slot;
  const flashType = isFlash ? attackFlash.type : null;
  const bodyColor = p.slot === 0 ? '#3f7a4f' : '#8a3d3d';
  const bodyShade = p.slot === 0 ? '#2b5638' : '#602a2a';
  const skin = '#e8b88a';
  const legsHurt = p.hp.legs <= 40;

  const inKoFall = koSlot === p.slot && koStart && Date.now() - koStart < 700;
  const koProgress = inKoFall ? Math.min(1, (Date.now() - koStart) / 700) : 0;

  const isMoving = movingUntil[p.slot] && Date.now() < movingUntil[p.slot];
  walkPhase[p.slot] = isMoving ? walkPhase[p.slot] + (legsHurt ? 0.14 : 0.22) : walkPhase[p.slot] * 0.85;
  const wp = walkPhase[p.slot];
  const legSwing = Math.sin(wp) * 10;
  const armSwing = Math.sin(wp + Math.PI) * 8;
  const bob = Math.abs(Math.sin(wp)) * 2;
  const torsoTilt = Math.sin(wp) * 2;

  ctx.save();
  if (inKoFall) {
    ctx.translate(x, y);
    ctx.rotate((koProgress * 80 * p.facing * Math.PI) / 180);
    ctx.translate(-x, -y);
  }

  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(x, y + 4, 22, 6, 0, 0, Math.PI * 2); ctx.fill();
  const groundY = y - bob;

  ctx.fillStyle = bodyShade; ctx.beginPath();
  ctx.moveTo(x - 12 * p.facing, groundY - 62);
  ctx.quadraticCurveTo(x - 26 * p.facing, groundY - 35, x - 16 * p.facing, groundY - 2);
  ctx.lineTo(x - 4 * p.facing, groundY - 2); ctx.closePath(); ctx.fill();

  ctx.save(); ctx.translate(x - 5, groundY - 4); ctx.rotate((-legSwing * Math.PI) / 180 * 0.6);
  ctx.fillStyle = '#241c18'; ctx.fillRect(-4.5, -22, 9, 22);
  ctx.fillStyle = '#100c0a'; ctx.fillRect(-5.5, -2, 11, 4); ctx.restore();

  let kickAngle = flashType === 'kick' ? 55 : (isMoving ? -legSwing : 0);
  ctx.save(); ctx.translate(x + 7 * p.facing, groundY - 4); ctx.rotate((kickAngle * p.facing * Math.PI) / 180);
  ctx.fillStyle = legsHurt ? '#3a2018' : '#241c18'; ctx.fillRect(-4.5, -22, 9, 22);
  ctx.fillStyle = '#100c0a'; ctx.fillRect(-5.5, -2, 11, 4); ctx.restore();

  const swordWindup = flashType === 'sword' ? -8 : flashType === 'takedown' ? -14 : 0;
  ctx.save(); ctx.translate(x, groundY - 42); ctx.rotate(((torsoTilt + swordWindup) * p.facing * Math.PI) / 180);
  const bodyGrad = ctx.createLinearGradient(-16, -20, 16, 20);
  bodyGrad.addColorStop(0, bodyColor); bodyGrad.addColorStop(1, bodyShade);
  ctx.fillStyle = bodyGrad; ctx.fillRect(-16, -20, 32, 42);
  ctx.fillStyle = '#1a1410'; ctx.fillRect(-16, 16, 32, 5);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(0, 18); ctx.stroke(); ctx.restore();

  ctx.save(); ctx.translate(x - 18 * p.facing, groundY - 58); ctx.rotate((armSwing * p.facing * Math.PI) / 180 * 0.7);
  ctx.fillStyle = bodyShade; ctx.fillRect(0, 0, 6, 26); ctx.restore();

  ctx.save(); ctx.translate(x, groundY - 76); ctx.rotate(((torsoTilt + swordWindup) * p.facing * Math.PI) / 180 * 0.5);
  ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = bodyShade; ctx.beginPath(); ctx.arc(0, -4, 14.5, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#1a1410';
  const eyeShift = p.facing * 4;
  ctx.beginPath(); ctx.arc(eyeShift - 3, 0, 1.6, 0, Math.PI * 2); ctx.arc(eyeShift + 3, 0, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  const armSwingAttack = flashType === 'sword' ? -18 : flashType === 'takedown' ? -30 : -armSwing * 0.7;
  ctx.save(); ctx.translate(x + 15 * p.facing, groundY - 56); ctx.rotate((armSwingAttack * p.facing * Math.PI) / 180);
  ctx.fillStyle = bodyColor; ctx.fillRect(0, 0, p.facing * 6, 26); ctx.restore();

  if (flashType !== 'takedown') {
    const swingAngle = flashType === 'sword' ? -40 : 0;
    ctx.save(); ctx.translate(x + 20 * p.facing, groundY - 48); ctx.rotate((swingAngle * p.facing * Math.PI) / 180);
    const bladeLen = 44;
    const bladeGrad = ctx.createLinearGradient(0, 0, p.facing * bladeLen, 0);
    const swordActive = flashType === 'sword';
    bladeGrad.addColorStop(0, swordActive ? '#fff4c2' : '#e4ecf0');
    bladeGrad.addColorStop(1, swordActive ? '#ffe066' : '#9fb0b8');
    ctx.strokeStyle = bladeGrad; ctx.lineWidth = 4.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(p.facing * bladeLen, 0); ctx.stroke();
    ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(p.facing * -2, -6); ctx.lineTo(p.facing * -2, 6); ctx.stroke();
    ctx.strokeStyle = '#4a3222'; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(p.facing * -10, 0); ctx.stroke();
    ctx.restore();
  }

  if (flashType === 'sword') {
    ctx.fillStyle = 'rgba(255,224,102,0.45)'; ctx.beginPath(); ctx.arc(x + 55 * p.facing, groundY - 50, 16, 0, Math.PI * 2); ctx.fill();
  } else if (flashType === 'kick') {
    ctx.fillStyle = 'rgba(255,160,80,0.4)'; ctx.beginPath(); ctx.arc(x + 40 * p.facing, groundY - 10, 14, 0, Math.PI * 2); ctx.fill();
  } else if (flashType === 'takedown') {
    ctx.fillStyle = 'rgba(190,130,240,0.35)'; ctx.beginPath(); ctx.arc(x + 45 * p.facing, groundY - 30, 22, 0, Math.PI * 2); ctx.fill();
  }

  // пятна крови на теле (следуют за бойцом)
  bodyStains[p.slot].forEach(st => {
    ctx.fillStyle = 'rgba(140,15,15,0.5)';
    ctx.beginPath();
    ctx.arc(x + st.dx, groundY + st.dy, st.size, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();
}

function drawCountdown() {
  const w = canvas.width, h = canvas.height;

  if (fightStartAt) {
    const remainMs = fightStartAt - Date.now();
    if (remainMs > 0) {
      const secLeft = Math.ceil(remainMs / 1000);
      const scale = 1 + ((remainMs % 1000) / 1000) * 0.5;
      ctx.save(); ctx.globalAlpha = 0.85; ctx.translate(w / 2, h * 0.4); ctx.scale(scale, scale);
      ctx.font = 'bold 64px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffe066';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10;
      ctx.fillText(secLeft, 0, 0); ctx.restore();
    } else if (showFightBanner > 0) {
      ctx.save(); ctx.globalAlpha = Math.min(showFightBanner / 20, 1); ctx.translate(w / 2, h * 0.4);
      ctx.font = 'bold 46px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff6b6b';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 12;
      ctx.fillText('БОЙ!', 0, 0); ctx.restore();
      showFightBanner--;
    }
  }

  if (comboBanner > 0) {
    ctx.save(); ctx.globalAlpha = Math.min(comboBanner / 15, 1); ctx.translate(w / 2, h * 0.22);
    ctx.font = 'bold 30px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff9d3d';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8;
    ctx.fillText('КОМБО!', 0, 0); ctx.restore();
    comboBanner--;
  }

  if (takedownBanner) {
    ctx.save(); ctx.globalAlpha = Math.min(takedownBanner.life / 25, 1); ctx.translate(w / 2, h * 0.3);
    ctx.font = 'bold 32px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = takedownBanner.color;
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8;
    ctx.fillText(takedownBanner.text, 0, 0); ctx.restore();
    takedownBanner.life--;
    if (takedownBanner.life <= 0) takedownBanner = null;
  }
}

function draw() {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  if (screenShake > 0) {
    ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
    screenShake *= 0.85; if (screenShake < 0.3) screenShake = 0;
  }
  ctx.clearRect(-20, -20, w + 40, h + 40);
  drawBackground();

  const scale = w / 800;
  Object.values(players).forEach((p) => {
    if (displayX[p.slot] === undefined) displayX[p.slot] = p.x * scale;
    const target = p.x * scale;
    displayX[p.slot] += (target - displayX[p.slot]) * 0.28;
    drawFighter(p, displayX[p.slot], scale);
  });

  sparkEffects.forEach(s => {
    const alpha = Math.max(s.life / s.maxLife, 0);
    ctx.strokeStyle = `rgba(255,224,120,${alpha})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 1.5, s.y - s.vy * 1.5); ctx.stroke();
    s.x += s.vx; s.y += s.vy; s.vy += 0.15; s.life--;
  });
  sparkEffects = sparkEffects.filter(s => s.life > 0);

  bloodEffects.forEach(b => {
    const alpha = Math.max(b.life / b.maxLife, 0);
    ctx.fillStyle = `rgba(161,29,29,${alpha})`;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2); ctx.fill();
    b.x += b.vx; b.y += b.vy; b.vy += 0.22; b.life--;
  });
  bloodEffects = bloodEffects.filter(b => b.life > 0);

  dmgTexts.forEach(t => {
    ctx.save(); ctx.globalAlpha = Math.max(t.life / t.maxLife, 0);
    ctx.fillStyle = t.color; ctx.font = 'bold 14px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
    ctx.fillText(t.text, t.x, t.y); ctx.restore();
    t.y -= 0.6; t.life--;
  });
  dmgTexts = dmgTexts.filter(t => t.life > 0);

  confetti.forEach(c => {
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate((c.rot * Math.PI) / 180);
    ctx.fillStyle = c.color; ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size); ctx.restore();
    c.x += c.vx; c.y += c.vy; c.rot += c.vr; c.life--;
  });
  confetti = confetti.filter(c => c.life > 0 && c.y < canvas.height + 30);

  drawCountdown();
  ctx.restore();
  requestAnimationFrame(draw);
}
draw();

const zone = document.getElementById('joystick-zone');
const knob = document.getElementById('joystick-knob');
let dragging = false, moveInterval = null, currentDir = 0;

function setKnob(dx) {
  const max = 45;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = 51 + clampedX + 'px'; knob.style.top = '51px';
}
function startMoveLoop() {
  if (moveInterval) return;
  moveInterval = setInterval(() => {
    if (currentDir === 0) return;
    if (isOffline) localEngine?.move(currentDir); else socket?.emit('move', { dir: currentDir });
  }, 50);
}
function stopMoveLoop() { clearInterval(moveInterval); moveInterval = null; }
function handleStart() { dragging = true; startMoveLoop(); }
function handleMove(e) {
  if (!dragging) return;
  const touch = e.touches ? e.touches[0] : e;
  const rect = zone.getBoundingClientRect();
  const dx = touch.clientX - (rect.left + rect.width / 2);
  setKnob(dx);
  currentDir = dx > 15 ? 1 : dx < -15 ? -1 : 0;
}
function handleEnd() { dragging = false; currentDir = 0; knob.style.left = '51px'; stopMoveLoop(); }

zone.addEventListener('touchstart', handleStart);
zone.addEventListener('touchmove', handleMove);
zone.addEventListener('touchend', handleEnd);
zone.addEventListener('mousedown', handleStart);
window.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

function isMeGrounded() {
  if (mySlot === null) return false;
  const me = Object.values(players).find(pl => pl.slot === mySlot);
  return !!(me && me.grounded);
}

function doSwordAttack(e) {
  e.preventDefault();
  if (isMeGrounded()) { isOffline ? localEngine?.struggle() : socket?.emit('struggle'); return; }
  if (isOffline) localEngine?.attack('sword'); else socket?.emit('attack', { type: 'sword' });
}
function doKickAttack(e) {
  e.preventDefault();
  if (isMeGrounded()) { isOffline ? localEngine?.struggle() : socket?.emit('struggle'); return; }
  if (isOffline) localEngine?.attack('kick'); else socket?.emit('attack', { type: 'kick' });
}
function doTakedown(e) {
  e.preventDefault();
  if (isMeGrounded()) { isOffline ? localEngine?.struggle() : socket?.emit('struggle'); return; }
  if (isOffline) localEngine?.attack('takedown'); else socket?.emit('attack', { type: 'takedown' });
}

attackBtn.addEventListener('touchstart', doSwordAttack);
attackBtn.addEventListener('mousedown', doSwordAttack);
kickBtn.addEventListener('touchstart', doKickAttack);
kickBtn.addEventListener('mousedown', doKickAttack);
takedownBtn.addEventListener('touchstart', doTakedown);
takedownBtn.addEventListener('mousedown', doTakedown);
