# Listen Together

Shared YouTube listening rooms with a floating mini-player. Audio only — the video is
hidden and the thumbnail is shown as cover art.

- Create a room, share the link, and everyone hears the same thing in sync.
- Anyone in the room can paste YouTube links, play/pause, seek, skip, and reorder the queue.
- **Float** opens an always-on-top mini-player (Document Picture-in-Picture, desktop Chrome/Edge).

## Run

```sh
npm install
npm start          # http://localhost:3000
```

To let friends join from other devices, deploy it anywhere that runs Node and supports
WebSockets (Render, Railway, Fly.io…) or expose it temporarily with a tunnel, e.g.
`npx cloudflared tunnel --url http://localhost:3000`. The floating window needs HTTPS
(localhost is exempt).

## Deploy to Render

`render.yaml` defines the service. In the Render dashboard choose **New → Blueprint**,
pick this repo, and apply. Keep it to a single instance — rooms are held in memory.
On the free plan the service sleeps after ~15 minutes without traffic (the first visit
then takes a while to wake it), and any open rooms are lost when it sleeps or redeploys.

## How it works

- `server.js` — Express + Socket.IO. Holds each room's queue and a playback clock
  (`position` at `updatedAt`); every client derives the current position from it.
  Rooms live in memory and are dropped 30 minutes after the last person leaves.
- `public/app.js` — joins the room, estimates server clock offset, and keeps the YouTube
  IFrame player within 1.5 s of the shared clock.
- The YouTube player is rendered at 200×200 with `opacity: 0` rather than `display: none`,
  since browsers may not load or play media in hidden frames. Note that YouTube's API
  terms expect the player to be visible, so keep this in mind before publishing widely.
- `public/player-frame.html` — hosts the player inside the floating window, which is an
  `about:blank` document; YouTube refuses embeds without a referrer (error 153).

## Platform notes

| Platform | Floating window | Background play |
| --- | --- | --- |
| Desktop Chrome / Edge | Yes (Float button) | Yes |
| Desktop Firefox / Safari | No | Yes (background tab) |
| Android / iOS | No | Unreliable — YouTube embeds usually pause when the screen locks |
