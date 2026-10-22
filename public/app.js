(() => {
  const DRIFT_TOLERANCE = 1.5; // seconds of drift before we re-seek
  const TICK_MS = 500;
  const LOAD_GRACE_MS = 6000; // time a fresh player gets before we suspect blocked autoplay
  const SPAM_INTERVAL_MS = 110; // repeat rate while a reaction is held (server allows ~10/s)
  const MAX_FLOATERS = 60;      // cap on reactions animating at once
  const MESSAGE_GAP_MS = 900;   // stagger messages so they don't stack on each other

  const $ = (id) => document.getElementById(id);
  const els = {
    landing: $('landing'), join: $('join'), room: $('room'), app: $('app'),
    createRoom: $('create-room'), joinCodeForm: $('join-code-form'), joinCode: $('join-code'),
    joinForm: $('join-form'), joinName: $('join-name'), joinRoomId: $('join-room-id'),
    roomId: $('room-id'), copyLink: $('copy-link'), popOut: $('pop-out'),
    pipPlaceholder: $('pip-placeholder'), pipReturn: $('pip-return'),
    playerContainer: $('player'), art: $('art'), artEmpty: $('art-empty'), syncBtn: $('sync-btn'),
    nowTitle: $('now-title'), nowMeta: $('now-meta'),
    toggle: $('toggle'), skip: $('skip'), seek: $('seek'), timeCur: $('time-cur'), timeDur: $('time-dur'),
    addForm: $('add-form'), addUrl: $('add-url'), addError: $('add-error'),
    queue: $('queue'), queueEmpty: $('queue-empty'), members: $('members'), toast: $('toast'),
    reactions: $('reactions'), reactionLayer: $('reaction-layer'),
    messageForm: $('message-form'), messageInput: $('message-input'),
  };

  const roomMatch = location.pathname.match(/^\/r\/([\w-]{3,40})\/?$/);
  const roomId = roomMatch && roomMatch[1];

  // ---------- Landing ----------
  if (!roomId) {
    els.landing.hidden = false;
    els.createRoom.addEventListener('click', () => {
      location.href = `/r/${randomRoomId()}`;
    });
    els.joinCodeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = els.joinCode.value.trim().replace(/^.*\/r\//, '');
      if (/^[\w-]{3,40}$/.test(code)) location.href = `/r/${code}`;
    });
    return;
  }

  // ---------- Join prompt ----------
  els.joinRoomId.textContent = roomId;
  els.joinName.value = localStorage.getItem('name') || '';
  els.join.hidden = false;
  els.joinName.focus();
  els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.joinName.value.trim() || 'Guest';
    localStorage.setItem('name', name);
    els.join.hidden = true;
    els.room.hidden = false;
    enterRoom(name);
  });

  // ---------- Room ----------
  let socket;
  let state = null;
  let clockOffset = 0; // serverTime - localTime

  let player = null;
  let playerReady = false;
  let loadedItemId = null;
  let stuckTicks = 0;
  let loadGraceUntil = 0;
  let seeking = false;
  let pipWindow = null;
  let mountGeneration = 0;
  let spamTimer = null;
  let spamButton = null;
  let nextMessageAt = 0;

  function enterRoom(name) {
    els.roomId.textContent = roomId;
    // The floating window only exists on desktop Chrome/Edge; hide it elsewhere
    // (a disabled button's tooltip never shows on touch screens).
    els.popOut.hidden = !('documentPictureInPicture' in window);

    // Room and name travel with the connection, so the server has us in the
    // room before handling anything we send. The playback tick corrects any
    // drift once the clock offset is known.
    socket = io({ auth: { roomId, name } });
    socket.on('connect', syncClock);
    socket.on('state', (next) => {
      state = next;
      render();
      applyState();
    });
    socket.on('react', ({ emoji }) => spawnReaction(emoji));
    socket.on('message', ({ text, from }) => spawnMessage(text, from));

    mountPlayer(window, els.playerContainer);
    setInterval(tick, TICK_MS);
    bindControls();
  }

  // Estimate the server clock offset from a few round trips, keeping the fastest.
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const sample = await new Promise((resolve) => {
        const sent = Date.now();
        socket.emit('time', sent, ({ serverTime }) => {
          const rtt = Date.now() - sent;
          resolve({ rtt, offset: serverTime - (sent + rtt / 2) });
        });
      });
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    clockOffset = best.offset;
  }

  function expectedPosition() {
    if (!state || !state.current) return 0;
    if (!state.playing) return state.position;
    return state.position + (Date.now() + clockOffset - state.updatedAt) / 1000;
  }

  // ---------- YouTube player ----------
  // The IFrame API is loaded into whichever window hosts the player, so the
  // same code works for the main page and the Picture-in-Picture window.
  function loadYouTubeApi(win) {
    return new Promise((resolve) => {
      if (win.YT && win.YT.Player) return resolve(win.YT);
      win.onYouTubeIframeAPIReady = () => resolve(win.YT);
      const script = win.document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      win.document.head.appendChild(script);
    });
  }

  function destroyPlayer() {
    if (player) {
      try { player.destroy(); } catch { /* window may already be gone */ }
    }
    player = null;
    playerReady = false;
    loadedItemId = null;
  }

  async function mountPlayer(win, container) {
    destroyPlayer();
    const generation = ++mountGeneration;
    const YT = await loadYouTubeApi(win);
    if (generation !== mountGeneration || win.closed) return; // superseded
    const target = win.document.createElement('div');
    container.replaceChildren(target);
    player = new YT.Player(target, {
      width: '100%',
      height: '100%',
      playerVars: {
        controls: 0,
        disablekb: 1,
        playsinline: 1,
        rel: 0,
        origin: location.origin,
      },
      events: {
        onReady: () => {
          playerReady = true;
          applyState();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && loadedItemId) {
            socket.emit('ended', { itemId: loadedItemId });
          }
          if (e.data === YT.PlayerState.PLAYING) {
            stuckTicks = 0;
            els.syncBtn.hidden = true;
          }
        },
        onError: (e) => {
          console.warn('YouTube player error', e.data);
          toast('This video can’t play here.');
          if (loadedItemId) socket.emit('videoError', { itemId: loadedItemId });
        },
      },
    });
  }

  // Make the local player match the shared room state.
  function applyState() {
    if (!playerReady || !state) return;
    const { current, playing } = state;

    if (!current) {
      if (loadedItemId) player.stopVideo();
      loadedItemId = null;
      return;
    }

    const expected = expectedPosition();
    if (loadedItemId !== current.id) {
      loadedItemId = current.id;
      loadGraceUntil = Date.now() + LOAD_GRACE_MS;
      const opts = { videoId: current.videoId, startSeconds: expected };
      if (playing) player.loadVideoById(opts);
      else player.cueVideoById(opts);
      return;
    }

    const playerState = player.getPlayerState();
    if (Math.abs(player.getCurrentTime() - expected) > DRIFT_TOLERANCE) {
      player.seekTo(expected, true);
    }
    if (playing && playerState !== 1 && playerState !== 3) player.playVideo();
    if (!playing && (playerState === 1 || playerState === 3)) player.pauseVideo();
  }

  function tick() {
    if (!state) return;
    applyState();
    updateProgress();

    // Browsers may block autoplay (e.g. after a reload). If we should be
    // playing but aren't, offer a button so the user can unlock audio.
    if (playerReady && state.current && state.playing && Date.now() > loadGraceUntil) {
      const s = player.getPlayerState();
      stuckTicks = (s === -1 || s === 2 || s === 5) ? stuckTicks + 1 : 0;
      if (stuckTicks > 4) els.syncBtn.hidden = false;
    } else {
      stuckTicks = 0;
      els.syncBtn.hidden = true;
    }
  }

  // ---------- Rendering ----------
  function render() {
    const { current, queue, members, playing } = state;

    if (current && els.art.getAttribute('src') !== thumbnailUrl(current.videoId)) {
      els.art.src = thumbnailUrl(current.videoId);
    }
    els.art.hidden = !current;
    els.artEmpty.hidden = !!current;
    els.nowTitle.textContent = current ? current.title : 'Nothing playing';
    els.nowMeta.textContent = current
      ? [current.author, `added by ${current.addedBy}`].filter(Boolean).join(' · ')
      : 'Paste a YouTube link below to start';
    els.toggle.textContent = playing ? '⏸' : '▶';
    els.toggle.disabled = !current;
    els.skip.disabled = !current;
    els.seek.disabled = !current;

    els.queue.replaceChildren(...queue.map(renderQueueItem));
    els.queueEmpty.hidden = queue.length > 0;

    els.members.replaceChildren(...members.map((name) => {
      const chip = document.createElement('span');
      chip.textContent = name;
      return chip;
    }));

    updateProgress();
  }

  function renderQueueItem(item) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = thumbnailUrl(item.videoId);
    img.alt = '';
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = `added by ${item.addedBy}`;
    info.append(title, meta);

    const playNow = document.createElement('button');
    playNow.textContent = 'Play';
    playNow.addEventListener('click', () => socket.emit('playNow', { itemId: item.id }));
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.addEventListener('click', () => socket.emit('remove', { itemId: item.id }));

    li.append(img, info, playNow, remove);
    return li;
  }

  function updateProgress() {
    const duration = playerReady && state && state.current ? player.getDuration() || 0 : 0;
    const position = Math.min(expectedPosition(), duration || Infinity);
    els.seek.max = Math.floor(duration);
    if (!seeking) els.seek.value = Math.floor(position);
    els.timeCur.textContent = formatTime(seeking ? Number(els.seek.value) : position);
    els.timeDur.textContent = formatTime(duration);
  }

  // ---------- Controls ----------
  function bindControls() {
    els.toggle.addEventListener('click', () => {
      socket.emit(state && state.playing ? 'pause' : 'play');
    });
    els.skip.addEventListener('click', () => socket.emit('skip'));

    els.seek.addEventListener('input', () => {
      seeking = true;
      els.timeCur.textContent = formatTime(Number(els.seek.value));
    });
    els.seek.addEventListener('change', () => {
      seeking = false;
      socket.emit('seek', { position: Number(els.seek.value) });
    });

    els.syncBtn.addEventListener('click', () => {
      els.syncBtn.hidden = true;
      stuckTicks = 0;
      if (playerReady) {
        player.unMute();
        player.seekTo(expectedPosition(), true);
        player.playVideo();
      }
    });

    els.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = els.addUrl.value.trim();
      if (!url) return;
      els.addError.hidden = true;
      socket.emit('add', { url }, (res) => {
        if (res && res.error) {
          els.addError.textContent = res.error;
          els.addError.hidden = false;
        } else {
          els.addUrl.value = '';
        }
      });
    });

    els.copyLink.addEventListener('click', async () => {
      const link = `${location.origin}/r/${roomId}`;
      const nav = els.app.ownerDocument.defaultView.navigator;
      try {
        if (nav.share && /Mobi|Android/i.test(nav.userAgent)) {
          await nav.share({ title: 'Listen with me', url: link });
        } else {
          await nav.clipboard.writeText(link);
          toast('Invite link copied!');
        }
      } catch {
        toast(link);
      }
    });

    bindReactions();

    els.messageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.messageInput.value.trim();
      if (!text) return;
      socket.emit('message', { text }, (res) => {
        if (res && res.error) {
          toast(res.error);
        } else {
          els.messageInput.value = '';
          spawnMessage(res.text, 'You');
        }
      });
    });

    els.popOut.addEventListener('click', togglePip);
    els.pipReturn.addEventListener('click', () => pipWindow && pipWindow.close());
  }

  // ---------- Reactions ----------
  function bindReactions() {
    for (const button of els.reactions.querySelectorAll('button')) {
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startSpam(button);
      });
      // Keyboard activation (Enter/Space) sends a single reaction.
      button.addEventListener('click', (e) => {
        if (e.detail === 0) sendReaction(button.dataset.emoji);
      });
      button.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      els.reactions.addEventListener(type, stopSpam);
    }
  }

  function startSpam(button) {
    stopSpam();
    spamButton = button;
    button.classList.add('pressed');
    sendReaction(button.dataset.emoji);
    spamTimer = setInterval(() => sendReaction(button.dataset.emoji), SPAM_INTERVAL_MS);
  }

  function stopSpam() {
    clearInterval(spamTimer);
    spamTimer = null;
    if (spamButton) spamButton.classList.remove('pressed');
    spamButton = null;
  }

  function sendReaction(emoji) {
    spawnReaction(emoji);
    socket.emit('react', { emoji });
  }

  // Float an emoji up from its button. Works in whichever document hosts the app.
  function spawnReaction(emoji) {
    const doc = els.app.ownerDocument;
    // Animations don't run in hidden tabs, so floaters would just pile up.
    if (doc.visibilityState === 'hidden') return;
    const button = [...els.reactions.children].find((b) => b.dataset.emoji === emoji);
    if (!button) return;
    const reactionFloaters = els.reactionLayer.querySelectorAll('.floater:not(.message-floater)');
    for (let i = 0; i <= reactionFloaters.length - MAX_FLOATERS; i++) reactionFloaters[i].remove();
    const rect = button.getBoundingClientRect();
    const floater = doc.createElement('span');
    floater.className = 'floater';
    floater.textContent = emoji;
    floater.style.left = `${rect.left + rect.width / 2 + (Math.random() - 0.5) * 30}px`;
    floater.style.top = `${rect.top}px`;
    floater.style.setProperty('--drift', `${(Math.random() - 0.5) * 140}px`);
    floater.style.setProperty('--rise', `${200 + Math.random() * 180}px`);
    floater.style.animationDuration = `${1.6 + Math.random() * 0.8}s`;
    floater.addEventListener('animationend', () => floater.remove());
    els.reactionLayer.append(floater);
  }

  // Float a message bubble up once from the message box. Messages that arrive
  // close together are spaced out so each one stays readable.
  function spawnMessage(text, from) {
    const now = Date.now();
    const delay = Math.max(0, nextMessageAt - now);
    nextMessageAt = now + delay + MESSAGE_GAP_MS;
    setTimeout(() => showMessage(text, from), delay);
  }

  function showMessage(text, from) {
    const doc = els.app.ownerDocument;
    if (doc.visibilityState === 'hidden') return;
    const bubble = doc.createElement('div');
    bubble.className = 'floater message-floater';
    const name = doc.createElement('span');
    name.className = 'from';
    name.textContent = from;
    const body = doc.createElement('span');
    body.textContent = text;
    bubble.append(name, body);

    const rect = els.messageInput.getBoundingClientRect();
    const drift = (Math.random() - 0.5) * 60;
    bubble.style.left = '0px';
    bubble.style.top = `${rect.top}px`;
    bubble.style.setProperty('--drift', `${drift}px`);
    bubble.style.setProperty('--rise', `${260 + Math.random() * 80}px`);
    bubble.addEventListener('animationend', () => bubble.remove());
    els.reactionLayer.append(bubble);

    // Pick a random spot across the width where the whole bubble stays on
    // screen from start to end of its drift (it is centred on `left`).
    const margin = bubble.offsetWidth / 2 + 12;
    const min = margin + Math.max(0, -drift);
    const max = doc.documentElement.clientWidth - margin - Math.max(0, drift);
    const left = max > min ? min + Math.random() * (max - min) : (min + max) / 2;
    bubble.style.left = `${left}px`;
  }

  // ---------- Floating window (Document Picture-in-Picture) ----------
  async function togglePip() {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: 360, height: 440 });
    } catch (err) {
      toast('Could not open floating window.');
      return;
    }
    pipWindow = pip;
    copyStyles(pip.document);
    pip.document.title = 'Listen Together';
    pip.document.body.classList.add('pip');

    // Iframes reload when moved between documents, so rebuild the player there,
    // inside a same-origin frame so YouTube gets a referrer (see player-frame.html).
    destroyPlayer();
    stopSpam();
    els.reactionLayer.replaceChildren();
    pip.document.body.append(els.app);
    els.pipPlaceholder.hidden = false;
    els.popOut.textContent = 'Dock';
    const frame = pip.document.createElement('iframe');
    frame.src = '/player-frame.html';
    frame.allow = 'autoplay; encrypted-media';
    frame.addEventListener('load', () => {
      mountPlayer(frame.contentWindow, frame.contentDocument.body);
    }, { once: true });
    els.playerContainer.replaceChildren(frame);

    pip.addEventListener('pagehide', () => {
      stopSpam();
      els.reactionLayer.replaceChildren();
      destroyPlayer();
      els.room.append(els.app);
      els.pipPlaceholder.hidden = true;
      els.popOut.textContent = 'Float';
      pipWindow = null;
      mountPlayer(window, els.playerContainer);
    });
  }

  function copyStyles(targetDoc) {
    for (const sheet of document.styleSheets) {
      try {
        const style = targetDoc.createElement('style');
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
        targetDoc.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = targetDoc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          targetDoc.head.appendChild(link);
        }
      }
    }
  }

  // ---------- Helpers ----------
  function thumbnailUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function randomRoomId() {
    const words = ['amber', 'blue', 'coral', 'dusk', 'echo', 'fern', 'gold', 'haze', 'indigo', 'jade', 'lunar', 'mint', 'neon', 'opal', 'plum', 'ruby', 'sage', 'tidal', 'velvet', 'wild'];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    return `${pick()}-${pick()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2500);
  }
})();
