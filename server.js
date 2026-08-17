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

const MOVES = {
  head:        { range: 100, cost: 12, dmg: 10, cooldown: 250, part: 'head',  blood: 8  },
  torso:       { range: 85,  cost: 18, dmg: 14, cooldown: 350, part: 'torso', blood: 8  },
  legs:        { range: 65,  cost: 24, dmg: 20, cooldown: 500, part: 'legs',  blood: 8  },
  power_punch: { range: 95,  cost: 40, dmg: 26, cooldown: 700, part: 'head',  blood: 16 },
  power_kick:  { range: 80,  cost: 45, dmg: 32, cooldown: 900, part: 'head',  blood: 18 },
};
const TORSO_CRIT_CHANCE = 0.15;
const TORSO_CRIT_BONUS = 10;
const STAMINA_REGEN = 4;
const STAMINA_REFUND_ON_HIT = 6;
const REGEN_INTERVAL = 200;
const BLOOD_STOP_THRESHOLD = 100;
const BLOCK_DAMAGE_MULT = 0.3;

const BOT_PRESETS = {
  easy:   { tick: 700, moveChance: 0.4,  attackChance: 0.22, blockChance: 0.05, powerChance: 0.05, preferredRange: 70 },
  medium: { tick: 450, moveChance: 0.55, attackChance: 0.4,  blockChance: 0.15, powerChance: 0.12, preferredRange: 60 },
  hard:   { tick: 280, moveChance: 0.65, attackChance: 0.55, blockChance: 0.3,  powerChance: 0.22, preferredRange: 55 },
};

function newPlayerState(slot) {
  return {
    x: slot === 0 ? 150 : ARENA_WIDTH - 150,
    facing: slot === 0 ? 1 : -1,
    parts: { head: 100, torso: 100, legs: 100 },
    stamina: 100,
    attacking: false,
    blocking: false,
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

function totalHealth(p) {
  return p.parts.head + p.parts.torso + p.parts.legs;
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: {}, order: [], tickInterval: null, botInterval: null,
      bloodLevel: 0, finished: false, isBot: false, botId: null, botDifficulty: null,
    });
  }
  return rooms.get(roomId);
}

