# Game streaming into token rooms (owner, 8 Oct 2026; plan only)

**Lead example: $ARENA** (the multiplayer arena game on tokenblaster.lol; owner, 8 Oct: "a much better example"). Matches are already happening between players, so the $ARENA room can show them **live without anyone streaming**: the game itself provides a spectator feed. Holders watch matches, chat, react and tip the players. Single-player games like **$FROGGER\*\* use the streamer route below, where one person plays and holders watch.

## Route 0 (best, for multiplayer games like Arena): spectator feed from the game

- The game server already knows the full match state. It exposes a **spectator view**: a read-only page (`/spectate/<match>`) the room embeds in a "Watching now" panel, or a server-side render pushed as a video track into the room's Space.
- No player's device or upload is involved, so it costs almost nothing compared with video, and it scales well (state updates, not video).
- The room shows **live matches** ("🎮 LIVE: $a vs $b"), with the scoreboard, results posted as room event cards (see the room event-feeds idea), and tips to players.
- Needs from tokenblaster.lol: a spectator endpoint (state over WebSocket) and a lightweight spectator renderer. Ours to build, since we own the game.

## How a game becomes a stream

1. **Canvas capture (the main route, web games).** Most catalogue games (Frogger, Arena, …) render to a `<canvas>` inside the wallet's bApp frame. `canvas.captureStream(30)` gives a video track, plus the game's WebAudio via a MediaStreamDestination. The wallet publishes those as a LiveKit track in the room's Space. No screen-share prompt is needed, and only the game is sent, never notifications or other tabs.
   - Needs a small opt-in from the game: a `postMessage` handshake ("bwallet:stream-ready" → hand over the canvas/stream), or the frame being same-origin. Third-party games add a 5-line snippet; our own games ship it.
2. **Screen/window share (desktop fallback):** `getDisplayMedia` in the web wallet and the extension tab, for any game (including native ones). The Chrome extension needs the permission tab (5.1.88).
3. **Phones:** Android can use MediaProjection later. iOS needs a ReplayKit broadcast extension, which is a bigger, later job. Phones can **watch** from day one.

## In the room

- "**Go live: stream this game**" button on a game's page (for holders of the game's token), which starts a Space in that token's room in **stream mode**: the streamer is the stage, the game video is the main view, and the streamer's mic and camera are an optional picture-in-picture.
- Viewers: full-screen game view, live chat beside it, emoji reactions, tips to the streamer. The room card shows "🎮 LIVE: $alice playing Frogger".
- **Score overlay:** if the game reports scores (postMessage `score`), show them on stream and in a room leaderboard (ties into the existing locked-leaderboard work).
- Spectator pages: public Space pages (`/s/<slug>`) can show the stream to non-holders if the host allows. Replays use the recordings plan in BSPACES-PLAN.

## Costs and limits (see the LiveKit server plan)

- One streamer → many viewers is the expensive case. Use simulcast with a 720p30 cap. Above ~200 viewers, switch to HLS egress or a CDN instead of the SFU. That ties into putting LiveKit on its own server.
- Only token holders (or ticket holders) can watch unless the host makes it public.

## Phases

| #   | What                                                                                                                   | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| G0  | **$ARENA spectator feed**: live matches in the ARENA room (state-stream renderer, match cards, results as room events) | M    |
| G1  | Canvas capture from our own catalogue games (Frogger), stream mode in Spaces, "Go live" on the game page               | M    |
| G2  | Screen/window share fallback (web + extension)                                                                         | S    |
| G3  | Score overlay + room leaderboard                                                                                       | S–M  |
| G4  | Public spectator pages, replays (with recordings)                                                                      | M    |
| G5  | Android capture; iOS ReplayKit broadcast                                                                               | L    |

Depends on: LiveKit on its own server and its limits, for anything beyond small audiences.
