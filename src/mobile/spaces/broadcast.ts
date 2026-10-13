/**
 * Space Broadcast (owner, 13 Oct 2026): the host or a speaker sends a tab or screen (the V3XV0ID AV
 * client, the aivj.website mixer) into the Space, or opens bTV: AIVJ's studio for this Space.
 * Pure helpers, tested in broadcast.test.ts.
 */

/** The Space's room as bTV: AIVJ's studio takes it (`?room=VEXVOID`). */
export const studioRoomParam = (ticker: string) => encodeURIComponent(ticker.trim().replace(/^\$/, '').toUpperCase());

/** The host's bChatX profile: a live Space plays pinned at the top of it. */
export const profileUrlOf = (handle: string) =>
  `https://www.bchatx.com/u/${encodeURIComponent(
    handle
      .trim()
      .replace(/^[@$]/, '')
      .replace(/\.screen$/, '')
      .toLowerCase(),
  )}`;