function startRoomTick(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.tickInterval) return;
  room.tickInterval = setInterval(() => {
    if (room.finished) return;
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

function stopBotLoop(room) {
  if (room.botInterval) {
    clearInterval(room.botInterval);
    room.botInterval = null;
  }
}

function broadcastStats() {
  io.emit('stats_update', {
    online: io.engine.clientsCount,
    totalGames: totalGamesPlayed,
  });
}

function endFight(room, roomId, winnerSlot, reason) {
  room.finished = true;
  totalGamesPlayed += 1;
  io.to(roomId).emit('game_over', { winnerSlot, reason });
  broadcastStats();
  stopRoomTick(room);
  stopBotLoop(room);
}

function resolveAttack(room, roomId, socketLike, type) {
  if (room.finished) return;
  const move = MOVES[type];
  if (!move) return;
  const attacker = room.players[socketLike.id];
  if (!attacker || attacker.attacking || attacker.blocking || !isAlive(attacker)) return;

  if (attacker.stamina < move.cost) {
    socketLike.emit('too_tired');
    return;
  }
  attacker.stamina -= move.cost;
  attacker.attacking = true;
  io.to(roomId).emit('attack_anim', { slot: attacker.slot, target: type });

  const opponentId = room.order.find((id) => id !== socketLike.id);
  let hitPart = null;
  let hitBlocked = false;
  let hitCrit = false;
  let endedReason = null;
  let winnerSlot = null;

  if (opponentId) {
    const opponent = room.players[opponentId];
    const dist = Math.abs(opponent.x - attacker.x);
    const facingCorrect = (attacker.facing === 1 && opponent.x > attacker.x) ||
                           (attacker.facing === -1 && opponent.x < attacker.x);

    if (dist < move.range && facingCorrect && isAlive(opponent)) {
      const part = move.part;
      const prevLegs = opponent.parts.legs;
      let dmg = move.dmg;
      let isCrit = false;
      if (part === 'torso' && Math.random() < TORSO_CRIT_CHANCE) {
        dmg += TORSO_CRIT_BONUS;
        isCrit = true;
      }
      if (type === 'power_punch' || type === 'power_kick') {
        isCrit = true;
      }

      const blocked = !!opponent.blocking;
      if (blocked) dmg = Math.round(dmg * BLOCK_DAMAGE_MULT);

      opponent.parts[part] = Math.max(0, opponent.parts[part] - dmg);
      attacker.stamina = Math.min(100, attacker.stamina + (blocked ? 2 : STAMINA_REFUND_ON_HIT));
      hitPart = part;
      hitBlocked = blocked;
      hitCrit = isCrit;
      room.bloodLevel += blocked ? Math.round(move.blood * 0.15) : (isCrit ? Math.round(move.blood * 1.4) : move.blood);

      if (part === 'legs' && prevLegs > 0 && opponent.parts.legs <= 0) {
        endedReason = 'legs_broken';
        winnerSlot = attacker.slot;
      } else if (!isAlive(opponent)) {
        endedReason = 'knockout';
        winnerSlot = attacker.slot;
      } else if (room.bloodLevel >= BLOOD_STOP_THRESHOLD) {
        endedReason = 'blood';
        winnerSlot = totalHealth(attacker) >= totalHealth(opponent) ? attacker.slot : opponent.slot;
      }
    }
  }

  io.to(roomId).emit('state_update', room.players);
  if (hitPart && opponentId) {
    io.to(roomId).emit('hit_landed', {
      targetSlot: room.players[opponentId].slot,
      part: hitPart,
      blocked: hitBlocked,
      crit: hitCrit,
    });
  }
  if (endedReason) {
    endFight(room, roomId, winnerSlot, endedReason);
  }

  setTimeout(() => {
    if (attacker) attacker.attacking = false;
  }, move.cooldown);
}

function startBotLoop(room, roomId) {
  const preset = BOT_PRESETS[room.botDifficulty] || BOT_PRESETS.medium;
  room.botInterval = setInterval(() => {
    if (room.finished) return;
    const bot = room.players[room.botId];
    const humanId = room.order.find((id) => id !== room.botId);
    const human = room.players[humanId];
    if (!bot || !human || !isAlive(bot)) return;

    const dist = human.x - bot.x;
    const absDist = Math.abs(dist);
    bot.facing = dist > 0 ? 1 : -1;

    if (!bot.attacking && Math.random() < preset.moveChance) {
      let dir = 0;
      if (absDist > preset.preferredRange + 20) dir = dist > 0 ? 1 : -1;
      else if (absDist < preset.preferredRange - 15) dir = dist > 0 ? -1 : 1;
      if (dir !== 0 && isAlive(bot)) {
        const speed = moveSpeed(bot);
        bot.x += dir * speed;
        bot.x = Math.max(20, Math.min(ARENA_WIDTH - 20, bot.x));
        io.to(roomId).emit('state_update', room.players);
      }
    }

    if (human.attacking && !bot.blocking && Math.random() < preset.blockChance) {
      bot.blocking = true;
      io.to(roomId).emit('state_update', room.players);
      setTimeout(() => {
        const r2 = rooms.get(roomId);
        if (r2 && r2.players[room.botId]) {
          r2.players[room.botId].blocking = false;
          io.to(roomId).emit('state_update', r2.players);
        }
      }, 400);
      return;
    }

    if (!bot.attacking && !bot.blocking && absDist < 100 && Math.random() < preset.attackChance) {
      let type = 'head';
      const r = Math.random();
      if (r < preset.powerChance) type = Math.random() < 0.5 ? 'power_punch' : 'power_kick';
      else if (r < 0.55) type = 'torso';
      else if (r < 0.8) type = 'legs';
      resolveAttack(room, roomId, { id: room.botId, emit: () => {} }, type);
    }
  }, preset.tick);
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
      room.finished = false;
      room.bloodLevel = 0;
      io.to(roomId).emit('start_game', { players: room.players });
      startRoomTick(roomId);
    }
  });

  socket.on('join_bot', ({ difficulty }) => {
    const diff = BOT_PRESETS[difficulty] ? difficulty : 'medium';
    const roomId = 'bot_' + socket.id;
    const room = createRoom(roomId);
    room.isBot = true;
    room.botDifficulty = diff;
    room.botId = 'BOT_' + socket.id;

    room.players[socket.id] = newPlayerState(0);
    room.players[room.botId] = newPlayerState(1);
    room.order = [socket.id, room.botId];
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { slot: 0, players: room.players });
    room.finished = false;
    room.bloodLevel = 0;
    io.to(roomId).emit('start_game', { players: room.players });
    startRoomTick(roomId);
    startBotLoop(room, roomId);
  });

  socket.on('move', ({ dir }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id] || room.finished) return;
    const p = room.players[socket.id];
    if (!isAlive(p)) return;
    const speed = moveSpeed(p);
    p.x += dir * speed;
    p.x = Math.max(20, Math.min(ARENA_WIDTH - 20, p.x));
    p.facing = dir !== 0 ? dir : p.facing;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('block_start', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id] || room.finished) return;
    room.players[socket.id].blocking = true;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('block_end', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].blocking = false;
    io.to(roomId).emit('state_update', room.players);
  });

  socket.on('attack', ({ target }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!MOVES[target]) return;
    resolveAttack(room, roomId, socket, target);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (room) {
      delete room.players[socket.id];
      room.order = room.order.filter((id) => id !== socket.id);
      io.to(roomId).emit('opponent_left');
      if (room.order.length === 0 || room.isBot) {
        stopRoomTick(room);
        stopBotLoop(room);
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
