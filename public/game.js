const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || tg?.initDataUnsafe?.start_param || 'default';

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');
function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
window.addEventListener('resize', resize);
resize();

const statusEl = document.getElementById('status');
const hpBars = [document.getElementById('hp0'), document.getElementById('hp1')];

let mySlot = null;
let players = {};
let attackFlashSlot = null;

const socket = io();
socket.emit('join_room', { roomId });

socket.on('joined', (data) => {
  mySlot = data.slot;
  players = data.players;
  statusEl.textContent = 'Ждём соперника...';
});

socket.on('opponent_joined', (data) => {
  players = data.players;
});

socket.on('start_game', (data) => {
  players = data.players;
  statusEl.textContent = '';
});

socket.on('state_update', (p) => {
  players = p;
  updateHpBars();
});

socket.on('attack_anim', ({ slot }) => {
  attackFlashSlot = slot;
  setTimeout(() => (attackFlashSlot = null), 200);
});

socket.on('room_full', () => {
  statusEl.textContent = 'Комната уже занята';
});

socket.on('opponent_left', () => {
  statusEl.textContent = 'Соперник вышел из боя';
});

socket.on('game_over', ({ winnerSlot }) => {
  statusEl.textContent = winnerSlot === mySlot ? '🏆 Победа!' : '💀 Поражение';
});

function updateHpBars() {
  Object.values(players).forEach((p) => {
    if (hpBars[p.slot]) hpBars[p.slot].style.width = p.hp + '%';
  });
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = canvas.width / 800;

  Object.values(players).forEach((p) => {
    const x = p.x * scale;
    const y = canvas.height -10;
    const color = p.slot === 0 ? '#4a7c59' : '#7c4a4a';
// ноги
    ctx.fillStyle = '#2b2320';
    ctx.fillRect(x - 12, y - 25, 9, 25);
    ctx.fillRect(x + 3, y - 25, 9, 25);

    // тело
    ctx.fillStyle = color;
    ctx.fillRect(x - 15, y - 60, 30, 40);
    
  
    ctx.beginPath();
    ctx.arc(x, y - 75, 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = attackFlashSlot === p.slot ? '#ffe066' : '#cfd8dc';
    ctx.lineWidth = 4;
    ctx.beginPath();
    const swordLen = 40 * p.facing;
    ctx.moveTo(x + 15 * p.facing, y - 40);
    ctx.lineTo(x + 15 * p.facing + swordLen, y - 40 - (attackFlashSlot === p.slot ? 20 : 0));
    ctx.stroke();
  });

  requestAnimationFrame(draw);
}
draw();

const zone = document.getElementById('joystick-zone');
const knob = document.getElementById('joystick-knob');
let dragging = false;
let moveInterval = null;
let currentDir = 0;

function setKnob(dx) {
  const max = 35;
  const clampedX = Math.max(-max, Math.min(max, dx));
  knob.style.left = 35 + clampedX + 'px';
  knob.style.top = '35px';
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
  knob.style.left = '35px';
  stopMoveLoop();
}

zone.addEventListener('touchstart', handleStart);
zone.addEventListener('touchmove', handleMove);
zone.addEventListener('touchend', handleEnd);
zone.addEventListener('mousedown', handleStart);
window.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

const attackBtn = document.getElementById('attack-btn');
function doAttack(e) {
  e.preventDefault();
  socket.emit('attack');
}
attackBtn.addEventListener('touchstart', doAttack);
attackBtn.addEventListener('mousedown', doAttack);
