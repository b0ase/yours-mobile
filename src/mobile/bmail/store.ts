/**
 * bMail local state per identity key (localStorage): received mail (envelope + verification), sent mail
 * (plaintext copy, since the sealed copy is only readable by the recipient… and us, but we keep it simple),
 * read marks, contacts (people I wrote to) and my price to reach me.
 */
import { Hash, Utils } from '@bsv/sdk';
import type { Envelope, Sealed, SealedOrdinal } from './envelope';
import { PENNY_POST_USD, type MailMeta } from './route';

export type Received = MailMeta & {
  env: Envelope;
  /** Relay message id (to clear it from the relay once this device erased the letter). */
  relayId?: string;
  verifyNote?: string;
  /**
   * The postage could not be checked yet (wallet or chain lookup unavailable): first and last try, unix ms. The letter
   * counts as unstamped meanwhile; client.ts recheckPostage tries again and settles it (paid, or unpaid for good).
   */
  recheck?: {
    first: number;
    /** The last check against the network (0: none yet). */
    last: number;
    /** Checks the wallet and the network answered without settling it. */
    tries: number;
    /** The wallet has found that the stamp pays this account (no network asked yet). */
    mine?: true;
    /** When a check first said "unpaid" on an answer that one look does not settle (client.ts StampCheck.confirm). */
    doubt?: number;
  };
  /**
   * The stamp was given up on without a refusal (no answer in time): unix ms of the last look. The letter is unpaid,
   * and checked again when it is opened (client.ts recheckLetter).
   */
  stampOpen?: number;
  /**
   * Paid by a stamp that was not in a block yet: when it was found paid, the last look for a confirmation, and when
   * a look first found the network without it (client.ts settleConfirmations).
   */
  settling?: { since: number; last: number; doubt?: number };
  /** The account's record of this letter's stamp is in the wallet (or cannot be): client.ts recordOldStamps. */
  stampRecorded?: true;
  read?: boolean;
  /** Decrypted on open; kept locally so it opens instantly next time. */
  opened?: Sealed;
  /** Swipe-to-organise flags (local only: the relay has no per-message state). */
  archived?: boolean;
  /** Soft delete: kept (hidden) so a refresh can't bring it back and Undo can restore it. */
  deleted?: boolean;
  spam?: boolean;
  pinned?: boolean;
  /** When it went to the Bin (unix ms). After BIN_MS its content is erased locally (purgeBin). */
  deletedAt?: number;
  /** Content erased after 30 days in the Bin: only a tombstone (id, sender, postage record) is kept. */
  erased?: boolean;
};
export type MailFlags = Pick<Received, 'read' | 'archived' | 'deleted' | 'spam' | 'pinned' | 'deletedAt'>;
export type Sent = {
  id: string;
  to: string;
  toLabel: string;
  at: number;
  subject: string;
  body: string;
  sats: number;
  replyPaidSats: number;
  txid?: string;
  inReplyTo?: string;
  /** Bureau agreement part sent with this mail (kept so the Bureau shows what I sent and signed). */
  agreement?: unknown;
  /** Company offer payload sent with this mail (offer/payload.ts): kept so both parties' vaults show it. */
  offer?: unknown;
  /** NFT and signed note sent with this mail (kept so the sent copy shows what went with it). */
  ordinal?: SealedOrdinal;
  note?: unknown;
};
export type MailState = {
  received: Received[];
  sent: Sent[];
  /** Identity keys I wrote to: they count as contacts (free, on top). */
  contacts: string[];
  /** Price to reach me in USD (Penny post by default). */
  priceUsd: number;
  /** Reply-paid credits others gave me: message id → sats (used when I reply). */
  usedCredits: string[];
  /** Senders I blocked or marked as spam: their mail goes straight to Quarantine, unopened. */
  blocked?: string[];
  /** Senders I chose to trust ("Trust sender"): links in their mail are clickable. */
  trusted?: string[];
};

