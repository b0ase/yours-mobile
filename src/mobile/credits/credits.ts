/**
 * bCredits: prepaid credit for using b, the bWalletX agent. Issuer: The Bitcoin Corporation Ltd.
 * Pure state and maths for the Wallet › Credits card, Top up and history. Never written "$b" ($b means Bitcoin).
 *
 * Rules (owner, 14 Oct 2026; server: bit-sign src/lib/credits.ts):
 *   - 1 bCredit = 1p (the server's pencePerCredit). Bought with BSV at the BSV/GBP rate at top-up.
 *   - A balance in bCorp's off-chain ledger. Not a token: can't be sent, traded or cashed out.
 *   - Spent only on b: each reply costs ceil(cost × 1.35 ÷ credit price). Never runs into debt.
 *   - Top-ups are capped at £20 (topupCapPence). No expiry. Non-refundable except where the law requires.
 *
 * Top up: the wallet sends BSV to the treasury P2PKH address with ONE extra output,
 *   OP_FALSE OP_RETURN <depositReference utf8>
 * (the server checks the output script starts 006a and contains the reference's hex), then posts the txid
 * to POST /api/bitsign/credits/deposit. The server needs one confirmation, so the first answer is usually
 * "pending"; the card retries until it is credited.
 */

export const CREDITS_NAME = 'bCredits';

/** The plain-words terms shown at top-up when the server sends none. Matches bit-sign creditsTerms(). */
export const CREDITS_TERMS_FALLBACK = [
  'bCredits pay for using b, the bWalletX agent. Nothing else.',
  '1 bCredit = 1p. You pay in BSV at the rate when you top up.',
  'b charges what each reply costs to run, plus 35%.',
  'Top-ups are up to £20 each.',
  "bCredits don't expire. They can't be cashed out, sent to anyone or spent anywhere else.",
  "They're non-refundable except where the law requires.",
  'Top-ups pay for b. Keep it small.',
].join(' ');

export interface CreditsInfo {
  enabled: boolean;
  treasury: string | null;
  pencePerCredit: number;
  topupCapPence: number;
  markup: number;
  /** This account's top-up reference ("bcredits:<24 hex>"), carried in the OP_RETURN. */
  depositReference: string | null;
  terms: string;
  balance: number;
  /** The server answers b replies paid from bCredits (POST /api/bitsign/agent/turn {pay:'bcredits'}). */
  agentTurn: boolean;
}

