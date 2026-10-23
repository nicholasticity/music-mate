const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 30 * 60 * 1000; // keep empty rooms around for 30 min
// Keep in sync with the buttons in index.html.
const REACTIONS = ['🥰', '😍', '😘', '💕', '💖'];
const REACTION_RATE = 10;  // reactions per second each person can sustain
const REACTION_BURST = 20; // short bursts allowed above the rate
const MESSAGE_MAX_LENGTH = 80;
const MESSAGE_RATE = 0.5;  // one message every 2 s sustained...
const MESSAGE_BURST = 3;   // ...after a few in quick succession
const VOICE_MAX_SECONDS = 30;
const VOICE_MAX_BYTES = 1024 * 1024;
const VOICE_TYPE = /^audio\/(mp4|webm|ogg)(;[\w.=, -]*)?$/;
const VOICE_RATE = 0.2;    // one voice message every 5 s sustained...
const VOICE_BURST = 2;     // ...after a couple in a row

const app = express();
const server = http.createServer(app);
// Room for a 30 s voice message (VOICE_MAX_BYTES) plus framing.
const io = new Server(server, { maxHttpBufferSize: VOICE_MAX_BYTES + 64 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
// Every room URL serves the same single-page app.
app.get('/r/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/** roomId -> room state */
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      queue: [],          // upcoming items
      current: null,      // item currently loaded
      playing: false,
      position: 0,        // seconds into `current` as of `updatedAt`
      updatedAt: Date.now(),
      members: new Map(), // socketId -> name
      emptySince: null,
      errorReports: new Set(), // socketIds whose player failed on `current`
    };
    rooms.set(roomId, room);
  }
  return room;
}

function currentPosition(room) {
  if (!room.playing) return room.position;
  return room.position + (Date.now() - room.updatedAt) / 1000;
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function setPlayback(room, { playing = room.playing, position = currentPosition(room) }) {
  room.playing = playing;
  room.position = Math.max(0, position);
  room.updatedAt = Date.now();
}

function publicState(room) {
  return {
    queue: room.queue,
    current: room.current,
    playing: room.playing,
    position: room.position,
    updatedAt: room.updatedAt,
    members: [...room.members.values()],
  };
}

function broadcast(room) {
  io.to(room.id).emit('state', publicState(room));
}

/** Token bucket: returns a function that says whether one more event is allowed. */
function createRateLimiter(ratePerSecond, burst) {
  let tokens = burst;
  let refilledAt = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - refilledAt) / 1000) * ratePerSecond);
    refilledAt = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function cleanMessage(text) {
  if (typeof text !== 'string') return '';
  const singleLine = text.replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();
  // Slice by code points so emoji aren't cut in half.
  return Array.from(singleLine).slice(0, MESSAGE_MAX_LENGTH).join('');
}

function setCurrent(room, item) {
  room.current = item;
  room.errorReports.clear();
  setPlayback(room, { playing: !!item, position: 0 });
}

function playNext(room) {
  setCurrent(room, room.queue.shift() || null);
}