export const emptyMail = (): MailState => ({
  received: [],
  sent: [],
  contacts: [],
  priceUsd: PENNY_POST_USD,
  usedCredits: [],
});

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const ls = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const key = (me: string) => `bw-bmail:${me}`;

export const loadMail = (me: string, st: Store | null = ls()): MailState => {
  try {
    const j = JSON.parse(st?.getItem(key(me)) ?? 'null') as Partial<MailState> | null;
    return { ...emptyMail(), ...(j ?? {}) };
  } catch {
    return emptyMail();
  }
};

const listeners = new Set<() => void>();
export const subscribeMail = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** At most this many received letters are stored. */
export const RECEIVED_MAX = 1000;
/** This many of the newest letters from senders the user has no dealings with are kept as any other mail is. */
export const STRANGERS_KEPT = 200;
/**
 * The line: at most this many stamped letters from senders the user has no dealings with wait, stored, for an answer
 * about their stamp (client.ts fetchMail takes no more from the relay while the line is full).
 */
export const WAITING_MAX = 100;
/**
 * A stamped letter no check has answered for yet: not looked at, or looked at while the wallet or the network could
 * not answer (an outage). Its coin may be real.
 */
export const isWaiting = (r: Received): boolean =>
  !!r.recheck && r.recheck.tries === 0 && r.recheck.doubt === undefined;
const dealtWith = (s: MailState, from: string) => s.contacts.includes(from) || (s.trusted ?? []).includes(from);
/** A letter in the line (WAITING_MAX): waiting, from a sender the user has no dealings with and has not blocked. */
export const inLine = (s: MailState, r: Received): boolean =>
  isWaiting(r) && !dealtWith(s, r.from) && !isBlockedSender(s, r.from);
/**
 * A sender the user blocked: their mail is stored for Quarantine, and that is all. It waits for nothing: its stamps
 * are not checked (client.ts recheckPostage; unblocking the sender starts the checks) and it holds no place in the
 * line.
 */
export const isBlockedSender = (s: MailState, from: string): boolean => (s.blocked ?? []).includes(from);
/**
 * Keep the store within RECEIVED_MAX without losing the user's own mail to a flood.
 *
 * The line is kept apart: its oldest WAITING_MAX letters are stored on top of RECEIVED_MAX, so a letter waiting for
 * its stamp to be checked is never dropped and never pushes anything out. Letters in the line beyond that (there are
 * none while fetchMail holds the line) go first of all, newest first, so the oldest waiting keep their place.
 *
 * Then, of everything else, what goes first, oldest first:
 *  1. unread, unpaid letters from senders the user has no dealings with, neither pinned nor archived, beyond the
 *     newest STRANGERS_KEPT of them: what a flood is made of;
 *  2. deleted letters (the Bin, erased tombstones);
 *  3. letters whose stamp a check has already answered for and found wanting, but not yet for good;
 *  4. everything else: a full store still shows new mail and drops its oldest.
 * A dropped letter cannot come back as new: the relay ledger still knows its relay message (loadRelaySeen).
 */
export const trimReceived = (s: MailState): Received[] => {
  const line = s.received.filter((r) => inLine(s, r));
  // received is newest first: the oldest WAITING_MAX of the line keep their place.
  const kept = new Set(line.slice(-WAITING_MAX));
  const drop = new Set<Received>(line.filter((r) => !kept.has(r)));
  let over = s.received.length - kept.size - drop.size - RECEIVED_MAX;
  if (over <= 0 && !drop.size) return s.received;
  let strangers = 0;
  const rank = new Map<Received, number>();
  for (const r of s.received) {
    if (kept.has(r) || drop.has(r)) continue;
    const mine = r.read || r.pinned || r.archived || r.verifiedSats > 0 || r.replyCredit;
    // A blocked sender's unopened mail counts with the strangers' flood, stamped or not.
    if (isBlockedSender(s, r.from) && !mine && !r.deleted) rank.set(r, ++strangers > STRANGERS_KEPT ? 0 : 3);
    else if (r.recheck) rank.set(r, isWaiting(r) ? 3 : 2);
    else if (r.deleted) rank.set(r, 1);
    else if (mine || dealtWith(s, r.from)) rank.set(r, 3);
    else rank.set(r, ++strangers > STRANGERS_KEPT ? 0 : 3);
  }
  for (const level of [0, 1, 2, 3])
    for (let i = s.received.length - 1; i >= 0 && over > 0; i--)
      if (rank.get(s.received[i]) === level) {
        drop.add(s.received[i]);
        over--;
      }
  return s.received.filter((r) => !drop.has(r));
};