export interface CreditEntry {
  id: string;
  kind: 'deposit' | 'debit';
  app: string | null;
  action: string | null;
  units: number;
  txid: string | null;
  balanceAfter: number;
  createdAt: string;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const pos = (v: unknown, dflt: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : dflt;

const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const REFERENCE_RE = /^bcredits:[0-9a-f]{24}$/;

export const isTreasuryAddress = (a: unknown): a is string => typeof a === 'string' && ADDRESS_RE.test(a);
export const isDepositReference = (r: unknown): r is string => typeof r === 'string' && REFERENCE_RE.test(r);

/** The hard top-up cap in the wallet, whatever the server says: £20. */
export const MAX_TOP_UP_PENCE = 2000;
/** Smallest top-up offered: 10p. Anything under 1 bCredit would be refused by the server and lost. */
export const MIN_TOP_UP_PENCE = 10;
/** Presets in pence: 10p (a test), £1, £5, £20. */
export const TOP_UP_PRESETS_PENCE = [10, 100, 500, 2000] as const;

/** GET /api/bitsign/credits → CreditsInfo. Anything malformed reads as "coming soon". */
export function parseCreditsInfo(data: unknown): CreditsInfo {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const treasury = isTreasuryAddress(o.treasury) ? o.treasury : null;
  const depositReference = isDepositReference(o.depositReference) ? o.depositReference : null;
  return {
    enabled: o.enabled === true && !!treasury && !!depositReference,
    treasury,
    pencePerCredit: pos(o.pencePerCredit, 1, 10_000),
    // Never above £20 whatever the server says: "Keep it small".
    topupCapPence: Math.min(pos(o.topupCapPence, MAX_TOP_UP_PENCE, 1_000_000), MAX_TOP_UP_PENCE),
    markup: pos(o.markup, 1.35, 10),
    depositReference,
    terms: str(o.terms) ?? CREDITS_TERMS_FALLBACK,
    balance: int(o.balance) ?? 0,
    agentTurn: o.agentTurn === true,
  };
}

export function parseLedger(data: unknown): CreditEntry[] {
  const rows = (data && typeof data === 'object' ? (data as { entries?: unknown }).entries : null) ?? [];
  if (!Array.isArray(rows)) return [];
  const out: CreditEntry[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || (r.kind !== 'deposit' && r.kind !== 'debit')) continue;
    const units = int(r.units);
    if (!units) continue;
    out.push({
      id: String(r.id ?? out.length),
      kind: r.kind,
      app: str(r.app),
      action: str(r.action),
      units,
      txid: str(r.txid),
      balanceAfter: int(r.balanceAfter) ?? 0,
      createdAt: str(r.createdAt) ?? '',
    });
  }
  return out;
}

/** "1 bCredit", "1,250 bCredits". */
export const fmtCredits = (n: number) => {
  const v = Math.max(0, Math.floor(n));
  return `${v.toLocaleString('en-US')} ${v === 1 ? 'bCredit' : 'bCredits'}`;
};

/** "40p" / "£1" / "£12.50" for a number of pence. */
export const fmtPence = (pence: number) =>
  pence < 100 ? `${Math.round(pence)}p` : `£${(pence / 100).toFixed(pence % 100 ? 2 : 0)}`;

export const entryLabel = (e: CreditEntry) =>
  e.kind === 'deposit' ? 'Top up' : e.app === 'b' ? 'b reply' : [e.app, e.action].filter(Boolean).join(' · ') || 'Used';

export const entryAmount = (e: CreditEntry) => `${e.kind === 'deposit' ? '+' : '−'}${e.units.toLocaleString('en-US')}`;

/** Spent so far: the sum of debits in the history given. */
export const spentSoFar = (rows: CreditEntry[]) => rows.reduce((n, r) => n + (r.kind === 'debit' ? r.units : 0), 0);

// ── Amount → sats ──

export const SATS_PER_BSV = 100_000_000;

/** Sats worth `pence` at `gbpPerBsv`, rounded DOWN so a top-up never goes over the amount (or the cap). */
export function penceToSats(pence: number, gbpPerBsv: number): number | null {
  if (!(Number.isFinite(pence) && pence > 0) || !(Number.isFinite(gbpPerBsv) && gbpPerBsv > 0)) return null;
  return Math.floor((pence / 100 / gbpPerBsv) * SATS_PER_BSV);
}

/** Pence a payment of `sats` is worth at `gbpPerBsv` (same as the server's satsToPence). */
export const satsToPence = (sats: number, gbpPerBsv: number) => (sats * gbpPerBsv * 100) / SATS_PER_BSV;

/** Whole bCredits `pence` buys (dust under one credit is not credited). */
export const creditsForPence = (pence: number, pencePerCredit: number) =>
  pence > 0 && pencePerCredit > 0 ? Math.floor(pence / pencePerCredit + 1e-9) : 0;

export type TopUpPlan = { pence: number; sats: number; credits: number };

/**
 * The top-up for `pence` at `gbpPerBsv`, or the reason it can't be sent. Enforces the cap (the server's, never
 * above £20) and the minimum; sats are rounded down so the value never exceeds the amount chosen.
 */
export function planTopUp(
  info: Pick<CreditsInfo, 'enabled' | 'treasury' | 'depositReference' | 'topupCapPence' | 'pencePerCredit'>,
  pence: number,
  gbpPerBsv: number,
): { ok: true; plan: TopUpPlan } | { ok: false; error: string } {
  if (!info.enabled || !info.treasury || !info.depositReference)
    return { ok: false, error: 'bCredits are coming soon' };
  if (!Number.isFinite(pence) || pence <= 0) return { ok: false, error: 'Choose an amount' };
  const cap = Math.min(info.topupCapPence, MAX_TOP_UP_PENCE);
  if (pence > cap) return { ok: false, error: `Top-ups are up to ${fmtPence(cap)} each` };
  if (pence < MIN_TOP_UP_PENCE) return { ok: false, error: `The smallest top-up is ${fmtPence(MIN_TOP_UP_PENCE)}` };
  const sats = penceToSats(pence, gbpPerBsv);
  if (sats === null) return { ok: false, error: "The BSV price isn't available. Try again in a minute." };
  const credits = creditsForPence(satsToPence(sats, gbpPerBsv), info.pencePerCredit);
  if (credits < 1) return { ok: false, error: 'That is less than one bCredit' };
  return { ok: true, plan: { pence, sats, credits } };
}

/** Parse the "Other amount" box in pounds ("2.50", "£3"). Returns pence or null. */
export function parsePounds(input: string): number | null {
  const t = input.trim().replace(/^£/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const p = Math.round(Number(t) * 100);
  return p > 0 ? p : null;
}

// ── The deposit outputs ──

const hexOf = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

/** OP_FALSE OP_RETURN <reference>: the output that binds the payment to this account. */
export function depositScriptHex(reference: string): string {
  if (!isDepositReference(reference)) throw new Error('Bad top-up reference from the server');
  const data = hexOf(reference);
  const len = data.length / 2; // 33 bytes: one direct push (≤ 75)
  return `006a${len.toString(16).padStart(2, '0')}${data}`;
}

/** The sendBsv requests for a top-up: sats to the treasury, plus the 0-sat reference output. */
export function depositRequests(treasury: string, reference: string, sats: number) {
  if (!isTreasuryAddress(treasury)) throw new Error('Bad bCredits address from the server');
  if (!Number.isSafeInteger(sats) || sats < 1) throw new Error('Bad top-up amount');
  return [
    { address: treasury, satoshis: sats },
    { script: depositScriptHex(reference), satoshis: 0 },
  ];
}

// ── Top-ups sent but not yet credited (the server waits for one confirmation) ──

export type Pending = { txid: string; credits: number; at: number }[];

export const addPending = (p: Pending, txid: string, credits: number, now = Date.now()): Pending =>
  p.some((x) => x.txid === txid) ? p : [...p, { txid, credits, at: now }];

export const removePending = (p: Pending, txid: string): Pending => p.filter((x) => x.txid !== txid);

/** Drop pending entries older than a week; they'll never be credited and just clutter the card. */
export const prunePending = (p: Pending, now = Date.now()) => p.filter((x) => now - x.at < 7 * 86_400_000);

export type DepositOutcome = 'credited' | 'pending' | 'failed';

/** POST deposit response → outcome. 202 / {pending:true} means retry later. */
export function depositOutcome(status: number, body: unknown): DepositOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as { pending?: unknown; balance?: unknown };
  if (status === 202 || b.pending === true) return 'pending';
  if (status >= 200 && status < 300 && typeof b.balance === 'number') return 'credited';
  return 'failed';
}

const PENDING_KEY = 'bwallet.credits.pending';
export const loadPending = (): Pending => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? prunePending(v.filter((x) => x && typeof x.txid === 'string')) : [];
  } catch {
    return [];
  }
};
export const savePending = (p: Pending) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
};

