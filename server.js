const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 30 * 60 * 1000; // keep empty rooms around for 30 min
// Keep in sync with the buttons in index.html.
const REACTIONS = [
  '🔥', '❤️', '😂', '👏', '🎉', '😭', '💀', '🕺',
  '🥰', '😍', '😘', '💕', '💖', '🫶', '💋', '🌹',
];
const REACTION_RATE = 10;  // reactions per second each person can sustain
const REACTION_BURST = 20; // short bursts allowed above the rate

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
  let reactionTokens = REACTION_BURST;
  let tokensRefilledAt = Date.now();

  socket.on('time', (clientTime, ack) => {
    if (typeof ack === 'function') ack({ clientTime, serverTime: Date.now() });
  });

  socket.on('join', ({ roomId, name }) => {
    if (room || typeof roomId !== 'string' || !/^[\w-]{3,40}$/.test(roomId)) return;
    room = getRoom(roomId);
    room.emptySince = null;
    room.members.set(socket.id, String(name || 'Guest').slice(0, 30));
    socket.join(room.id);
    broadcast(room);
  });

  socket.on('add', async ({ url }, ack) => {
    if (!room) return;
    const videoId = parseVideoId(url);
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

  socket.on('seek', ({ position }) => {
    if (!room?.current || !Number.isFinite(position)) return;
    setPlayback(room, { position });
    broadcast(room);
  });

  socket.on('skip', () => {
    if (!room) return;
    playNext(room);
    broadcast(room);
  });

  // Every client reports "ended"; only the first report for the current item advances.
  socket.on('ended', ({ itemId }) => {
    if (!room?.current || room.current.id !== itemId) return;
    playNext(room);
    broadcast(room);
  });

  // A player error may be local (network, browser quirk), so only skip once
  // every listener's player has failed on this item.
  socket.on('videoError', ({ itemId }) => {
    if (!room?.current || room.current.id !== itemId) return;
    room.errorReports.add(socket.id);
    if (room.errorReports.size >= room.members.size) {
      playNext(room);
      broadcast(room);
    }
  });

  socket.on('playNow', ({ itemId }) => {
    if (!room) return;
    const index = room.queue.findIndex((item) => item.id === itemId);
    if (index === -1) return;
    const [item] = room.queue.splice(index, 1);
    setCurrent(room, item);
    broadcast(room);
  });

  socket.on('remove', ({ itemId }) => {
    if (!room) return;
    room.queue = room.queue.filter((item) => item.id !== itemId);
    broadcast(room);
  });

  // Reactions are fire-and-forget: relayed to everyone else, never stored.
  // The sender already shows its own reaction locally.
  socket.on('react', ({ emoji } = {}) => {
    if (!room || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    reactionTokens = Math.min(REACTION_BURST, reactionTokens + ((now - tokensRefilledAt) / 1000) * REACTION_RATE);
    tokensRefilledAt = now;
    if (reactionTokens < 1) return;
    reactionTokens -= 1;
    socket.to(room.id).emit('react', { emoji });
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
