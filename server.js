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
let totalGamesPlayed = 0;

const RANGES = { head: 100, torso: 85, legs: 65 };
const COSTS = { head: 12, torso: 18, legs: 24 };
const DAMAGE = { head: 10, torso: 14, legs: 20 };
const COOLDOWN = { head: 250, torso: 350, legs: 500 };
const TORSO_CRIT_CHANCE = 0.15;
const TORSO_CRIT_BONUS = 10;
const STAMINA_REGEN = 4;
const STAMINA_REFUND_ON_HIT = 6;
const REGEN_INTERVAL = 200;

function newPlayerState(slot) {
  return {
    x: slot === 0 ? 150 : ARENA_WIDTH - 150,
    facing: slot === 0 ? 1 : -1,
    parts: { head: 100, torso: 100, legs: 100 },
    stamina: 100,
    attacking: false,
    slot,
  };
}

function moveSpeed(p) {
  if (p.parts.legs <= 0) return 3;
  if (p.parts.legs <= 40) return 6;
  return 10;
}

function isAlive(p) {
  return p.parts.head > 0 && p.parts.torso > 0;
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: {}, order: [], tickInterval: null });
  }
  return rooms.get(roomId);
}

function startRoomTick(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.tickInterval) return;
  room.tickInterval = setInterval(() => {
    let changed = false;
    Object.values(room.players).forEach((p) => {
      if (p.stamina < 100) {
        p.stamina = Math.min(100, p.stamina + STAMINA_REGEN);
        changed = true;
      }
    });
    if (changed) io.to(roomId).emit('state_update', room.players);
  }, REGEN_INTERVAL);
}

function stopRoomTick(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

function broadcastStats() {
  io.emit('stats_update', {
    online: io.engine.clientsCount,
    totalGames: totalGamesPlayed,
  });
}

function resolveAttack(room, roomId, socket, target) {
  const attacker = room.players[socket.id];
  if (!attacker || attacker.attacking || !isAlive(attacker)) return;

  const cost = COSTS[target];
  if (attacker.stamina < cost) {
    socket.emit('too_tired');
    return;
  }
  attacker.stamina -= cost;
  attacker.attacking = true;
  io.to(roomId).emit('attack_anim', { slot: attacker.slot, target });

  const opponentId = room.order.find((id) => id !== socket.id);
  let hitPart = null;

  if (opponentId) {
    const opponent = room.players[opponentId];
    const dist = Math.abs(opponent.x - attacker.x);
    const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) ||
                           (attacker.facing === -1 && opponent.x < attacker.x);

    if (dist < RANGES[target] && facingCorrect && isAlive(opponent)) {
      hitPart = target;
      let dmg = DAMAGE[target];
      if (target === 'torso' && Math.random() < TORSO_CRIT_CHANCE) {
        dmg += TORSO_CRIT_BONUS;
      }
      opponent.parts[target] = Math.max(0, opponent.parts[target] - dmg);
      attacker.stamina = Math.min(100, attacker.stamina + STAMINA_REFUND_ON_HIT);
    }
  }

  io.to(roomId).emit('state_update', room.players);

  if (hitPart && opponentId) {
    io.to(roomId).emit('hit_landed', { targetSlot: room.players[opponentId].slot, part: hitPart });
  }

  if (opponentId && !isAlive(room.players[opponentId])) {
    totalGamesPlayed += 1;
    io.to(roomId).emit('game_over', { winnerSlot: attacker.slot });
    broadcastStats();
  }

  setTimeout(() => {
    if (attacker) attacker.attacking = false;
  }, COOLDOWN[target]);
}

io.on('connection', (socket) => {
  broadcastStats();

  socket.on('get_stats', () => {
    socket.emit('stats_update', {
      online: io.engine.clientsCount,
      totalGames: totalGamesPlayed,
    });
  });

  socket.on('join_room', ({ roomId }) => {
    const room = createRoom(roomId);
    if (room.order.length >= 2) {
      socket.emit('room_full');
      return;
    }
    const slot = room.order.length;
    room.players[socket.id] = newPlayerState(slot);
    room.order.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { slot, players: room.players });
    socket.to(roomId).emit('opponent_joined', { slot, players: room.players });

    if (room.order.length === 2) {
      io.to(roomId).emit('start_game', { players: room.players });
      startRoomTick(roomId);
    }
  });

  socket.on('move', ({ dir }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (!isAlive(p)) return;
    const speed = moveSpeed(p);
    p.x += dir * speed;
    p.x = Math.max(20, Math.min(ARENA_WIDTH - 20, p.x));
    p.facing = dir !== 0 ? dir : p.facing;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('attack', ({ target }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (target !== 'head' && target !== 'torso' && target !== 'legs') return;
    resolveAttack(room, roomId, socket, target);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (room) {
      delete room.players[socket.id];
      room.order = room.order.filter((id) => id !== socket.id);
      io.to(roomId).emit('opponent_left');
      if (room.order.length === 0) {
        stopRoomTick(room);
        rooms.delete(roomId);
      }
    }
    broadcastStats();
  });
});

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
    {
      reply_markup: {
        inline_keyboard: [[{ text: '🗡 Открыть арену', web_app: { url: gameUrl } }]],
      },
    }
  );
});

bot.launch();
console.log('Бот запущен');

server.listen(process.env.PORT || 3000, () => {
  console.log('Сервер игры запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