// ── Live updates: Ask b tells the card the balance changed ──

const EVENT = 'bwx:bcredits';
export const emitCreditsChanged = (balance?: number) => {
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: balance }));
  } catch {
    /* no window (tests) */
  }
};
export const onCreditsChanged = (cb: (balance?: number) => void) => {
  const h = (e: Event) => cb((e as CustomEvent<number | undefined>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
};

// ── Stop: the person switches b off bCredits on this device ──

const STOP_KEY = 'bwallet.credits.stopped';
export const creditsStopped = () => {
  try {
    return localStorage.getItem(STOP_KEY) === '1';
  } catch {
    return false;
  }
};
export const setCreditsStopped = (stopped: boolean) => {
  try {
    if (stopped) localStorage.setItem(STOP_KEY, '1');
    else localStorage.removeItem(STOP_KEY);
  } catch {
    /* storage unavailable */
  }
  emitCreditsChanged();
};

// ── b replies paid from bCredits ──

/** Can b answer from bCredits right now? Never runs into debt: a zero balance asks for a top-up first. */
export const canAskFromCredits = (info: Pick<CreditsInfo, 'enabled' | 'agentTurn' | 'balance'>) =>
  info.enabled && info.agentTurn && info.balance > 0 && !creditsStopped();

/** What b says when the balance is too low for a reply. */
export const lowBalanceText = (balance: number) =>
  `${balance > 0 ? `You have ${fmtCredits(balance)}, not enough for this reply.` : "You're out of bCredits."} Top up to keep talking to me. Top-ups pay for b. Keep it small.`;
