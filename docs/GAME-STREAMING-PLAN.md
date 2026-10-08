# Game streaming into token rooms (owner, 8 Oct 2026; plan only)

Example: the owner holds the **$FROGGER** token. Frogger is single-player, but play can be **livestreamed into the FROGGER room** as a Space: one person plays, holders watch, chat, react and tip. The same works for Arena (tokenblaster.lol) and every game in the Games catalogue.

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
| # | What | Size |
|---|---|---|
| G1 | Canvas capture from our own catalogue games (Frogger first), stream mode in Spaces, "Go live" on the game page | M |
| G2 | Screen/window share fallback (web + extension) | S |
| G3 | Score overlay + room leaderboard | S–M |
| G4 | Public spectator pages, replays (with recordings) | M |
| G5 | Android capture; iOS ReplayKit broadcast | L |

Depends on: LiveKit on its own server and its limits, for anything beyond small audiences.