export const saveMail = (me: string, s: MailState, st: Store | null = ls()) => {
  try {
    st?.setItem(key(me), JSON.stringify({ ...s, received: trimReceived(s), sent: s.sent.slice(0, 1000) }));
  } catch {
    /* storage full: still works this session */
  }
  listeners.forEach((l) => l());
};

export const updateMail = (me: string, f: (s: MailState) => MailState) => saveMail(me, f(loadMail(me)));

/** Add received mail, skipping ids we already have. */
export const addReceived = (s: MailState, items: Received[]): MailState => {
  const have = new Set(s.received.map((r) => r.id));
  const fresh = items.filter((i) => !have.has(i.id));
  return fresh.length ? { ...s, received: [...fresh, ...s.received] } : s;
};

/** Mail that belongs in Inbox/Requests: not archived, deleted, spam, or from a blocked sender. */
export const isLive = (r: Received, blocked: string[] = []) =>
  !r.archived && !r.deleted && !r.spam && !blocked.includes(r.from);
/** Quarantine: mail marked spam or from a blocked sender (not deleted). Never opened automatically. */
export const isQuarantined = (r: Received, blocked: string[] = []) =>
  !r.deleted && (!!r.spam || blocked.includes(r.from));
/** The Bin view: deleted mail whose content has not been erased yet. */
export const isInBin = (r: Received) => !!r.deleted && !r.erased;
/** Deleted mail is kept this long in the Bin (Restore works), then its content is erased locally. */
export const BIN_MS = 30 * 24 * 60 * 60 * 1000;
/** Days left before a binned letter is erased (rounded up, never below 0). */
export const binDaysLeft = (r: Pick<Received, 'deletedAt'>, now = Date.now()) =>
  Math.max(0, Math.ceil(((r.deletedAt ?? now) + BIN_MS - now) / (24 * 60 * 60 * 1000)));
/**
 * Erase the content of mail that has been in the Bin for BIN_MS: the decrypted copy and the sealed ciphertext go,
 * a tombstone stays so a refresh cannot bring it back. Money is untouched (postage was internalized on arrival).
 * Deleted mail from before the Bin existed (no deletedAt) starts its 30 days now.
 */
export const purgeBin = (s: MailState, now = Date.now()): MailState => {
  let changed = false;
  const received = s.received.map((r) => {
    if (!r.deleted || r.erased) return r;
    if (r.deletedAt === undefined) {
      changed = true;
      return { ...r, deletedAt: now };
    }
    if (now - r.deletedAt < BIN_MS) return r;
    changed = true;
    const { opened: _o, ...rest } = r;
    return { ...rest, erased: true, env: { ...r.env, sealed: '' } };
  });
  return changed ? { ...s, received } : s;
};
/** Restore from the Bin to wherever it was (Inbox/Requests, or Archive if it was archived). */
export const restoreFromBin = (s: MailState, ids: string[]): MailState => {
  const want = new Set(ids);
  return {
    ...s,
    received: s.received.map((r) => (want.has(r.id) && !r.erased ? { ...r, deleted: false, deletedAt: undefined } : r)),
  };
};

/** A sender whose links are clickable: a bPhone friend, someone I wrote to, or someone I chose to trust. */
export const isTrustedSender = (
  s: Pick<MailState, 'contacts' | 'trusted' | 'blocked'>,
  from: string,
  isFriend: (k: string) => boolean = () => false,
) =>
  !(s.blocked ?? []).includes(from) &&
  (isFriend(from) || s.contacts.includes(from) || (s.trusted ?? []).includes(from));
