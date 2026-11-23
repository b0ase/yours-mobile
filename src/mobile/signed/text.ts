import { bavatarSvg } from '../bavatar/bavatar';
import type { FinishOutcome } from './session';
import type { SignedTab } from './signedList';

/** Signed's words and small formatters (no components here: react-refresh/only-export-components). */

export const EMPTY_TEXT = 'Nothing signed yet. Documents you sign in bChatX rooms show up here.';
export const TAB_EMPTY: Record<SignedTab, string> = {
  waiting: 'Nothing is waiting for your signature.',
  signed: 'Nothing signed and still waiting for others or for its seal.',
  sealed: 'Nothing sealed on Bitcoin yet.',
};

/** The page's own live / coming checklist (owner, 15 Oct 2026: every feature page shows one). */
export const PAGE_STATUS: { label: string; live: boolean }[] = [
  { label: 'Waiting for me', live: true },
  { label: 'Signed', live: true },
  { label: 'Sealed on Bitcoin, with a link to the seal', live: true },
  { label: 'Held seals: Finish', live: true },
  { label: 'Kept on this device, works offline', live: true },
  { label: 'Search', live: false },
  { label: 'Export', live: false },
];

export const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unknown';
export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export type FinishState = { k: 'idle' } | { k: 'working' } | FinishOutcome;
/** What the banner says after a Finish: the TRUE outcome, never "Recorded" unless bit-sign recorded it. */
const alsoText = (n?: number) =>
  n ? ` ${n === 1 ? 'One other seal for it was' : `${n} other seals for it were`} recorded.` : '';
export const finishText = (st: FinishState): string => {
  switch (st.k) {
    case 'working':
      return 'Checking…';
    case 'recorded':
      return 'Recorded. It is in Sealed now.';
    case 'orphaned':
      return 'Another party sealed this document first. Your payment is recorded; nothing more to do.';
    case 'replayed':
      return "Already recorded with an earlier payment; this one wasn't needed.";
    case 'released':
      return 'Nothing was paid; you can seal again.';
    case 'kept':
      return 'Still checking. It stays here and is tried again; nothing is paid twice.' + alsoText(st.alsoRecorded);
    case 'wrong_handle':
      return (
        `bChatX doesn't know this seal for the handle you're signed in as (${st.handle ? `$${st.handle.replace(/^[$@]/, '')}` : 'this one'}). ` +
        'It stays held. Sign in as the handle that sealed it.' +
        alsoText(st.alsoRecorded)
      );
    case 'refused':
      return st.reason + alsoText(st.alsoRecorded);
    case 'sign_in':
      return 'Sign in to bChatX to finish this.';
    case 'account_changed':
      return 'You switched accounts. Finish it from the account that sealed it.';
    case 'offline':
      return 'You are offline. Finish it when you are back online.';
    case 'failed':
      return 'Could not finish just now. Try again in a minute.';
    default:
      return '';
  }
};
/** Another page or window is checking or paying this seal right now (held.busyElsewhere): Finish waits. */
export const BUSY_TEXT = 'Being checked in another window. Nothing is paid twice.';

/** A held seal on this device with no identity key (saved before 6 Nov 2026): whose it is can't be told here. */
export const OLDER_HELD_TEXT = 'A seal from an older version is held. Open its document to finish.';
/** A held document's row: being finished, not "Needs your signature". */
export const FINISHING_ROW_TEXT = 'Finishing';

const art = new Map<string, string>();
/** Gold by default: a bAvatar seeded by the room (or the title), never a grey tile. */
export const artFor = (seed: string, size: number) => {
  const k = `${size}:${seed}`;
  let a = art.get(k);
  if (!a) {
    a = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(seed || 'signed', { size }));
    art.set(k, a);
  }
  return a;
};
