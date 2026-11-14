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
const ROOM_W = 44, ROOM_D = 44;          // the whole fenced plot (house + garden): must match GW / GD in public/index.html
const MAX_OBJECTS = 300;                  // per room
const MAX_PLACES_PER_SEC = 8;             // simple anti-spam
const TYPES = new Set(['sofa', 'bed', 'table', 'chair', 'rug', 'bookshelf', 'tv', 'wall', 'door', 'lamp', 'fireplace', 'armchair', 'coffee', 'plant',
  'kitchen', 'fridge', 'island', 'desk', 'bathtub', 'toilet', 'vanity',
  'tree', 'bush', 'flowers', 'bench', 'lounger', 'parasol', 'gardenlamp']);
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
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, storage: mongoRooms ? 'mongodb' : 'file' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ------------------------------------------------------------------ room state + persistence
/** rooms: name → { objects: [{id,type,x,z,rot,aabb,walkable,by}], env: {night,rain}, players: Map<socketId, player> } */
const rooms = new Map();

// Storage: MongoDB when MONGODB_URI is set (online on Render), otherwise data/rooms.json (on your laptop).
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoRooms = null;                     // the MongoDB "rooms" collection, once connected
const cleanForSave = (r) => ({ objects: r.objects.map(({ lockedBy, lockName, ...o }) => o), env: r.env });

async function loadRooms() {
  if (MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      mongoRooms = client.db(process.env.MONGODB_DB || 'archviz').collection('rooms');
      for (const doc of await mongoRooms.find({}).toArray()) {
        rooms.set(doc._id, { objects: doc.objects || [], env: doc.env || { night: 0, rain: 0 }, players: new Map() });
      }
      console.log(`MongoDB connected: loaded ${rooms.size} saved room(s)`);
      return;
    } catch (err) {
      console.error('⚠️  MongoDB connection failed, falling back to data/rooms.json:', err.message);
      mongoRooms = null;
    }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [name, r] of Object.entries(saved)) rooms.set(name, { objects: r.objects || [], env: r.env || { night: 0, rain: 0 }, players: new Map() });
    console.log(`Loaded ${rooms.size} saved room(s) from data/rooms.json`);
  } catch { /* first run: no file yet */ }
}

