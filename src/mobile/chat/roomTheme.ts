import { roomTicker } from './siteRoom';

/**
 * Per-room chat bubble colours (owner, 27 Oct 2026: "the TERRORNODE chatroom in the wallet has blue and yellow chat
 * bubbles, but they should be red and pink, or dark red"). The blue came from the connected game's theme accentHi
 * (roomLook.ts) blended into the gold "mine" gradient. A room listed here wears its own bubbles and a pink accent
 * (links, send button) whatever site theme dresses it. Every other room is unchanged.
 *
 * Dark theme only: the White theme's own bubble rules (themes.css, :root[data-bw-paper], !important) still win, so
 * a white-theme user sees black-on-white bubbles in this room like every other.
 *
 * Text on both bubbles meets WCAG AA (>= 4.5:1); roomTheme.test.ts checks it.
 */
export type RoomBubbles = {
  mineBg: string;
  mineText: string;
  theirsBg: string;
  theirsText: string;
  theirsBorder: string;
  /** Links, the send button and other accent-coloured controls inside the room. */
  accent: string;
};

const ROOM_BUBBLES: Record<string, RoomBubbles> = {
  TERRORNODE: {
    mineBg: '#B3121E',
    mineText: '#FFFFFF',
    theirsBg: '#3A0A10',
    theirsText: '#FFD6DC',
    theirsBorder: '#5C1520',
    accent: '#FF4D6D',
  },
};

/** The room's own bubble colours, matched by its ticker ($ and case ignored), or null for the default look. */
export function roomBubbles(ticker: string | null | undefined): RoomBubbles | null {
  const t = roomTicker(ticker ?? '');
  return (t && ROOM_BUBBLES[t]) || null;
}
