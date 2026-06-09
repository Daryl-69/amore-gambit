'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

/* ── Data persistence ── */
const DATA_DIR  = path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'db.json');
let db = { history: [], users: {} };

function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { db = { history: [], users: {} }; }
}
function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
loadDb();

/* ── Static files ── */
app.use(express.json());
app.use(express.static(__dirname));

/* ══════════════════════════════════════════
   REST API
══════════════════════════════════════════ */

/* ── Keep-alive ping — prevents Render free tier from spinning down ── */
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* -- Game History -- */
app.get('/api/history', (req, res) => res.json(db.history));

app.post('/api/history', (req, res) => {
  const entry = {
    ...req.body,
    id:        Date.now(),
    timestamp: new Date().toISOString(),
  };
  db.history.unshift(entry);
  if (db.history.length > 500) db.history.length = 500;
  saveDb();
  res.json(entry);
});

app.delete('/api/history/:id', (req, res) => {
  db.history = db.history.filter(h => String(h.id) !== req.params.id);
  saveDb();
  res.json({ ok: true });
});

/* -- User profile -- */
app.get('/api/user/:id', (req, res) => {
  res.json(db.users[req.params.id] || null);
});

app.post('/api/user', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  db.users[id] = { id, name, updatedAt: new Date().toISOString() };
  saveDb();
  res.json(db.users[id]);
});

/* -- Room info (for late joiners) -- */
app.get('/api/room/:code', (req, res) => {
  const r = rooms[req.params.code];
  res.json(r ? { users: r.users, musicState: r.musicState } : null);
});

/* ══════════════════════════════════════════
   Socket.IO  –  Real-time room management
══════════════════════════════════════════ */
const rooms = {};  // roomCode → { users:[{socketId,userId,name}], musicState, queue }

io.on('connection', socket => {
  let myRoom = null;
  let myName = 'Guest';
  let myUserId = null;

  /* ── Join / create room ── */
  socket.on('join-room', ({ roomCode, userId, userName }) => {
    if (myRoom) {
      leaveCurrentRoom();
    }
    myRoom   = roomCode;
    myName   = userName || 'Guest';
    myUserId = userId;

    socket.join(roomCode);

    if (!rooms[roomCode]) {
      rooms[roomCode] = { users: [], musicState: null, queue: [] };
    }

    // Replace stale entry for same user
    rooms[roomCode].users = rooms[roomCode].users.filter(u => u.userId !== userId);
    rooms[roomCode].users.push({ socketId: socket.id, userId, name: myName });

    // Send current room state to the joiner
    socket.emit('room-joined', {
      users:      rooms[roomCode].users,
      musicState: rooms[roomCode].musicState,
      queue:      rooms[roomCode].queue,
    });

    // Tell everyone else someone joined
    socket.to(roomCode).emit('peer-joined', { name: myName, userId });
    io.to(roomCode).emit('room-users', rooms[roomCode].users);
  });

  /* ── Music sync ── */
  socket.on('music-action', payload => {
    if (!myRoom || !rooms[myRoom]) return;
    payload.serverTime = Date.now();
    payload.fromUser   = myName;

    // Persist queue + state
    if (payload.queue !== undefined) rooms[myRoom].queue = payload.queue;
    rooms[myRoom].musicState = {
      type:        payload.type,
      videoId:     payload.videoId,
      currentTime: payload.currentTime,
      serverTime:  payload.serverTime,
      isPlaying:   payload.isPlaying,
    };

    // Broadcast to everyone ELSE in the room
    socket.to(myRoom).emit('music-action', payload);
  });

  /* ── Chess move sync ── */
  socket.on('chess-move', payload => {
    if (!myRoom) return;
    socket.to(myRoom).emit('chess-move', payload);
  });

  /* ── Resign ── */
  socket.on('player-resigned', payload => {
    if (!myRoom) return;
    socket.to(myRoom).emit('player-resigned', payload);
  });

  /* ── Draw offer/response ── */
  socket.on('draw-offered', payload => {
    if (!myRoom) return;
    socket.to(myRoom).emit('draw-offered', payload);
  });
  socket.on('draw-accepted', payload => {
    if (!myRoom) return;
    socket.to(myRoom).emit('draw-accepted', payload);
  });
  socket.on('draw-declined', payload => {
    if (!myRoom) return;
    socket.to(myRoom).emit('draw-declined', payload);
  });

  /* ── Chat messages ── */
  socket.on('chat-msg', payload => {
    if (!myRoom) return;
    io.to(myRoom).emit('chat-msg', { ...payload, from: myName, time: Date.now() });
  });

  /* ── Disconnect ── */
  socket.on('disconnect', () => leaveCurrentRoom());

  function leaveCurrentRoom() {
    if (!myRoom || !rooms[myRoom]) return;
    rooms[myRoom].users = rooms[myRoom].users.filter(u => u.socketId !== socket.id);
    io.to(myRoom).emit('room-users', rooms[myRoom].users);
    socket.to(myRoom).emit('peer-left', { name: myName });
    if (rooms[myRoom].users.length === 0) {
      delete rooms[myRoom];
    }
    socket.leave(myRoom);
    myRoom = null;
  }
});

/* ── Start ── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n♥  Amore & Gambit server running!`);
  console.log(`→  http://localhost:${PORT}`);
  console.log(`→  Share this address with your partner on the same network.\n`);
});
