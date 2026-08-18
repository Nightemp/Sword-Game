const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN || !PUBLIC_URL) {
  console.error('Задайте BOT_TOKEN и PUBLIC_URL в переменных окружения');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const ARENA_WIDTH = 800;
const rooms = new Map();

const SWORD_RANGE = 120, SWORD_COST = 20, SWORD_HEAD_CHANCE = 0.25, SWORD_HEAD_DMG = 20, SWORD_TORSO_DMG = 15;
const KICK_RANGE = 70, KICK_COST = 15, KICK_LEGS_DMG = 22;
const TAKEDOWN_RANGE = 55, TAKEDOWN_COST = 30;
const GROUND_DURATION = 4000, GROUND_POUND_RANGE = 70, GROUND_POUND_MULT = 1.6;
const KNOCKBACK_HEAD_TORSO = 26, KNOCKBACK_LEGS = 10, HITSTUN_MS = 180;
const ESCAPE_INCREMENT = 14, ESCAPE_THRESHOLD = 100;

const STAMINA_REGEN = 3, STAMINA_TICK_MS = 300, LEGS_SLOW_THRESHOLD = 40;
const COUNTDOWN_MS = 3000, MIN_DIST = 44, COMBO_WINDOW_MS = 700, COMBO_MULT = 1.3;

function newPlayerState(slot, name) {
  return {
    x: slot === 0 ? 150 : ARENA_WIDTH - 150,
    facing: slot === 0 ? 1 : -1,
    hp: { head: 100, torso: 100, legs: 100 },
    stamina: 100,
    attacking: false,
    slot,
    name: (name || 'Игрок').slice(0, 16),
    lastHitType: null,
    lastHitTime: 0,
    grounded: false,
    groundedUntil: 0,
    hitstunUntil: 0,
    escapeProgress: 0,
  };
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { players: {}, order: [], startAt: 0 });
  return rooms.get(roomId);
}

function broadcastOnlineCount() { io.emit('online_count', io.engine.clientsCount); }
function isDead(p) { return p.hp.head <= 0 || p.hp.torso <= 0; }
function inCountdown(room) { return room.startAt && Date.now() < room.startAt; }
function inHitstun(p) { return p.hitstunUntil && Date.now() < p.hitstunUntil; }
function clampX(x) { return Math.max(20, Math.min(ARENA_WIDTH - 20, x)); }

function resolveCollision(mover, opponent) {
  if (!opponent || opponent.grounded) return;
  const diff = mover.x - opponent.x;
  if (Math.abs(diff) < MIN_DIST) mover.x = clampX(opponent.x + MIN_DIST * (diff < 0 ? -1 : 1));
}