// Debounced saving: changes within 1 s are batched into one write. Only changed rooms are written to MongoDB.
const dirtyRooms = new Set();
let saveTimer = null;
function saveSoon(room) {
  for (const [name, r] of rooms) if (r === room) dirtyRooms.add(name);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 1000);
}
async function flushSaves() {
  clearTimeout(saveTimer); saveTimer = null;
  const names = [...dirtyRooms]; dirtyRooms.clear();
  if (mongoRooms) {
    await Promise.all(names.map(name => {
      const r = rooms.get(name); if (!r) return null;
      return mongoRooms.updateOne({ _id: name }, { $set: { ...cleanForSave(r), updatedAt: new Date() } }, { upsert: true })
        .catch(err => { console.error(`Save of room "${name}" failed:`, err.message); dirtyRooms.add(name); });
    }));
    return;
  }
  const out = {};
  for (const [name, r] of rooms) out[name] = cleanForSave(r);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(out));
}
// Render stops the old server when it deploys an update: save everything first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    for (const name of rooms.keys()) dirtyRooms.add(name);
    try { await flushSaves(); } catch (e) { console.error('Final save failed:', e.message); }
    process.exit(0);
  });
}
function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { objects: [], env: { night: 0, rain: 0, party: 0 }, players: new Map() });
  const r = rooms.get(name);
  if (!r.pet) r.pet = { targetId: null, name: '' };
  if (!r.hs) r.hs = { phase: 'idle', seekerId: null, seekerName: '', found: [], endsAt: 0, timer: null };
  return r;
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
    if (room.pet.targetId === socket.id) { room.pet = { targetId: null, name: '' }; socket.to(roomName).emit('pet', room.pet); }
    if (room.hs.phase !== 'idle') {
      if (room.hs.seekerId === socket.id) { room.players.delete(socket.id); hsEnd(room, roomName, 'the seeker left'); }
      else { room.hs.found = room.hs.found.filter(id => id !== socket.id); room.players.delete(socket.id);
        if (room.players.size < 2) hsEnd(room, roomName, 'not enough players');
        else if (room.hs.phase === 'seeking' && room.hs.found.length >= room.players.size - 1) hsEnd(room, roomName, 'everyone was found, the seeker wins'); }
    }
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
    socket.emit('init', { you: socket.id, objects: room.objects.map(({ lockedBy, ...o }) => o), players: [...room.players.values()], env: room.env, pet: room.pet,
      hs: { phase: room.hs.phase, seekerId: room.hs.seekerId, seekerName: room.hs.seekerName, found: room.hs.found, endsAt: room.hs.endsAt, now: Date.now() } });
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
    saveSoon(room);
  });

  socket.on('remove', (d = {}) => {
    if (!room || typeof d.id !== 'string') return;
    const i = room.objects.findIndex(o => o.id === d.id);
    if (i < 0) return;
    const o = room.objects[i];
    if (o.lockedBy && o.lockedBy !== socket.id) return socket.emit('lockDenied', { id: o.id, name: o.lockName });
    room.objects.splice(i, 1);
    socket.to(roomName).emit('removed', { id: d.id });
    saveSoon(room);
  });

  socket.on('clear', () => {
    if (!room) return;
    room.objects = [];
    socket.to(roomName).emit('cleared');
    saveSoon(room);
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
    saveSoon(room);
  });

  socket.on('unlock', (d = {}) => {
    const o = findObj(d.id);
    if (!o || o.lockedBy !== socket.id) return;
    delete o.lockedBy; delete o.lockName;
    socket.to(roomName).emit('unlocked', { id: o.id, x: o.x, z: o.z, rot: o.rot });
  });

  socket.on('env', (d = {}) => {
    if (!room) return;
    room.env = { night: d.night ? 1 : 0, rain: d.rain ? 1 : 0, party: d.party ? 1 : 0 };
    socket.to(roomName).emit('env', room.env);
    saveSoon(room);
  });

  const POSES = new Set(['stand', 'sit', 'lie', 'floor']);
  socket.on('move', (d = {}) => {
    if (!room || !num(d.x, -50, 50) || !num(d.z, -50, 50) || !num(d.yaw, -1e6, 1e6) || !num(d.pitch, -2, 2)) return;
    const y = num(d.y, 0, 3) ? d.y : 0, pose = POSES.has(d.pose) ? d.pose : 'stand', sy = num(d.sy, 0, 2) ? d.sy : 0;
    Object.assign(me, { x: d.x, z: d.z, yaw: d.yaw, pitch: d.pitch, y, pose, sy });
    // volatile = OK to drop if the network is busy; a newer position is coming anyway
    socket.to(roomName).volatile.emit('playerMoved', { id: socket.id, x: d.x, z: d.z, yaw: d.yaw, pitch: d.pitch, y, pose, sy });
  });

  // ---- emotes: just relayed to everyone else
  const EMOTES = new Set(['wave', 'dance', 'jump', 'sit', 'clap']);
  let lastEmote = 0;
  socket.on('emote', (d = {}) => {
    if (!room || !EMOTES.has(d.type) || Date.now() - lastEmote < 300) return;
    lastEmote = Date.now();
    socket.to(roomName).emit('emoted', { id: socket.id, type: d.type });
  });

  // ---- Bruno the dog: whoever calls him becomes his owner; calling again sends him to nap
  socket.on('pet:call', () => {
    if (!room) return;
    room.pet = room.pet.targetId === socket.id ? { targetId: null, name: '' } : { targetId: socket.id, name: me.name };
    io.to(roomName).emit('pet', room.pet);
  });

  // ---- hide & seek: the server picks the seeker, runs the timers and validates tags
  const HIDE_MS = 20000, SEEK_MS = 150000;
  const hsPublic = (r) => ({ phase: r.hs.phase, seekerId: r.hs.seekerId, seekerName: r.hs.seekerName, found: r.hs.found, endsAt: r.hs.endsAt, now: Date.now() });
  function hsEnd(r, rn, reason) {
    clearTimeout(r.hs.timer);
    const total = Math.max(0, r.players.size - 1), found = r.hs.found.length, seekerName = r.hs.seekerName;
    r.hs = { phase: 'idle', seekerId: null, seekerName: '', found: [], endsAt: 0, timer: null };
    io.to(rn).emit('hs', hsPublic(r));
    io.to(rn).emit('hs:end', { reason, found, total, seekerName });
  }
  socket.on('hs:start', () => {
    if (!room || room.hs.phase !== 'idle') return;
    if (room.players.size < 2) return socket.emit('hs:error', '🙈 Hide & seek needs at least 2 players: invite a friend!');
    const ids = [...room.players.keys()], seekerId = ids[Math.floor(Math.random() * ids.length)];
    const r = room, rn = roomName;
    r.hs = { phase: 'hiding', seekerId, seekerName: r.players.get(seekerId).name, found: [], endsAt: Date.now() + HIDE_MS, timer: null };
    io.to(rn).emit('hs', hsPublic(r));
    r.hs.timer = setTimeout(() => {
      if (r.hs.phase !== 'hiding') return;
      r.hs.phase = 'seeking'; r.hs.endsAt = Date.now() + SEEK_MS;
      io.to(rn).emit('hs', hsPublic(r));
      r.hs.timer = setTimeout(() => { if (r.hs.phase === 'seeking') hsEnd(r, rn, "time's up, the hiders win"); }, SEEK_MS);
    }, HIDE_MS);
  });
  socket.on('hs:tag', (d = {}) => {
    if (!room || room.hs.phase !== 'seeking' || room.hs.seekerId !== socket.id) return;
    const target = room.players.get(d.id);
    if (!target || d.id === socket.id || room.hs.found.includes(d.id)) return;
    if (Math.hypot(target.x - me.x, target.z - me.z) > 4) return;          // must actually be close
    room.hs.found.push(d.id);
    io.to(roomName).emit('hs', hsPublic(room));
    io.to(roomName).emit('hs:found', { id: d.id, name: target.name });
    if (room.hs.found.length >= room.players.size - 1) hsEnd(room, roomName, 'everyone was found, the seeker wins');
  });
  socket.on('hs:stop', () => { if (room && room.hs.phase !== 'idle') hsEnd(room, roomName, `stopped by ${me.name}`); });

  socket.on('disconnect', () => {
    if (me) console.log(`${me.name} left "${roomName}"`);
    leave();
  });
});

loadRooms().then(() => server.listen(PORT, () => {
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
}));
