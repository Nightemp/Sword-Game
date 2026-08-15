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
    socket.emit