export const trustSender = (s: MailState, from: string): MailState => ({
  ...s,
  trusted: [...new Set([...(s.trusted ?? []), from])],
  blocked: (s.blocked ?? []).filter((k) => k !== from),
});

/** The Archive view. */
export const isArchived = (r: Received, blocked: string[] = []) =>
  !!r.archived && !r.deleted && !r.spam && !blocked.includes(r.from);
/** Pinned mail floats to the top, keeping the given order otherwise. */
export const pinnedFirst = <T extends { pinned?: boolean }>(xs: T[]): T[] => [
  ...xs.filter((x) => x.pinned),
  ...xs.filter((x) => !x.pinned),
];

/** Set flags on some mail; returns the new state and each message's previous flags (for Undo). */
export const setFlags = (
  s: MailState,
  ids: string[],
  patch: MailFlags,
  now = Date.now(),
): { next: MailState; prev: Record<string, MailFlags> } => {
  const want = new Set(ids);
  const prev: Record<string, MailFlags> = {};
  const received = s.received.map((r) => {
    if (!want.has(r.id)) return r;
    prev[r.id] = {
      read: r.read,
      archived: r.archived,
      deleted: r.deleted,
      spam: r.spam,
      pinned: r.pinned,
      deletedAt: r.deletedAt,
    };
    const stamp =
      patch.deleted === true && !r.deleted
        ? { deletedAt: now }
        : patch.deleted === false
          ? { deletedAt: undefined }
          : {};
    return { ...r, ...patch, ...stamp };
  });
  return { next: { ...s, received }, prev };
};
/** Put flags back exactly as they were (Undo). */
export const restoreFlags = (s: MailState, prev: Record<string, MailFlags>): MailState => ({
  ...s,
  received: s.received.map((r) => (prev[r.id] ? { ...r, ...prev[r.id] } : r)),
});

/**
 * Inbox-routed mail the notifier has seen on the relay but the bMail screen has not fetched yet (ids). Lets the
 * top-bar badge count new mail without the badge consuming the message box.
 */
