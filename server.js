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

// Побеждённые игроки (счётчик побед), ключ — telegram userId, если он передан с клиента,
// иначе socket.id (тогда счётчик не переживёт переподключение).
const winCounters = new Map();

// ---------- НАСТРОЙКИ БОЯ ----------
// Голова (кнопка "ГОЛОВА") -> джеб на дальней дистанции
const SWORD_RANGE = 120;
const SWORD_COST = 20;
const SWORD_HEAD_DMG = 20;

// Торс (кнопка "ТОРС") -> хук, может стать критическим
const HAND_RANGE = 90;
const HAND_COST = 12;
const HAND_TORSO_DMG = 15;

// Ноги (кнопка "НОГИ") -> пинок вблизи, самый сильный
const KICK_RANGE = 70;
const KICK_COST = 15;
const KICK_LEGS_DMG = 22;

const STAMINA_REGEN = 3;
const STAMINA_TICK_MS = 300;
const LEGS_SLOW_THRESHOLD = 40;

// Выносливость атакующего восстанавливается от каждого удачного попадания
const STAMINA_GAIN_ON_HIT = 10;
// Удар по торсу, который "ломает" его (добивает часть тела до 0) — критический
const CRITICAL_PART = 'torso';

// Соответствие типа удара -> (часть тела, урон, дистанция, стоимость, тип добивания)
const ATTACKS = {
  sword: { part: 'head', dmg: SWORD_HEAD_DMG, range: SWORD_RANGE, cost: SWORD_COST, finisher: 'ko_head' },
  hand: { part: 'torso', dmg: HAND_TORSO_DMG, range: HAND_RANGE, cost: HAND_COST, finisher: 'surrender' },
  kick: { part: 'legs', dmg: KICK_LEGS_DMG, range: KICK_RANGE, cost: KICK_COST, finisher: 'ko_legs' },
};

function newPlayerState(slot, userId) {
  return {
    x: slot === 0 ? 150 : ARENA_WIDTH - 150,
    facing: slot === 0 ? 1 : -1,
    hp: { head: 100, torso: 100, legs: 100 },
    stamina: 100,
    attacking: false,
    slot,
    userId: userId || null,
    alive: true,
  };
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: {}, order: [], finished: false });
  }
  return rooms.get(roomId);
}

function broadcastOnlineCount() {
  io.emit('online_count', io.engine.clientsCount);
}

function isDead(p) {
  return p.hp.head <= 0 || p.hp.torso <= 0 || p.hp.legs <= 0;
}

function winKey(p) {
  return p.userId || p.slotSocketId;
}

function addWin(p) {
  const key = winKey(p);
  if (!key) return 0;
  const total = (winCounters.get(key) || 0) + 1;
  winCounters.set(key, total);
  return total;
}

function getWins(p) {
  const key = winKey(p);
  return key ? (winCounters.get(key) || 0) : 0;
}

io.on('connection', (socket) => {
  broadcastOnlineCount();

  socket.on('join_room', ({ roomId, userId }) => {
    const room = createRoom(roomId);
    if (room.order.length >= 2) {
      socket.emit('room_full');
      return;
    }
    const slot = room.order.length;
    const player = newPlayerState(slot, userId);
    player.slotSocketId = socket.id;
    room.players[socket.id] = player;
    room.order.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { slot, players: room.players, wins: getWins(player) });
    socket.to(roomId).emit('opponent_joined', { slot, players: room.players });

    if (room.order.length === 2) {
      room.finished = false;
      io.to(roomId).emit('start_game', { players: room.players });
    }
  });

  socket.on('move', ({ dir }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.finished || !room.players[socket.id]) return;
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
    if (!room || room.finished || !room.players[socket.id]) return;

    const config = ATTACKS[type];
    if (!config) return; // неизвестный тип удара

    const attacker = room.players[socket.id];
    if (attacker.attacking || isDead(attacker)) return;

    if (attacker.stamina < config.cost) {
      socket.emit('attack_failed');
      return;
    }

    attacker.stamina -= config.cost;
    attacker.attacking = true;
    io.to(roomId).emit('attack_anim', { slot: attacker.slot, type });

    const opponentId = room.order.find((id) => id !== socket.id);

    if (opponentId) {
      const opponent = room.players[opponentId];
      const dist = Math.abs(opponent.x - attacker.x);
      const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) ||
                             (attacker.facing === -1 && opponent.x < attacker.x);

      if (dist < config.range && facingCorrect && !isDead(opponent)) {
        const part = config.part;
        opponent.hp[part] = Math.max(0, opponent.hp[part] - config.dmg);

        // выносливость атакующего растёт от удачного удара
        attacker.stamina = Math.min(100, attacker.stamina + STAMINA_GAIN_ON_HIT);

        // удар по торсу, добивший его до нуля — считается критическим
        const isCritical = part === CRITICAL_PART && opponent.hp[part] <= 0;

        io.to(roomId).emit('hit', {
          slot: opponent.slot,
          part,
          type,
          critical: isCritical,
          attackerSlot: attacker.slot,
        });

        if (opponent.hp[part] <= 0) {
          opponent.alive = false;
          room.finished = true;

          const totalWins = addWin(attacker);
          const finisher = isCritical ? 'body_break' : config.finisher;

          io.to(roomId).emit('game_over', {
            winnerSlot: attacker.slot,
            loserSlot: opponent.slot,
            finisher, // 'ko_head' | 'ko_legs' | 'surrender' | 'body_break'
            part,
            critical: isCritical,
            winnerWins: totalWins,
          });
        }
      }
    }

    io.to(roomId).emit('state_update', room.players);

    setTimeout(() => {
      attacker.attacking = false;
    }, 500);
  });

  // Запрос на новый раунд в той же комнате (сброс состояния)
  socket.on('rematch', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.order.length < 2) return;

    room.finished = false;
    room.order.forEach((id, slot) => {
      const old = room.players[id];
      const fresh = newPlayerState(slot, old.userId);
      fresh.slotSocketId = id;
      room.players[id] = fresh;
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
    broadcastOnlineCount();
  });
});

// ---------- РЕГЕНЕРАЦИЯ ВЫНОСЛИВОСТИ ----------
setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (room.finished || room.order.length < 2) return;
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
      ? '🥊 Ты присоединяешься к бою! Жми кнопку ниже.'
      : `🥊 Бой создан! Отправь другу ссылку-приглашение:\n${inviteLink}\n\nКогда друг перейдёт по ней — начинайте бой.`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '🥊 Открыть октагон', web_app: { url: gameUrl } }]],
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
