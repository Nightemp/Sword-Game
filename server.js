cat > /mnt/user-data/outputs/server.js << 'SERVEREOF'
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

// ---------- НАСТРОЙКИ БОЯ ----------
const SWORD_RANGE = 120;
const SWORD_COST = 20;
const SWORD_HEAD_CHANCE = 0.25;
const SWORD_HEAD_DMG = 20;
const SWORD_TORSO_DMG = 15;

const KICK_RANGE = 70;
const KICK_COST = 15;
const KICK_LEGS_DMG = 22;

const STAMINA_REGEN = 3;
const STAMINA_TICK_MS = 300;
const LEGS_SLOW_THRESHOLD = 40;

function newPlayerState(slot) {
  return {
    x: slot === 0 ? 150 : ARENA_WIDTH - 150,
    facing: slot === 0 ? 1 : -1,
    hp: { head: 100, torso: 100, legs: 100 },
    stamina: 100,
    attacking: false,
    slot,
  };
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: {}, order: [] });
  }
  return rooms.get(roomId);
}

function broadcastOnlineCount() {
  io.emit('online_count', io.engine.clientsCount);
}

function isDead(p) {
  return p.hp.head <= 0 || p.hp.torso <= 0;
}

io.on('connection', (socket) => {
  broadcastOnlineCount();

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
    }
  });

  socket.on('move', ({ dir }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (isDead(p)) return;

    const legsSlow = p.hp.legs <= LEGS_SLOW_THRESHOLD;
    const speed = legsSlow ? 5 : 10;

    p.x += dir * speed;
    p.x = Math.max(20, Math.min(ARENA_WIDTH - 20, p.x));
    p.facing = dir !== 0 ? dir : p.facing;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('attack', ({ type }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    const attacker = room.players[socket.id];
    if (attacker.attacking || isDead(attacker)) return;

    const isKick = type === 'kick';
    const cost = isKick ? KICK_COST : SWORD_COST;

    if (attacker.stamina < cost) {
      socket.emit('attack_failed');
      return;
    }

    attacker.stamina -= cost;
    attacker.attacking = true;
    io.to(roomId).emit('attack_anim', { slot: attacker.slot, type: isKick ? 'kick' : 'sword' });

    const opponentId = room.order.find((id) => id !== socket.id);
    if (opponentId) {
      const opponent = room.players[opponentId];
      const dist = Math.abs(opponent.x - attacker.x);
      const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) ||
                             (attacker.facing === -1 && opponent.x < attacker.x);
      const range = isKick ? KICK_RANGE : SWORD_RANGE;

      if (dist < range && facingCorrect && !isDead(opponent)) {
        let part, damage;
        if (isKick) {
          part = 'legs';
          damage = KICK_LEGS_DMG;
        } else {
          part = Math.random() < SWORD_HEAD_CHANCE ? 'head' : 'torso';
          damage = part === 'head' ? SWORD_HEAD_DMG : SWORD_TORSO_DMG;
        }
        opponent.hp[part] = Math.max(0, opponent.hp[part] - damage);
        io.to(roomId).emit('hit', { slot: opponent.slot, part });
      }
    }

    io.to(roomId).emit('state_update', room.players);

    if (opponentId && isDead(room.players[opponentId])) {
      io.to(roomId).emit('game_over', { winnerSlot: attacker.slot });
    }

    setTimeout(() => {
      attacker.attacking = false;
    }, 500);
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

// ---------- РЕГЕНЕРАЦИЯ ВЫНОСЛИВОСТИ ----------
setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (room.order.length < 2) return;
    let changed = false;
    Object.values(room.players).forEach((p) => {
      if (p.stamina < 100) {
        p.stamina = Math.min(100, p.stamina + STAMINA_REGEN);
        changed = true;
      }
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
SERVEREOF
echo done