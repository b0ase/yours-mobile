/**
 * Tips everywhere (owner, 12 Oct 2026): one shared tip for every surface (bMusic artists, NFT creators, chat,
 * Friends, Spaces). PURE: no wallet, no network, no React. The sheet (TipSheet.tsx) does the sending.
 *
 * Route, in order:
 *   1. identity key → BRC-29 payment to that key, delivered through bMail's message box (bmail/client.ts), so the
 *      recipient's wallet internalizes it and the note travels with it;
 *   2. paymail / $handle / OpNS name → resolveRecipient + sendBsv (BRC-169 handle first, else paymail P2P);
 *   3. address → sendBsv to the address.
 * The amount goes 100% to the recipient: no bCorp fee, no extra outputs.
 */
import { fiatToUsd, formatFiat, type Fx } from '../../utils/displayCurrency';
import { usdToSats } from '../money/money';
import { TIP_MAX_SATS, TIP_MIN_SATS } from '../feed/tip';

export { TIP_MAX_SATS, TIP_MIN_SATS };

/** Presets in the display currency's units: 10p / 50p / £1 / £5 (10¢ / 50¢ / $1 / $5 in US dollars). */
export const TIP_PRESETS = [0.1, 0.5, 1, 5] as const;
/** Sats fallbacks for the presets when the BSV price is unknown. */
export const TIP_PRESETS_SATS_FALLBACK = [2_000, 10_000, 20_000, 100_000] as const;
export const TIP_NOTE_MAX = 140;

export type TipRecipient = {
  /** What to call them in the sheet and the toast ("$vexvoid", "Vex Void"). */
  name: string;
  /** Compressed identity public key (66 hex). Preferred: BRC-29. */
  identityKey?: string;
  /** Paymail, $handle or OpNS name. */
  paymail?: string;
  /** P2PKH address, the last resort. */
  address?: string;
};

/** Where a tip is from, so the bMusic stats job can count tips to artists (docs/TIPS.md). */
export type TipContext =
  | { kind: 'artist'; artist: string; album?: string; track?: string }
  | { kind: 'nft'; outpoint: string }
  | { kind: 'post'; txid: string }
  | { kind: 'room'; room: string; message?: string }
  | { kind: 'person' }
  | { kind: 'space'; space: string };

export type Me = { identityKey?: string; address?: string; names: string[] };

export type TipRoute =
  | { kind: 'identity'; to: string }
  | { kind: 'paymail'; to: string }
  | { kind: 'address'; to: string };

const KEY_RE = /^0[23][0-9a-f]{64}$/i;
const ADDR_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;

export const isIdentityKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k);

/** Lowercase, no leading "$" or "@", no default domain: "$VexVoid", "vexvoid@bwalletx.com" → "vexvoid". */
export const normName = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/^[$@]/, '')
    .replace(/@(bwalletx\.com|bwallet\.space)$/, '');

export const tipRoute = (r: TipRecipient): TipRoute | null => {
  if (isIdentityKey(r.identityKey)) return { kind: 'identity', to: r.identityKey.toLowerCase() };
  const p = r.paymail?.trim();
  if (p) return { kind: 'paymail', to: p };
  const a = r.address?.trim();
  if (a && ADDR_RE.test(a)) return { kind: 'address', to: a };
  return null;
};

/** Can't tip yourself: same identity key, same address, or one of my names. */
export const isSelf = (r: TipRecipient, me: Me): boolean => {
  if (r.identityKey && me.identityKey && r.identityKey.toLowerCase() === me.identityKey.toLowerCase()) return true;
  if (r.address && me.address && r.address === me.address) return true;
  const mine = new Set(me.names.filter(Boolean).map(normName));
  // A display name only counts when it is a $handle; plain names ("Vex Void") are not unique.
  const handles = [r.paymail, r.name?.trim().startsWith('$') ? r.name : undefined];
  return handles.some((n) => !!n && mine.has(normName(n)));
};

/** A preset (display units) in whole sats at `rate` USD/BSV, never under dust. null when the price is unknown. */
export const fiatToTipSats = (amount: number, fx: Fx, rate: number): number | null => {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const sats = usdToSats(fiatToUsd(amount, fx), rate);
  return sats === null ? null : Math.max(TIP_MIN_SATS, sats);
};

export const presetSats = (fx: Fx, rate: number): number[] =>
  TIP_PRESETS.map((p, i) => fiatToTipSats(p, fx, rate) ?? TIP_PRESETS_SATS_FALLBACK[i]);

