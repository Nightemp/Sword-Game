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

function freshPlayerState(slot) {
  return {
    x: slot === 0 ? 150 : ARENA_WIDTH - 150,
    facing: slot === 0 ? 1 : -1,
    hp: 100,
    stamina: 100,
    attacking: false,
    blocking: false,
    knockedOut: false,
    slot,
  };
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: {}, order: [], loopStarted: false });
  }
  return rooms.get(roomId);
}

function broadcastStats() {
  io.emit('stats_update', {
    online: io.engine.clientsCount,
    totalGames: totalGamesPlayed,
  });
}

function startStaminaLoop(room, roomId) {
  if (room.loopStarted) return;
  room.loopStarted = true;
  setInterval(() => {
    let changed = false;
    Object.values(room.players).forEach((p) => {
      if (p.knockedOut) return;
      const regenRate = p.blocking ? 0.4 : 0.8;
      if (p.stamina < 100) {
        p.stamina = Math.min(100, p.stamina + regenRate);
        changed = true;
      }
    });
    if (changed) io.to(roomId).emit('state_update', room.players);
  }, 200);
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
    room.players[socket.id] = freshPlayerState(slot);
    room.order.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { slot, players: room.players });
    socket.to(roomId).emit('opponent_joined', { slot, players: room.players });

    if (room.order.length === 2) {
      io.to(roomId).emit('start_game', { players: room.players });
      startStaminaLoop(room, roomId);
    }
  });

  socket.on('move', ({ dir }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (p.knockedOut) return;
    const staminaFactor = 0.4 + 0.6 * (p.stamina / 100);
    const speed = 10 * staminaFactor;
    p.x += dir * speed;
    p.x = Math.max(20, Math.min(ARENA_WIDTH - 20, p.x));
    p.facing = dir !== 0 ? dir : p.facing;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('block_start', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (p.knockedOut || p.attacking) return;
    p.blocking = true;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('block_end', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].blocking = false;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('attack', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const attacker = room.players[socket.id];
    if (attacker.attacking || attacker.blocking || attacker.knockedOut) return;
    const STAMINA_COST = 16;
    if (attacker.stamina < STAMINA_COST) {
      socket.emit('attack_denied');
      return;
    }
    attacker.stamina -= STAMINA_COST;
    attacker.attacking = true;
    io.to(roomId).emit('attack_anim', { slot: attacker.slot });

    const opponentId = room.order.find((id) => id !== socket.id);
    let hit = false;
    let blocked = false;
    if (opponentId) {
      const opponent = room.players[opponentId];
      const dist = Math.abs(opponent.x - attacker.x);
      const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) ||
                             (attacker.facing === -1 && opponent.x < attacker.x);
      if (dist < 70 && facingCorrect && !opponent.knockedOut) {
        if (opponent.blocking) {
          blocked = true;
          opponent.stamina = Math.max(0, opponent.stamina - 10);
          opponent.hp = Math.max(0, opponent.hp - 2);
          opponent.x = Math.max(20, Math.min(ARENA_WIDTH - 20, opponent.x + attacker.facing * 6));
        } else {
          opponent.hp = Math.max(0, opponent.hp - 12);
          opponent.x = Math.max(20, Math.min(ARENA_WIDTH - 20, opponent.x + attacker.facing * 18));
          hit = true;
        }
      }
    }

    io.to(roomId).emit('state_update', room.players);
    if (hit) {
      io.to(roomId).emit('hit_landed', { targetSlot: room.players[opponentId].slot });
    } else if (blocked) {
      io.to(roomId).emit('block_landed', { targetSlot: room.players[opponentId].slot });
    }

    if (opponentId && room.players[opponentId].hp <= 0 && !room.players[opponentId].knockedOut) {
      room.players[opponentId].knockedOut = true;
      totalGamesPlayed += 1;
      io.to(roomId).emit('knockout', { winnerSlot: attacker.slot, loserSlot: room.players[opponentId].slot });
      io.to(roomId).emit('state_update', room.players);
      broadcastStats();
    }

    setTimeout(() => {
      if (room.players[socket.id]) room.players[socket.id].attacking = false;
    }, 300);
  });

  socket.on('rematch', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    room.order.forEach((id) => {
      const slot = room.players[id].slot;
      room.players[id] = freshPlayerState(slot);
    });
    io.to(roomId).emit('start_game', { players: room.players });
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
