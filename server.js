// ArchViz Luxury Studio: multiplayer server
// Express serves the game from /public, Socket.IO keeps every room in sync.
// The server is the source of truth: clients ASK to place/remove, the server validates and broadcasts.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_W = 16, ROOM_D = 12;          // must match W / D in public/index.html (metres)
const MAX_OBJECTS = 300;                  // per room
const MAX_PLACES_PER_SEC = 8;             // simple anti-spam
const TYPES = new Set(['sofa', 'bed', 'table', 'chair', 'rug', 'bookshelf', 'tv', 'wall', 'door', 'lamp', 'fireplace', 'armchair', 'coffee', 'plant',
  'kitchen', 'fridge', 'island', 'desk', 'bathtub', 'toilet', 'vanity']);
const DATA_FILE = path.join(__dirname, 'data', 'rooms.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Addresses other devices on the same Wi-Fi can use to reach this laptop
function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${PORT}`);
  }
  return urls;
}
app.get('/api/lan', (_req, res) => res.json({ urls: lanUrls() }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ------------------------------------------------------------------ room state + persistence
/** rooms: name → { objects: [{id,type,x,z,rot,aabb,walkable,by}], env: {night,rain}, players: Map<socketId, player> } */
const rooms = new Map();

function loadRooms() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [name, r] of Object.entries(saved)) rooms.set(name, { objects: r.objects || [], env: r.env || { night: 0, rain: 0 }, players: new Map() });
    console.log(`Loaded ${rooms.size} saved room(s)`);
  } catch { /* first run: no file yet */ }
}
let saveTimer = null;
function saveSoon() {                      // debounce writes: at most once per second
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [name, r] of rooms) out[name] = { objects: r.objects.map(({ lockedBy, lockName, ...o }) => o), env: r.env };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFile(DATA_FILE, JSON.stringify(out), (err) => err && console.error('Save failed:', err.message));
  }, 1000);
}
function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { objects: [], env: { night: 0, rain: 0 }, players: new Map() });
  return rooms.get(name);
}

// ------------------------------------------------------------------ validation helpers
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const cleanText = (v, fallback, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);
const cleanRoom = (v) => cleanText(v, 'house', 40).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'house';
const overlap = (a, b, m = 0.01) => a.minX < b.maxX - m && a.maxX > b.minX + m && a.minZ < b.maxZ - m && a.maxZ > b.minZ + m;

function validatePlacement(room, d, ignoreId = null) {
  if (!TYPES.has(d.type)) return 'unknown item';
  if (!num(d.x, -ROOM_W / 2, ROOM_W / 2) || !num(d.z, -ROOM_D / 2, ROOM_D / 2) || !num(d.rot, -1000, 1000)) return 'bad position';
  const a = d.aabb;
  if (!a || !num(a.minX, -ROOM_W, ROOM_W) || !num(a.maxX, -ROOM_W, ROOM_W) || !num(a.minZ, -ROOM_D, ROOM_D) || !num(a.maxZ, -ROOM_D, ROOM_D)) return 'bad size';
  if (a.maxX - a.minX > 4.5 || a.maxZ - a.minZ > 4.5) return 'too large';
  if (a.minX < -ROOM_W / 2 - 0.01 || a.maxX > ROOM_W / 2 + 0.01 || a.minZ < -ROOM_D / 2 - 0.01 || a.maxZ > ROOM_D / 2 + 0.01) return 'outside the room';
  if (!ignoreId && room.objects.length >= MAX_OBJECTS) return 'room is full';
  if (!d.walkable && room.objects.some(o => o.id !== ignoreId && !o.walkable && overlap(a, o.aabb))) return 'space already taken';
  return null;
}

// ------------------------------------------------------------------ realtime
io.on('connection', (socket) => {
  let roomName = null, me = null, room = null;
  let placeBudget = MAX_PLACES_PER_SEC, budgetTime = Date.now();

  function releaseLocks() {
    if (!room) return;
    for (const o of room.objects) if (o.lockedBy === socket.id) {
      delete o.lockedBy; delete o.lockName;
      io.to(roomName).emit('unlocked', { id: o.id, x: o.x, z: o.z, rot: o.rot });
    }
  }
  function leave() {
    if (!room) return;
    releaseLocks();
    room.players.delete(socket.id);
    socket.to(roomName).emit('playerLeft', { id: socket.id });
    socket.leave(roomName);
    room = null; roomName = null; me = null;
  }

  socket.on('join', (d = {}) => {
    leave();
    roomName = cleanRoom(d.room);
    room = getRoom(roomName);
    me = {
      id: socket.id,
      name: cleanText(d.name, 'Architect', 24),
      color: Number.isInteger(d.color) ? d.color & 0xffffff : 0x6366f1,
      avatar: d.avatar === 'girl' ? 'girl' : 'boy',
      x: 0, z: 0, yaw: 0, pitch: 0,
    };
    room.players.set(socket.id, me);
    socket.join(roomName);
    socket.emit('init', { you: socket.id, objects: room.objects.map(({ lockedBy, ...o }) => o), players: [...room.players.values()], env: room.env });
    socket.to(roomName).emit('playerJoined', me);
    console.log(`${me.name} joined "${roomName}" (${room.players.size} online)`);
  });

  socket.on('place', (d = {}) => {
    if (!room) return;
    const now = Date.now();                                   // refill the rate-limit bucket
    placeBudget = Math.min(MAX_PLACES_PER_SEC, placeBudget + ((now - budgetTime) / 1000) * MAX_PLACES_PER_SEC);
    budgetTime = now;
    const tempId = typeof d.tempId === 'string' ? d.tempId.slice(0, 80) : null;
    if (placeBudget < 1) return socket.emit('rejected', { tempId, reason: 'slow down' });
    placeBudget -= 1;
    const reason = validatePlacement(room, d);
    if (reason) return socket.emit('rejected', { tempId, reason });
    const a = d.aabb;
    const item = {
      id: crypto.randomUUID(), type: d.type, x: d.x, z: d.z, rot: d.rot, walkable: !!d.walkable, by: me.name,
      aabb: { minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ },
    };
    room.objects.push(item);
    io.to(roomName).emit('placed', { item, tempId });       // to everyone, including the sender (confirms its tempId)
    saveSoon();
  });

  socket.on('remove', (d = {}) => {
    if (!room || typeof d.id !== 'string') return;
    const i = room.objects.findIndex(o => o.id === d.id);
    if (i < 0) return;
    const o = room.objects[i];
    if (o.lockedBy && o.lockedBy !== socket.id) return socket.emit('lockDenied', { id: o.id, name: o.lockName });
    room.objects.splice(i, 1);
    socket.to(roomName).emit('removed', { id: d.id });
    saveSoon();
  });

  socket.on('clear', () => {
    if (!room) return;
    room.objects = [];
    socket.to(roomName).emit('cleared');
    saveSoon();
  });

  // ---- Moving furniture: lock → drag (live preview) → objMove (final) or unlock (cancel)
  const findObj = (id) => (room && typeof id === 'string' ? room.objects.find(o => o.id === id) : null);

  socket.on('lock', (d = {}) => {
    const o = findObj(d.id);
    if (!o) return socket.emit('lockDenied', { id: d.id, name: null });
    if (o.lockedBy && o.lockedBy !== socket.id) return socket.emit('lockDenied', { id: o.id, name: o.lockName });
    o.lockedBy = socket.id; o.lockName = me.name;
    socket.to(roomName).emit('locked', { id: o.id, byId: socket.id, name: me.name });
  });

  socket.on('drag', (d = {}) => {
    const o = findObj(d.id);
    if (!o || o.lockedBy !== socket.id || !num(d.x, -20, 20) || !num(d.z, -20, 20) || !num(d.rot, -1000, 1000)) return;
    socket.to(roomName).volatile.emit('dragged', { id: o.id, x: d.x, z: d.z, rot: d.rot });
  });

  socket.on('objMove', (d = {}) => {
    const o = findObj(d.id);
    if (!o) return;
    if (o.lockedBy && o.lockedBy !== socket.id) return socket.emit('lockDenied', { id: o.id, name: o.lockName });
    const reason = validatePlacement(room, { ...d, type: o.type, walkable: o.walkable }, o.id);
    if (reason) {
      delete o.lockedBy; delete o.lockName;
      socket.emit('objMoveRejected', { id: o.id, x: o.x, z: o.z, rot: o.rot, reason });
      socket.to(roomName).emit('unlocked', { id: o.id, x: o.x, z: o.z, rot: o.rot });
      return;
    }
    const a = d.aabb;
    Object.assign(o, { x: d.x, z: d.z, rot: d.rot, aabb: { minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ } });
    delete o.lockedBy; delete o.lockName;
    socket.to(roomName).emit('objMoved', { id: o.id, x: o.x, z: o.z, rot: o.rot, aabb: o.aabb });
    saveSoon();
  });

  socket.on('unlock', (d = {}) => {
    const o = findObj(d.id);
    if (!o || o.lockedBy !== socket.id) return;
    delete o.lockedBy; delete o.lockName;
    socket.to(roomName).emit('unlocked', { id: o.id, x: o.x, z: o.z, rot: o.rot });
  });

  socket.on('env', (d = {}) => {
    if (!room) return;
    room.env = { night: d.night ? 1 : 0, rain: d.rain ? 1 : 0 };
    socket.to(roomName).emit('env', room.env);
    saveSoon();
  });

  socket.on('move', (d = {}) => {
    if (!room || !num(d.x, -50, 50) || !num(d.z, -50, 50) || !num(d.yaw, -1e6, 1e6) || !num(d.pitch, -2, 2)) return;
    Object.assign(me, { x: d.x, z: d.z, yaw: d.yaw, pitch: d.pitch });
    // volatile = OK to drop if the network is busy; a newer position is coming anyway
    socket.to(roomName).volatile.emit('playerMoved', { id: socket.id, x: d.x, z: d.z, yaw: d.yaw, pitch: d.pitch });
  });

  socket.on('disconnect', () => {
    if (me) console.log(`${me.name} left "${roomName}"`);
    leave();
  });
});

loadRooms();
server.listen(PORT, () => {
  console.log(`\n  ArchViz Studio running → http://localhost:${PORT}  (open this on the laptop)`);
  const urls = lanUrls();
  if (!urls.length) { console.log('  No Wi-Fi network found: connect to Wi-Fi to let phones join.\n'); return; }
  const phoneUrl = `${urls[0]}/?room=house`;
  console.log(`  On your phone (same Wi-Fi) open → ${phoneUrl}`);
  urls.slice(1).forEach(u => console.log(`                         or → ${u}/?room=house`));
  try {
    console.log('\n  …or scan this with your phone camera:\n');
    require('qrcode-terminal').generate(phoneUrl, { small: true });
  } catch { console.log('  (run `npm install` again to get a scannable QR code here)'); }
  console.log('');
});
