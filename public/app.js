(() => {
  const DRIFT_TOLERANCE = 1.5; // seconds of drift before we re-seek
  const SEEK_JUMP = 0.75; // a user scrub moves faster than playback; drift does not
  const USER_GRACE_MS = 1200; // leave a native play, pause, or seek alone after it
  const SEEK_SETTLE_MS = 400; // wait until a drag stops, then broadcast once
  const TICK_MS = 500;
  const LOAD_GRACE_MS = 6000; // time a fresh player gets before we suspect blocked autoplay
  const SPAM_INTERVAL_MS = 110; // repeat rate while a reaction is held (server allows ~10/s)
  const MAX_FLOATERS = 60;      // cap on reactions animating at once
  const MESSAGE_GAP_MS = 900;   // stagger messages so they don't stack on each other
  const VOICE_MAX_MS = 30000;   // matches VOICE_MAX_SECONDS in server.js
  const VOICE_MIN_MS = 500;     // shorter presses are treated as accidental
  const VOICE_EXPIRE_MS = 60000; // untapped voice messages disappear after this
  const VOICE_TRAY_MAX = 5;
  const PIP_HEIGHT = 440;       // floating window height with video off...
  const PIP_VIDEO_EXTRA = 140;  // ...and how much taller it gets with video on
  const DUCK_LEVEL = 0.2;       // music volume while recording / playing a voice message
  // Prefer MP4/AAC: it plays everywhere, including iPhones.
  const VOICE_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

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
    voiceBtn: $('voice-btn'), voiceTray: $('voice-tray'), recordingStatus: $('recording-status'),
    videoToggle: $('video-toggle'), playerHost: $('player-host'), artBox: $('art-box'),
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
  let lastSample = null;          // { time, at } of the player clock, to spot user seeks
  let userGraceUntil = 0;         // no drift correction or transport forcing until this time
  let pauseConfirm = null;
  let seekSettle = null;          // debounce timer for a YouTube scrub
  let pendingSeekAt = null;
  let pendingPlay = false;        // local play already sent; wait for the echo
  let pendingPause = false;
  let deferredRemote = false;     // a room update arrived during a local grace
  let sawPlaying = false;         // ignore the pause YouTube fires before playback has started
  let commandedTime = null;       // where our own seekTo told the player to go
  let commandUntil = 0;
  let pipWindow = null;
  let mountGeneration = 0;
  let spamTimer = null;
  let spamButton = null;
  let nextMessageAt = 0;
  let recording = null;     // in-progress voice recording
  let voiceNotes = [];      // incoming voice messages in the tray
  let voicePlaying = null;
  let savedVolume = null;   // music volume before ducking
  let videoOn = localStorage.getItem('video') !== 'off';
  const voiceAudio = new Audio();

  function enterRoom(name) {
    els.roomId.textContent = roomId;
    // The floating window only exists on desktop Chrome/Edge; hide it elsewhere
    // (a disabled button's tooltip never shows on touch screens).
    els.popOut.hidden = !('documentPictureInPicture' in window);
    applyVideoMode();

    // Room and name travel with the connection, so the server has us in the
    // room before handling anything we send. The playback tick corrects any
    // drift once the clock offset is known.
    socket = io({ auth: { roomId, name } });
    socket.on('connect', syncClock);
    socket.on('state', (next) => {
      state = next;
      render();
      if (pendingPlay && next.playing) pendingPlay = false;
      if (pendingPause && !next.playing) pendingPause = false;
      applyState();
    });
    socket.on('react', ({ emoji }) => spawnReaction(emoji));
    socket.on('message', ({ text, from }) => spawnMessage(text, from));
    socket.on('voice', addVoiceNote);

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
    savedVolume = null; // the next player starts at full volume
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
        controls: 1,
        disablekb: 0,
        playsinline: 1,
        rel: 0,
        origin: location.origin,
      },
      events: {
        onReady: () => {
          playerReady = true;
          lastSample = null;
          applyState();
          updateDuck(); // re-apply if a voice message is playing during a remount
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && loadedItemId) {
            socket.emit('ended', { itemId: loadedItemId });
          }
          if (e.data === YT.PlayerState.PLAYING) {
            stuckTicks = 0;
            els.syncBtn.hidden = true;
          }
          reportTransport(e.data);
        },
        onError: (e) => {
          console.warn('YouTube player error', e.data);
          toast('This video can’t play here.');
          if (loadedItemId) socket.emit('videoError', { itemId: loadedItemId });
        },
      },
    });
  }

  // A native play, pause, or seek moves the player before the room hears it.
  // Until the grace passes, the sync loop must not play, pause, or seek it back.
  function extendGrace(ms = USER_GRACE_MS) {
    userGraceUntil = Math.max(userGraceUntil, Date.now() + ms);
  }

  function inGrace() {
    return Date.now() < userGraceUntil || seekSettle != null || pauseConfirm != null;
  }

  function readPlayerTime() {
    try { return player.getCurrentTime() || 0; } catch { return 0; }
  }

  function readPlayerState() {
    try { return player.getPlayerState(); } catch { return -1; }
  }

  // One seek for a whole drag. Each jump resets the timer and the grace.
  function queueSeek(position) {
    pendingSeekAt = position;
    extendGrace(SEEK_SETTLE_MS + USER_GRACE_MS);
    clearTimeout(seekSettle);
    seekSettle = setTimeout(() => {
      seekSettle = null;
      const at = pendingSeekAt;
      pendingSeekAt = null;
      if (!playerReady || !state || !state.current || !Number.isFinite(at)) return;
      extendGrace();
      socket.emit('seek', { position: at });
    }, SEEK_SETTLE_MS);
  }

  // Play/pause from YouTube's own controls. A seek often pauses for a moment,
  // so a pause is broadcast only if the player is still paused a beat later.
  // Play and pause each go out once, on the same events as the room's button.
  function reportTransport(code) {
    if (!playerReady || !state || !state.current) return;
    const YTPS = window.YT && window.YT.PlayerState;
    if (!YTPS) return;
    if (code === YTPS.PLAYING) {
      clearTimeout(pauseConfirm);
      pauseConfirm = null;
      sawPlaying = true;
      // pendingPause covers a pause we already sent whose echo has not
      // landed yet. A new play still has to be broadcast once.
      const roomPaused = !state.playing || pendingPause;
      if (roomPaused && !pendingPlay) {
        pendingPause = false;
        pendingPlay = true;
        extendGrace();
        socket.emit('play');
      }
      return;
    }
    // Buffering and unstarted are not a pause or a play. A real pause
    // settles on PAUSED; a scrub that only blips through it resumes.
    if (code !== YTPS.PAUSED || !sawPlaying || pendingPause) return;
    if (!state.playing && !pendingPlay) return;
    extendGrace();
    const pausedAt = readPlayerTime();
    clearTimeout(pauseConfirm);
    pauseConfirm = setTimeout(() => {
      pauseConfirm = null;
      if (!playerReady || !state || pendingPause) return;
      if (!state.playing && !pendingPlay) return;
      if (readPlayerState() !== YTPS.PAUSED) return;
      const actual = readPlayerTime();
      if (Math.abs(actual - pausedAt) > 0.4) queueSeek(actual);
      pendingPlay = false;
      pendingPause = true;
      extendGrace();
      socket.emit('pause');
    }, 280);
  }

  // A user seek is a jump in the player clock, not the slow drift the sync
  // loop corrects. Playing time should advance about one tick; anything that
  // leaps further, or moves while paused, is someone moving YouTube's bar.
  function detectUserSeek() {
    if (!playerReady || !state || !state.current || loadedItemId !== state.current.id) return;
    const now = Date.now();
    const actual = readPlayerTime();
    if (commandedTime != null) {
      if (Math.abs(actual - commandedTime) <= DRIFT_TOLERANCE) {
        commandedTime = null;
        lastSample = { time: actual, at: now };
        return;
      }
      const moved = lastSample && Math.abs(actual - lastSample.time) > SEEK_JUMP;
      if (!moved && now < commandUntil) {
        lastSample = { time: actual, at: now };
        return;
      }
      commandedTime = null;
    }
    let jumped = false;
    if (lastSample) {
      const elapsed = (now - lastSample.at) / 1000;
      const delta = actual - lastSample.time;
      const expectedDelta = state.playing ? elapsed : 0;
      if (delta > expectedDelta + SEEK_JUMP || delta < -SEEK_JUMP) jumped = true;
    }
    lastSample = { time: actual, at: now };
    if (jumped) queueSeek(actual);
  }

  function transportAgrees(playerState, playing) {
    if (playing) return playerState === 1 || playerState === 3;
    return playerState === 2 || playerState === 5 || playerState === -1 || playerState === 0;
  }

  // Push the shared room onto this player. Used for someone else's action
  // and for the echo of our own, never to override a click still in flight.
  function applyState() {
    if (!playerReady || !state) return;
    const { current, playing } = state;

    if (!current) {
      if (loadedItemId) player.stopVideo();
      loadedItemId = null;
      lastSample = null;
      return;
    }

    const expected = expectedPosition();
    if (loadedItemId !== current.id) {
      loadedItemId = current.id;
      lastSample = null;
      sawPlaying = false;
      commandedTime = expected;
      commandUntil = Date.now() + 1500;
      loadGraceUntil = Date.now() + LOAD_GRACE_MS;
      const opts = { videoId: current.videoId, startSeconds: expected };
      if (playing) player.loadVideoById(opts);
      else player.cueVideoById(opts);
      return;
    }

    if (inGrace()) {
      deferredRemote = true;
      return;
    }
    deferredRemote = false;

    const playerState = readPlayerState();
    if (Math.abs(readPlayerTime() - expected) > DRIFT_TOLERANCE) {
      commandedTime = expected;
      commandUntil = Date.now() + 1200;
      player.seekTo(expected, true);
    }
    if (playing && playerState !== 1 && playerState !== 3) player.playVideo();
    if (!playing && (playerState === 1 || playerState === 3)) player.pauseVideo();
  }

  // Only nudge the clock when both sides already agree on play or pause.
  // A click changes the player first; forcing play or pause here undoes it
  // before that click can be broadcast.
  function correctDrift() {
    if (!playerReady || !state || !state.current || loadedItemId !== state.current.id) return;
    if (inGrace()) return;
    const playerState = readPlayerState();
    if (!transportAgrees(playerState, state.playing)) return;
    const expected = expectedPosition();
    if (Math.abs(readPlayerTime() - expected) <= DRIFT_TOLERANCE) return;
    commandedTime = expected;
    commandUntil = Date.now() + 1200;
    player.seekTo(expected, true);
  }

  function tick() {
    if (!state) return;
    detectUserSeek();
    if (!inGrace() && deferredRemote) applyState();
    else correctDrift();
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
  function applyVideoMode() {
    els.app.classList.toggle('video-on', videoOn);
    els.videoToggle.classList.toggle('active', videoOn);
    els.videoToggle.setAttribute('aria-pressed', String(videoOn));
    // The "tap to start audio" button sits over whichever is visible.
    (videoOn ? els.playerHost : els.artBox).append(els.syncBtn);
  }

  function render() {
    const { current, queue, members, playing } = state;

    els.app.classList.toggle('has-song', !!current);

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
    // While a native scrub is in flight, follow the player instead of the
    // old room clock so the room's own bar doesn't leap backwards.
    const live = !seeking && playerReady && state && state.current && (pendingSeekAt != null || Date.now() < userGraceUntil);
    const position = live
      ? readPlayerTime()
      : Math.min(expectedPosition(), duration || Infinity);
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
    bindVoice();

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

    els.videoToggle.addEventListener('click', () => {
      videoOn = !videoOn;
      localStorage.setItem('video', videoOn ? 'on' : 'off');
      applyVideoMode();
      // Clicks count as a user gesture, which the floating window needs to resize.
      if (pipWindow) {
        try { pipWindow.resizeBy(0, videoOn ? PIP_VIDEO_EXTRA : -PIP_VIDEO_EXTRA); } catch { /* user can resize */ }
      }
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
    if (isEmojiOnly(text)) {
      // Emoji-only messages float as plain, bigger emoji — no bubble or name.
      bubble.className = 'floater message-floater emoji-message';
      bubble.textContent = text;
    } else {
      bubble.className = 'floater message-floater';
      const name = doc.createElement('span');
      name.className = 'from';
      name.textContent = from;
      const body = doc.createElement('span');
      body.textContent = text;
      bubble.append(name, body);
    }

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

  // ---------- Voice messages ----------
  // Hold 🎤 to record, release to send. Incoming ones wait in the tray until
  // tapped, play once (one at a time, queued in tap order), then disappear.
  function bindVoice() {
    const button = els.voiceBtn;
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId); // keep getting events if the finger slides off
      startRecording();
    });
    button.addEventListener('pointerup', () => stopRecording(true));
    button.addEventListener('pointercancel', () => stopRecording(false));
    // Keyboard (Enter/Space): first press starts, second press sends.
    button.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      if (recording) stopRecording(true);
      else startRecording();
    });
    button.addEventListener('contextmenu', (e) => e.preventDefault());

    voiceAudio.addEventListener('timeupdate', () => {
      if (!voicePlaying) return;
      const progress = Math.min(1, voiceAudio.currentTime / voicePlaying.duration);
      voicePlaying.el.style.setProperty('--progress', progress);
    });
    voiceAudio.addEventListener('ended', () => voicePlaying && finishVoiceNote(voicePlaying));
    voiceAudio.addEventListener('error', () => {
      if (!voicePlaying) return;
      toast('Couldn’t play that voice message.');
      finishVoiceNote(voicePlaying);
    });
  }

  async function startRecording() {
    if (recording) return;
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      toast('Voice messages aren’t supported in this browser.');
      return;
    }
    const rec = { chunks: [], released: false, cancelled: false };
    recording = rec;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      recording = null;
      toast('Allow microphone access to send voice messages.');
      return;
    }
    // Released while the permission prompt was up: nothing to record yet.
    if (rec.released) {
      stream.getTracks().forEach((track) => track.stop());
      recording = null;
      toast('Mic ready — hold 🎤 to record.');
      return;
    }
    const mimeType = VOICE_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    rec.stream = stream;
    rec.recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    rec.recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) rec.chunks.push(e.data);
    });
    rec.recorder.addEventListener('stop', () => finishRecording(rec));
    rec.recorder.start();
    rec.startedAt = Date.now();
    rec.statusTimer = setInterval(updateRecordingStatus, 200);
    rec.maxTimer = setTimeout(() => stopRecording(true), VOICE_MAX_MS);
    setRecordingUi(true);
    updateDuck();
  }

  function stopRecording(send) {
    const rec = recording;
    if (!rec) return;
    rec.released = true;
    if (!rec.recorder) return; // still waiting on the mic permission prompt
    rec.cancelled = rec.cancelled || !send;
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  }

  async function finishRecording(rec) {
    clearInterval(rec.statusTimer);
    clearTimeout(rec.maxTimer);
    rec.stream.getTracks().forEach((track) => track.stop());
    recording = null;
    setRecordingUi(false);
    updateDuck();

    const durationMs = Date.now() - rec.startedAt;
    if (rec.cancelled) return;
    if (durationMs < VOICE_MIN_MS) {
      toast('Hold 🎤 to record.');
      return;
    }
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType });
    const audio = await blob.arrayBuffer();
    const duration = Math.round(Math.min(durationMs, VOICE_MAX_MS) / 100) / 10;
    socket.emit('voice', { audio, mimeType: blob.type, duration }, (res) => {
      toast(res && res.error ? res.error : 'Voice message sent 🎤');
    });
  }

  function setRecordingUi(on) {
    els.messageForm.classList.toggle('recording', on);
    els.messageInput.hidden = on;
    els.recordingStatus.hidden = !on;
    if (on) updateRecordingStatus();
  }

  function updateRecordingStatus() {
    if (!recording || !recording.startedAt) return;
    const seconds = (Date.now() - recording.startedAt) / 1000;
    els.recordingStatus.textContent = `● ${formatTime(seconds)} / ${formatTime(VOICE_MAX_MS / 1000)} · release to send`;
  }

  function addVoiceNote({ audio, mimeType, duration, from }) {
    const doc = els.app.ownerDocument;
    const note = {
      from,
      duration,
      url: URL.createObjectURL(new Blob([audio], { type: mimeType })),
      state: 'waiting',
    };
    note.el = doc.createElement('button');
    note.el.type = 'button';
    note.el.className = 'voice-note';
    note.el.addEventListener('click', () => playVoiceNote(note));
    note.expireTimer = setTimeout(() => removeVoiceNote(note), VOICE_EXPIRE_MS);
    voiceNotes.push(note);
    renderVoiceNote(note);
    els.voiceTray.append(note.el);

    // Keep the tray small: drop the oldest untouched ones.
    let waiting = voiceNotes.filter((n) => n.state === 'waiting');
    while (waiting.length > VOICE_TRAY_MAX) {
      removeVoiceNote(waiting.shift());
    }
  }

  function renderVoiceNote(note) {
    const icon = { waiting: '▶', queued: '⏳', playing: '🔊' }[note.state];
    note.el.textContent = `🎤 ${note.from} · ${formatTime(note.duration)} ${icon}`;
    note.el.classList.toggle('queued', note.state === 'queued');
    note.el.setAttribute('aria-label', `Voice message from ${note.from}, ${Math.round(note.duration)} seconds. Plays once.`);
  }

  function playVoiceNote(note) {
    if (note.state !== 'waiting') return;
    clearTimeout(note.expireTimer); // tapped ones always get played
    note.state = 'queued';
    renderVoiceNote(note);
    if (!voicePlaying) playNextVoiceNote();
  }

  function playNextVoiceNote() {
    const note = voiceNotes.find((n) => n.state === 'queued') || null;
    voicePlaying = note;
    updateDuck();
    if (!note) return;
    note.state = 'playing';
    renderVoiceNote(note);
    // One shared <audio> element: once a tap has unlocked it, later notes in
    // the queue can play without another tap (needed on iOS).
    voiceAudio.src = note.url;
    voiceAudio.play().catch(() => {
      toast('Couldn’t play that voice message.');
      finishVoiceNote(note);
    });
  }

  function finishVoiceNote(note) {
    removeVoiceNote(note);
    if (voicePlaying === note) {
      voicePlaying = null;
      playNextVoiceNote();
    }
  }

  function removeVoiceNote(note) {
    if (!voiceNotes.includes(note)) return;
    clearTimeout(note.expireTimer);
    URL.revokeObjectURL(note.url);
    note.el.remove();
    voiceNotes = voiceNotes.filter((n) => n !== note);
  }

  // Turn the music down while recording (so the mic doesn't pick it up) and
  // while a voice message plays; restore the listener's volume afterwards.
  function updateDuck() {
    const shouldDuck = !!(recording && recording.recorder) || !!voicePlaying;
    if (!playerReady) return;
    if (shouldDuck && savedVolume === null) {
      savedVolume = player.getVolume();
      player.setVolume(Math.round(savedVolume * DUCK_LEVEL));
    } else if (!shouldDuck && savedVolume !== null) {
      player.setVolume(savedVolume);
      savedVolume = null;
    }
  }

  // ---------- Floating window (Document Picture-in-Picture) ----------
  async function togglePip() {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({
        width: 360,
        height: PIP_HEIGHT + (videoOn ? PIP_VIDEO_EXTRA : 0),
      });
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
  // True for text made only of emoji (incl. skin tones, flags, ZWJ sequences)
  // and spaces. Keycap emoji like 1️⃣ contain a digit, so they count as text.
  const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F\s]+$/u;
  const HAS_EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
  function isEmojiOnly(text) {
    return EMOJI_ONLY.test(text) && HAS_EMOJI.test(text);
  }

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