const pendingKey = (me: string) => `bw-bmail-pending:${me}`;
export const loadPending = (me: string, st: Store | null = ls()): string[] => {
  try {
    const j = JSON.parse(st?.getItem(pendingKey(me)) ?? '[]') as unknown;
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
export const savePending = (me: string, ids: string[], st: Store | null = ls()) => {
  try {
    st?.setItem(pendingKey(me), JSON.stringify(ids.slice(0, 500)));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
};

/**
 * Mail stays on the relay this long after it arrived, so the user's other devices (phone, extension, web) can fetch
 * it too; only then does this device clear it from the relay (client.ts fetchMail).
 */
export const RELAY_KEEP_DAYS = 30;
export const RELAY_KEEP_MS = RELAY_KEEP_DAYS * 24 * 60 * 60 * 1000;
/** A message is cleared only when two refreshes at least this far apart both found it old enough. */
export const RELAY_CONFIRM_MS = 24 * 60 * 60 * 1000;
/**
 * The ledger keeps an entry for every message the relay lists, so nothing it lists is ever taken twice; this cap only
 * guards the storage quota (about 30 bytes an entry). Over it, the longest-known entries are the ones kept.
 */
export const RELAY_SEEN_MAX = 20_000;
/**
 * The ledger's key for a relay message id: 96 bits of its SHA-256. The sender chooses the id (up to 256 bytes); the
 * key is short, fixed in size and safe as a map key whatever the id is.
 */
export const relayKey = (messageId: string): string =>
  Utils.toBase64(Hash.sha256(Utils.toArray(String(messageId), 'utf8')).slice(0, 12));
/** `first`: when this device first saw the message. `due`: when it first found it old enough to clear (0: not yet). */
export type RelaySeen = Map<string, { first: number; due: number }>;
/**
 * Relay messages this device has already dealt with (stored, or refused), by relayKey. A listed message found here
 * is skipped without decoding or checking anything again. Only messages the relay still lists are kept, so it empties
 * as mail is cleared. Stored as [key, first, due] in whole minutes.
 */
const relaySeenKey = (me: string) => `bw-bmail-relay:${me}`;
const MIN = 60_000;
export const loadRelaySeen = (me: string, st: Store | null = ls()): RelaySeen => {
  const out: RelaySeen = new Map();
  try {
    const j = JSON.parse(st?.getItem(relaySeenKey(me)) ?? '[]') as unknown;
    for (const x of Array.isArray(j) ? j : []) {
      if (!Array.isArray(x) || typeof x[0] !== 'string' || !Number.isFinite(x[1]) || !Number.isFinite(x[2])) continue;
      out.set(x[0], { first: x[1] * MIN, due: x[2] * MIN });
    }
  } catch {
    /* an unreadable ledger is an empty one: stored letters are still known by their own ids */
  }
  return out;
};
export const saveRelaySeen = (me: string, seen: RelaySeen, st: Store | null = ls()) => {
  try {
    const rows = [...seen]
      .sort((a, z) => a[1].first - z[1].first)
      .slice(0, RELAY_SEEN_MAX)
      // Rounded so that neither time moves later: a rounded-up `due` could look like a clock that went back.
      .map(([k, v]) => [k, Math.floor(v.first / MIN), Math.floor(v.due / MIN)]);
    st?.setItem(relaySeenKey(me), JSON.stringify(rows));
  } catch {
    /* ignore */
  }
};

/**
 * Stamps that paid for a letter stored on this device: stamp outpoint ("txid.vout") → that letter's id. A shortcut
 * only (a later letter showing the same stamp is unstamped without asking anyone): the record that counts is the
 * account's, in the wallet (client.ts stampRecord).
 */
export const usedStamps = (s: MailState): Map<string, string> => {
  const used = new Map<string, string>();
  for (const r of [...s.received].reverse())
    if (r.env.postage && r.verifiedSats > 0 && !used.has(stampOutpoint(r.env.postage)))
      used.set(stampOutpoint(r.env.postage), r.id);
  return used;
};
/** The outpoint a letter's stamp claims. */
export const stampOutpoint = (p: { txid: string; outputIndex: number }) => `${p.txid}.${p.outputIndex}`;

/** Event the notifier / notification taps use to open the bMail screen. */
export const OPEN_BMAIL_EVENT = 'bw-open-bmail';
let composeTo: string | null = null;
/** Open bMail on a new mail to `to` ($handle / paymail), e.g. from Scan › person page. */
export const openBMailTo = (to: string) => {
  composeTo = to.trim() || null;
  openBMail();
};
/** The pending compose recipient, read once by BMailScreen. */
export const takeBMailComposeTo = () => {
  const t = composeTo;
  composeTo = null;
  return t;
};
/**
 * Owner, 26 Oct 2026: a compose link (meeting.ts parseComposeLink) opens Compose pre-filled; the user reviews it and
 * presses Send, which is the normal send path (postage, approval). Nothing is ever sent from here.
 */
export type BMailDraftRequest = { to?: string; subject?: string; body?: string; note?: unknown };
let composeDraft: BMailDraftRequest | null = null;
export const openBMailDraft = (d: BMailDraftRequest) => {
  composeDraft = { ...d };
  openBMail();
};
export const takeBMailDraft = () => {
  const d = composeDraft;
  composeDraft = null;
  return d;
};
/** A meeting_invite tap before the meeting: the Inbox, on the invite for this room when it can be found. */
let meetingTicker: string | null = null;
export const openBMailMeeting = (ticker: string) => {
  meetingTicker = ticker;
  openBMail();
};
export const takeBMailMeeting = () => {
  const t = meetingTicker;
  meetingTicker = null;
  return t;
};
/** Something is waiting for the bMail screen (asked for before the top bar was mounted, e.g. at launch). */
export const bmailRequestPending = () => !!(composeTo || composeDraft || meetingTicker);
export const openBMail = () => {
  try {
    window.dispatchEvent(new Event(OPEN_BMAIL_EVENT));
  } catch {
    /* no window */
  }
};