function parseVideoId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    if (!id) {
      const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (match) id = match[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function fetchTitle(videoId) {
  try {
    const target = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title, author: data.author_name };
  } catch {
    return null;
  }
}

io.on('connection', (socket) => {
  let room = null;
  const allowReaction = createRateLimiter(REACTION_RATE, REACTION_BURST);
  const allowMessage = createRateLimiter(MESSAGE_RATE, MESSAGE_BURST);
  const allowVoice = createRateLimiter(VOICE_RATE, VOICE_BURST);

  socket.on('time', (clientTime, ack) => {
    if (typeof ack === 'function') ack({ clientTime, serverTime: Date.now() });
  });

  // The room comes with the connection itself, so a socket is in its room
  // before any event it sent (even ones buffered while connecting) is handled.
  const { roomId, name } = socket.handshake.auth || {};
  if (typeof roomId !== 'string' || !/^[\w-]{3,40}$/.test(roomId)) {
    socket.disconnect(true);
    return;
  }
  room = getRoom(roomId);
  room.emptySince = null;
  room.members.set(socket.id, String(name || 'Guest').slice(0, 30));
  socket.join(room.id);
  broadcast(room);

  socket.on('add', async (body, ack) => {
    if (!room || !asObject(body) || typeof body.url !== 'string') {
      if (typeof ack === 'function') ack({ error: 'That does not look like a YouTube link.' });
      return;
    }
    const videoId = parseVideoId(body.url);
    if (!videoId) {
      if (typeof ack === 'function') ack({ error: 'That does not look like a YouTube link.' });
      return;
    }
    // Queue immediately so songs keep the order they were added in, then fill
    // in the title once YouTube answers.
    const item = {
      id: crypto.randomUUID(),
      videoId,
      title: 'Loading title…',
      author: '',
      addedBy: room.members.get(socket.id) || 'Guest',
    };
    if (!room.current) {
      setCurrent(room, item);
    } else {
      room.queue.push(item);
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);

    const meta = await fetchTitle(videoId);
    item.title = meta?.title || `YouTube video ${videoId}`;
    item.author = meta?.author || '';
    broadcast(room);
  });

  socket.on('play', () => {
    if (!room?.current) return;
    setPlayback(room, { playing: true });
    broadcast(room);
  });

  socket.on('pause', () => {
    if (!room?.current) return;
    setPlayback(room, { playing: false });
    broadcast(room);
  });

  socket.on('seek', (body) => {
    if (!room?.current || !asObject(body) || !Number.isFinite(body.position)) return;
    setPlayback(room, { position: body.position });
    broadcast(room);
  });

  socket.on('skip', () => {
    if (!room) return;
    playNext(room);
    broadcast(room);
  });

  // Every client reports "ended"; only the first report for the current item advances.
  socket.on('ended', (body) => {
    if (!room?.current || !asObject(body) || body.itemId !== room.current.id) return;
    playNext(room);
    broadcast(room);
  });

  // A player error may be local (network, browser quirk), so only skip once
  // every listener's player has failed on this item.
  socket.on('videoError', (body) => {
    if (!room?.current || !asObject(body) || body.itemId !== room.current.id) return;
    room.errorReports.add(socket.id);
    if (room.errorReports.size >= room.members.size) {
      playNext(room);
      broadcast(room);
    }
  });

  socket.on('playNow', (body) => {
    if (!room || !asObject(body) || typeof body.itemId !== 'string') return;
    const index = room.queue.findIndex((item) => item.id === body.itemId);
    if (index === -1) return;
    const [item] = room.queue.splice(index, 1);
    setCurrent(room, item);
    broadcast(room);
  });

  socket.on('remove', (body) => {
    if (!room || !asObject(body) || typeof body.itemId !== 'string') return;
    room.queue = room.queue.filter((item) => item.id !== body.itemId);
    broadcast(room);
  });

  // Reactions are fire-and-forget: relayed to everyone else, never stored.
  // The sender already shows its own reaction locally.
  socket.on('react', (body) => {
    if (!room || !asObject(body) || !REACTIONS.includes(body.emoji) || !allowReaction()) return;
    socket.to(room.id).emit('react', { emoji: body.emoji });
  });

  // Messages float up once on everyone's screen; like reactions, never stored.
  // The sender shows its own copy after the ack, using the cleaned text.
  socket.on('message', (body, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!room || !asObject(body)) return reply({ error: 'Type something first.' });
    const clean = cleanMessage(body.text);
    if (!clean) return reply({ error: 'Type something first.' });
    if (!allowMessage()) return reply({ error: 'Slow down a little 💕' });
    socket.to(room.id).emit('message', { text: clean, from: room.members.get(socket.id) || 'Guest' });
    reply({ ok: true, text: clean });
  });

  // One-time voice messages: relayed to everyone else, never stored.
  socket.on('voice', (body, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!room || !asObject(body)) return reply({ error: 'That voice message is too big.' });
    const { audio, mimeType, duration } = body;
    if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length > VOICE_MAX_BYTES) {
      return reply({ error: 'That voice message is too big.' });
    }
    if (typeof mimeType !== 'string' || mimeType.length > 60 || !VOICE_TYPE.test(mimeType)) {
      return reply({ error: 'Unsupported audio format.' });
    }
    // Allow a little slack over the limit for timer jitter on the sender.
    if (!Number.isFinite(duration) || duration <= 0 || duration > VOICE_MAX_SECONDS + 1) {
      return reply({ error: `Voice messages can be up to ${VOICE_MAX_SECONDS} seconds.` });
    }
    if (!allowVoice()) return reply({ error: 'Slow down a little 💕' });
    socket.to(room.id).emit('voice', { audio, mimeType, duration, from: room.members.get(socket.id) || 'Guest' });
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.members.delete(socket.id);
    room.errorReports.delete(socket.id);
    if (room.members.size === 0) room.emptySince = Date.now();
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(id);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Music rooms running at http://localhost:${PORT}`);
});