io.on('connection', (socket) => {
  broadcastOnlineCount();

  socket.on('join_room', ({ roomId, name }) => {
    const room = createRoom(roomId);
    if (room.order.length >= 2) { socket.emit('room_full'); return; }
    const slot = room.order.length;
    room.players[socket.id] = newPlayerState(slot, name);
    room.order.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { slot, players: room.players });
    socket.to(roomId).emit('opponent_joined', { slot, players: room.players });

    if (room.order.length === 2) {
      room.startAt = Date.now() + COUNTDOWN_MS;
      io.to(roomId).emit('start_game', { players: room.players, startAt: room.startAt });
    }
  });

  socket.on('move', ({ dir }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id] || inCountdown(room)) return;
    const p = room.players[socket.id];
    if (isDead(p) || p.grounded || inHitstun(p)) return;

    const speed = p.hp.legs <= LEGS_SLOW_THRESHOLD ? 5 : 10;
    p.x = clampX(p.x + dir * speed);

    const opponentId = room.order.find((id) => id !== socket.id);
    if (opponentId) resolveCollision(p, room.players[opponentId]);

    p.facing = dir !== 0 ? dir : p.facing;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('struggle', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (!p.grounded) return;
    p.escapeProgress = Math.min(100, (p.escapeProgress || 0) + ESCAPE_INCREMENT);
    if (p.escapeProgress >= ESCAPE_THRESHOLD) {
      p.grounded = false; p.groundedUntil = 0; p.escapeProgress = 0;
    }
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('attack', ({ type }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id] || inCountdown(room)) return;
    const attacker = room.players[socket.id];
    if (attacker.attacking || isDead(attacker) || attacker.grounded || inHitstun(attacker)) return;

    const opponentId = room.order.find((id) => id !== socket.id);
    const opponent = opponentId ? room.players[opponentId] : null;

    // ---------- ТЕЙКДАУН ----------
    if (type === 'takedown') {
      if (attacker.stamina < TAKEDOWN_COST) { socket.emit('attack_failed'); return; }
      attacker.stamina -= TAKEDOWN_COST;
      attacker.attacking = true;
      io.to(roomId).emit('attack_anim', { slot: attacker.slot, type: 'takedown' });

      if (opponent && !isDead(opponent) && !opponent.grounded) {
        const dist = Math.abs(opponent.x - attacker.x);
        const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) || (attacker.facing === -1 && opponent.x < attacker.x);
        if (dist < TAKEDOWN_RANGE && facingCorrect) {
          const chance = Math.max(0.25, Math.min(0.85, 0.55 + (attacker.stamina - opponent.stamina) / 300));
          const success = Math.random() < chance;
          if (success) { opponent.grounded = true; opponent.groundedUntil = Date.now() + GROUND_DURATION; opponent.escapeProgress = 0; }
          io.to(roomId).emit('takedown_result', { slot: opponent.slot, success });
        } else {
          io.to(roomId).emit('takedown_result', { slot: opponent.slot, success: false, whiffed: true });
        }
      }
      io.to(roomId).emit('state_update', room.players);
      setTimeout(() => { attacker.attacking = false; }, 600);
      return;
    }

    // ---------- МЕЧ / ПИНОК (в т.ч. добивание лежащего) ----------
    const isKick = type === 'kick';
    const cost = isKick ? KICK_COST : SWORD_COST;
    if (attacker.stamina < cost) { socket.emit('attack_failed'); return; }

    attacker.stamina -= cost;
    attacker.attacking = true;
    io.to(roomId).emit('attack_anim', { slot: attacker.slot, type: isKick ? 'kick' : 'sword' });

    if (opponent && !isDead(opponent)) {
      const dist = Math.abs(opponent.x - attacker.x);
      let landed = false;
      if (opponent.grounded) {
        landed = dist < GROUND_POUND_RANGE;
      } else {
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
          damage = Math.round(damage * COMBO_MULT);
          isCombo = true;
        }
        attacker.lastHitType = type; attacker.lastHitTime = now;

        opponent.hp[part] = Math.max(0, opponent.hp[part] - damage);

        if (!opponent.grounded) {
          const kb = part === 'legs' ? KNOCKBACK_LEGS : KNOCKBACK_HEAD_TORSO;
          opponent.x = clampX(opponent.x + kb * attacker.facing);
          opponent.hitstunUntil = now + HITSTUN_MS;
        }

        io.to(roomId).emit('hit', { slot: opponent.slot, part, damage, isCombo, grounded: !!opponent.grounded });
      }
    }

    io.to(roomId).emit('state_update', room.players);
    if (opponent && isDead(opponent)) io.to(roomId).emit('game_over', { winnerSlot: attacker.slot });

    setTimeout(() => { attacker.attacking = false; }, 500);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (room) {
      delete room.players[socket.id];
      room.order = room.order.filter((id) => id !== socket.id);
      io.to(roomId).emit('opponent_left');
      if (room.order.length === 0) rooms.delete(roomId);
    }
    broadcastOnlineCount();
  });
});

setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (room.order.length < 2) return;
    let changed = false;
    Object.values(room.players).forEach((p) => {
      if (p.stamina < 100) { p.stamina = Math.min(100, p.stamina + STAMINA_REGEN); changed = true; }
      if (p.grounded && p.groundedUntil <= Date.now()) { p.grounded = false; p.groundedUntil = 0; p.escapeProgress = 0; changed = true; }
    });
    if (changed) io.to(roomId).emit('state_update', room.players);
  });
}, STAMINA_TICK_MS);

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const payload = ctx.startPayload;
  const roomId = payload || crypto.randomBytes(4).toString('hex');
  const gameUrl = `${PUBLIC_URL}/?room=${roomId}`;
  const inviteLink = `https://t.me/${ctx.botInfo.username}?start=${roomId}`;

  ctx.reply(
    payload
      ? '⚔️ Ты присоединяешься к бою! Жми кнопку ниже.'
      : `⚔️ Бой создан! Отправь другу ссылку-приглашение:\n${inviteLink}\n\nКогда друг перейдёт по ней — начинайте бой.`,
    { reply_markup: { inline_keyboard: [[{ text: '🗡 Открыть арену', web_app: { url: gameUrl } }]] } }
  );
});

bot.launch();
console.log('Бот запущен');

server.listen(process.env.PORT || 3000, () => {
  console.log('Сервер игры запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
