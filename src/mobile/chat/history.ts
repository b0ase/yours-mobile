/**
 * "New members can see earlier messages" — the client half. The rule is enforced by bit-sign
 * (src/lib/room-history.ts): a since_join room never SENDS a member messages from before they
 * joined. This file only parses what the server says and holds the wording.
 *
 * On-chain: bit-sign writes only SHA-256 fingerprints of messages (and, in priced rooms, the
 * room, the sender and the time), never the text and no ciphertext, so the copy can say
 * "hidden in the app" truthfully. It is not "private": people who were already in the room
 * have read it, and the operator's database still holds it.
 */
export type HistoryVisibility = 'all' | 'since_join';

export const parseHistoryVisibility = (v: unknown): HistoryVisibility => (v === 'since_join' ? 'since_join' : 'all');

export interface HistorySetting {
  visibility: HistoryVisibility;
  /** Set when THIS reader's view starts at their join (non-admin in a since_join room). */
  hiddenBefore: string | null;
  canChange: boolean;
}

export const parseHistorySetting = (j: unknown): HistorySetting => {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  return {
    visibility: parseHistoryVisibility(o.history_visibility),
    hiddenBefore: typeof o.history_hidden_before === 'string' ? o.history_hidden_before : null,
    canChange: o.can_change === true,
  };
};

export const HISTORY_TOGGLE_LABEL = 'New members can see earlier messages';
export const HISTORY_ON_NOTE = 'Anyone who joins can read the whole conversation.';
export const HISTORY_OFF_NOTE =
  'Members only see messages from when they joined, current members included. You still see everything. Earlier messages are hidden in the app, not deleted.';
export const HISTORY_HIDDEN_NOTE = 'Earlier messages are hidden for new members.';

/** Show the note at the top of the thread? Only to a reader whose view is floored. */
export const showHistoryNote = (hiddenBefore: string | null | undefined) => !!hiddenBefore;