/** "10p", "50p", "£1", "£5" / "10¢", "50¢", "$1", "$5". */
export const presetLabel = (amount: number, fx: Fx): string => {
  if (amount < 1) {
    const minor = Math.round(amount * 100);
    return fx.currency === 'GBP' ? `${minor}p` : `${minor}¢`;
  }
  return formatFiat(fiatToUsd(amount, fx), fx).replace(/\.00$/, '');
};

/** A typed amount in display units ("1.50", "£2"), at most 2 decimals, > 0; null if not valid. */
export const parseFiatInput = (s: string): number | null => {
  const t = s.trim().replace(/^[£$]/, '').replace(/,/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(t) || !/\d/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

export const tipAmountError = (sats: number | null): string | null => {
  if (sats === null || !Number.isSafeInteger(sats)) return 'Enter an amount.';
  if (sats < TIP_MIN_SATS) return 'That tip is too small to send.';
  if (sats > TIP_MAX_SATS) return 'That is more than one tip can send.';
  return null;
};

export const cleanNote = (s: string): string =>
  Array.from(s, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .trim()
    .slice(0, TIP_NOTE_MAX);

/**
 * Never send the same tip twice at once (services/repeatGuard.ts spirit, for in-app tips): a second Send for the
 * same recipient and amount while the first is still going out is refused. Never auto-retried.
 */
export class TipLock {
  private busy = new Set<string>();
  take(key: string): boolean {
    if (this.busy.has(key)) return false;
    this.busy.add(key);
    return true;
  }
  release(key: string) {
    this.busy.delete(key);
  }
}
export const tipLock = new TipLock();
export const tipKey = (route: TipRoute, sats: number) => `${route.kind}:${route.to}:${sats}`;

// ── record ─────────────────────────────────────────────────────────────────────

/**
 * The tip record (docs/TIPS.md): a `bwx:tip` window event plus a capped local log, for the bMusic stats job and
 * artist ranking to count later. Only sent tips are recorded.
 */
export type TipRecord = {
  v: 1;
  at: number;
  txid: string;
  sats: number;
  to: string;
  route: TipRoute['kind'];
  context: TipContext;
  /** true when the network was slow and the wallet queued it (it will keep trying by itself). */
  pending?: boolean;
};
export const TIP_EVENT = 'bwx:tip';
export const TIP_LOG_KEY = 'bwx.tips.log';
export const TIP_LOG_MAX = 200;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const readTipLog = (store: Store | undefined = safeStorage()): TipRecord[] => {
  try {
    const v = JSON.parse(store?.getItem(TIP_LOG_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as TipRecord[]) : [];
  } catch {
    return [];
  }
};

export const recordTip = (
  rec: TipRecord,
  store: Store | undefined = safeStorage(),
  target: Pick<EventTarget, 'dispatchEvent'> | undefined = typeof window === 'undefined' ? undefined : window,
) => {
  try {
    store?.setItem(TIP_LOG_KEY, JSON.stringify([rec, ...readTipLog(store)].slice(0, TIP_LOG_MAX)));
  } catch {
    /* storage full or blocked: the event still goes out */
  }
  try {
    target?.dispatchEvent(new CustomEvent(TIP_EVENT, { detail: rec }));
  } catch {
    /* no CustomEvent (tests) */
  }
};

function safeStorage(): Store | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The creator of an NFT, when its wallet tags say who (MAP `creator` / `paymail` / `artist`, or a `creatorKey`).
 * Unknown → null: no Tip button (never guess from the current holder, who may not be the creator).
 */
export const nftCreator = (tags: readonly string[] | undefined): TipRecipient | null => {
  const tag = (k: string) =>
    tags
      ?.find((t) => t.startsWith(`${k}:`))
      ?.slice(k.length + 1)
      .trim();
  const key = tag('creatorKey');
  if (isIdentityKey(key)) return { name: 'the creator', identityKey: key };
  for (const k of ['creatorPaymail', 'paymail', 'creator', 'artist']) {
    const v = tag(k);
    if (!v) continue;
    if (/^\$?[a-z0-9._+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) || /^\$[a-z0-9_.-]{1,50}$/i.test(v))
      return { name: v.startsWith('$') ? v : `$${v.split('@')[0]}`, paymail: v };
    if (ADDR_RE.test(v)) return { name: 'the creator', address: v };
  }
  return null;
};
