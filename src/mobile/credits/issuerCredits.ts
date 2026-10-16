/**
 * Credits from other issuers (roadmap "Credits from other issuers", site /credits; owner design 14 Oct 2026, memory
 * issuer-credits). Pure state and maths; the screens are IssuerCreditCards.tsx, the send is issuerTopUp.ts.
 *
 * Server: bit-sign PR #294 (NOT live yet, needs a migration), base /api/bitsign/credits, errors {error, code}.
 *   GET  /issuers                         → { issuers: Issuer[] }
 *   GET  /issuers/{id}/balance            → { balance }               (signed in)
 *   POST /issuers/{id}/topup/quote        { asset, credits } → { quote_id, outputs[], memo_hex, expires_at }
 *   POST /issuers/{id}/topup/claim        { quote_id, txid, rawtx? } → { credited, balance }
 *                                         202 / code not_indexed: retry with backoff.
 *
 * The built-in issuer "bcredits" keeps its own card and /credits/deposit flow (credits.ts), so it is skipped here.
 * MNEE top-ups are hidden for now: MNEE's cosigner may refuse a transaction carrying the memo output.
 *
 * A quote is paid in ONE transaction: every output it lists (P2PKH sats or BSV-21 token amounts), plus
 * OP_FALSE OP_RETURN <memo>. The wallet checks the quote before it ever shows the approval sheet: known output
 * kinds only, real addresses, the token id the issuer accepts, a total no higher than the issuer's listed price,
 * a memo of sane size and a quote that has not expired.
 */

import { P2PKH } from '@bsv/sdk';

export const BUILTIN_ISSUER_ID = 'bcredits';

export type CreditAsset = 'BSV' | 'MNEE' | 'PNEE';
/** Assets the wallet offers for top-ups today. MNEE is hidden (cosigner vs memo output, open risk). */
export const TOPUP_ASSETS: readonly CreditAsset[] = ['BSV', 'PNEE'];

export interface IssuerAccept {
  asset: CreditAsset;
  decimals: number;
  /** BSV-21 token id (txid_vout) for a token asset; null for BSV. */
  tokenId: string | null;
  /** Price of one credit in the asset's atomic units (sats, PNEE atoms). */
  priceAtomic: bigint;
  /** The server's display price per credit, in whole asset units (e.g. "0.00001"). */
  pricePerCredit: string;
}

export interface Issuer {
  id: string;
  name: string;
  handle: string | null;
  builtin: boolean;
  payeeAddress: string | null;
  accepts: IssuerAccept[];
  topupEnabled: boolean;
  /** Plain-words terms, when the issuer sends any. */
  terms: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const TOKEN_ID_RE = /^[0-9a-f]{64}[._]\d+$/i;
const ISSUER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ASSETS = new Set<CreditAsset>(['BSV', 'MNEE', 'PNEE']);

export const isAddress = (a: unknown): a is string => typeof a === 'string' && ADDRESS_RE.test(a);
export const normTokenId = (id: string) => id.replace('.', '_').toLowerCase();

/** A non-negative integer from a number or a decimal string, as bigint; null otherwise. */
export const atomic = (v: unknown): bigint | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,30}$/.test(v)) return BigInt(v);
  return null;
};

function parseAccept(a: unknown): IssuerAccept | null {
  const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  const asset = typeof o.asset === 'string' ? (o.asset.toUpperCase() as CreditAsset) : null;
  if (!asset || !ASSETS.has(asset)) return null;
  const priceAtomic = atomic(o.price_atomic);
  if (priceAtomic === null || priceAtomic <= 0n) return null;
  const tokenId = str(o.token_id);
  if (asset !== 'BSV' && (!tokenId || !TOKEN_ID_RE.test(tokenId))) return null;
  const decimals =
    typeof o.decimals === 'number' && Number.isInteger(o.decimals) ? o.decimals : asset === 'BSV' ? 8 : 0;
  if (decimals < 0 || decimals > 18) return null;
  const ppc = o.price_per_credit;
  return {
    asset,
    decimals,
    tokenId: asset === 'BSV' ? null : tokenId,
    priceAtomic,
    pricePerCredit: typeof ppc === 'number' || typeof ppc === 'string' ? String(ppc) : fmtAtomic(priceAtomic, decimals),
  };
}

/** GET /issuers → the issuers that get their own card (the built-in bCredits is excluded). Malformed rows drop. */
export function parseIssuers(data: unknown): Issuer[] {
  const rows = (data && typeof data === 'object' ? (data as { issuers?: unknown }).issuers : null) ?? [];
  if (!Array.isArray(rows)) return [];
  const out: Issuer[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !ISSUER_ID_RE.test(id) || !name) continue;
    if (r.builtin === true || id === BUILTIN_ISSUER_ID) continue;
    if (out.some((i) => i.id === id)) continue;
    const accepts = (Array.isArray(r.accepts) ? r.accepts : []).map(parseAccept).filter((a): a is IssuerAccept => !!a);
    out.push({
      id,
      name: name.slice(0, 60),
      handle: str(r.handle)?.replace(/^[@$]/, '').slice(0, 40) ?? null,
      builtin: false,
      payeeAddress: isAddress(r.payee_address) ? r.payee_address : null,
      accepts,
      topupEnabled: r.topup_enabled === true,
      terms: str(r.terms)?.slice(0, 2000) ?? null,
    });
  }
  return out;
}

/** The ways this wallet can top up an issuer today (BSV, PNEE; never MNEE for now). */
export const topUpAccepts = (i: Issuer): IssuerAccept[] =>
  i.topupEnabled ? i.accepts.filter((a) => TOPUP_ASSETS.includes(a.asset)) : [];

export const parseBalance = (data: unknown): number | null => {
  const b = data && typeof data === 'object' ? (data as { balance?: unknown }).balance : null;
  return typeof b === 'number' && Number.isFinite(b) && b >= 0 ? Math.floor(b) : null;
};

// ── Formatting ──

/** "0.00012345" for atomic units at `decimals`, trailing zeros trimmed. */
export function fmtAtomic(v: bigint, decimals: number): string {
  if (decimals <= 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** "1 credit", "1,250 credits". */
export const fmtIssuerCredits = (n: number) => {
  const v = Math.max(0, Math.floor(n));
  return `${v.toLocaleString('en-US')} ${v === 1 ? 'credit' : 'credits'}`;
};

/** "1 credit = 0.00001 BSV" from the issuer's listed price. */
export const rateLine = (a: IssuerAccept) => `1 credit = ${a.pricePerCredit} ${a.asset === 'PNEE' ? 'PNEEs' : a.asset}`;

/** Set top-up amounts, in credits, per card. */
export const ISSUER_TOPUP_PRESETS = [100, 500, 1000, 5000] as const;
/** Hard cap on one top-up, whatever an issuer allows: keep it small. */
export const MAX_ISSUER_TOPUP_CREDITS = 100_000;

// ── Quotes ──

export type QuoteOutput =
  | { kind: 'p2pkh'; address: string; satoshis: number }
  | { kind: 'bsv21'; tokenId: string; address: string; amountAtomic: bigint };

export interface Quote {
  quoteId: string;
  outputs: QuoteOutput[];
  memoHex: string;
  expiresAt: number;
}

/** Most memo bytes we will put on chain (one OP_RETURN push). */
export const MAX_MEMO_BYTES = 220;
/** Sats a PNEE quote may also ask for in P2PKH outputs (e.g. a fee), at most. */
export const MAX_SIDE_SATS = 10_000;
/** A quote's asset total may exceed credits × price by this fraction at most (rounding on the server). */
export const PRICE_TOLERANCE = 0.01;

export class QuoteError extends Error {}

/** POST /topup/quote → a checked Quote, or throws QuoteError with a plain message. */
export function parseQuote(
  data: unknown,
  ctx: { asset: CreditAsset; accept: IssuerAccept; credits: number },
  now = Date.now(),
): Quote {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const quoteId = str(o.quote_id);
  if (!quoteId || quoteId.length > 128) throw new QuoteError('The issuer sent a bad quote.');
  const memoHex = typeof o.memo_hex === 'string' ? o.memo_hex.toLowerCase() : '';
  if (!/^([0-9a-f]{2})+$/.test(memoHex) || memoHex.length / 2 > MAX_MEMO_BYTES)
    throw new QuoteError('The issuer sent a bad payment reference.');
  const expiresAt = typeof o.expires_at === 'number' ? o.expires_at : Date.parse(String(o.expires_at ?? ''));
  if (!Number.isFinite(expiresAt)) throw new QuoteError('The issuer sent a bad quote.');
  // Seconds or milliseconds.
  const exp = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  if (exp <= now) throw new QuoteError('That quote has expired. Try again.');
  const raw = Array.isArray(o.outputs) ? o.outputs : [];
  if (!raw.length || raw.length > 10) throw new QuoteError('The issuer sent a bad quote.');
  const outputs: QuoteOutput[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const kind = r?.type ?? r?.kind ?? (r?.token_id ? 'bsv21' : 'p2pkh');
    if (!isAddress(r?.address)) throw new QuoteError('The quote pays an address the wallet does not recognise.');
    if (kind === 'p2pkh') {
      const sats = r.satoshis;
      if (typeof sats !== 'number' || !Number.isSafeInteger(sats) || sats < 1)
        throw new QuoteError('The issuer sent a bad amount.');
      outputs.push({ kind: 'p2pkh', address: r.address, satoshis: sats });
    } else if (kind === 'bsv21') {
      const tokenId = str(r.token_id);
      const amountAtomic = atomic(r.amount_atomic);
      if (!tokenId || !TOKEN_ID_RE.test(tokenId) || amountAtomic === null || amountAtomic <= 0n)
        throw new QuoteError('The issuer sent a bad token amount.');
      outputs.push({ kind: 'bsv21', tokenId: normTokenId(tokenId), address: r.address, amountAtomic });
    } else {
      throw new QuoteError('The quote asks for a kind of payment the wallet does not make.');
    }
  }
  checkQuoteTotals(outputs, ctx);
  return { quoteId, outputs, memoHex, expiresAt: exp };
}

/** The most the asset outputs may add up to: credits × price, plus the rounding tolerance. */
export const maxAssetTotal = (accept: IssuerAccept, credits: number): bigint => {
  const base = accept.priceAtomic * BigInt(credits);
  return base + (base * BigInt(Math.round(PRICE_TOLERANCE * 10_000))) / 10_000n;
};

function checkQuoteTotals(outputs: QuoteOutput[], ctx: { asset: CreditAsset; accept: IssuerAccept; credits: number }) {
  const { asset, accept, credits } = ctx;
  if (!Number.isSafeInteger(credits) || credits < 1) throw new QuoteError('Choose an amount.');
  const cap = maxAssetTotal(accept, credits);
  const sats = outputs.reduce((n, o) => n + (o.kind === 'p2pkh' ? BigInt(o.satoshis) : 0n), 0n);
  const tokens = outputs.filter((o): o is Extract<QuoteOutput, { kind: 'bsv21' }> => o.kind === 'bsv21');
  if (asset === 'BSV') {
    if (tokens.length) throw new QuoteError('A BSV top-up quote asked for tokens.');
    if (sats > cap) throw new QuoteError('The quote asks for more than the issuer’s listed price.');
    return;
  }
  if (!tokens.length) throw new QuoteError('The quote has no token payment.');
  const want = normTokenId(accept.tokenId ?? '');
  if (tokens.some((t) => t.tokenId !== want)) throw new QuoteError('The quote asks for a different token.');
  const total = tokens.reduce((n, t) => n + t.amountAtomic, 0n);
  if (total > cap) throw new QuoteError('The quote asks for more than the issuer’s listed price.');
  if (sats > BigInt(MAX_SIDE_SATS)) throw new QuoteError('The quote asks for too much BSV on the side.');
}

/** What the approval sheet shows: each output in words and the totals. */
export function quoteSummary(q: Quote, accept: IssuerAccept) {
  const unit = accept.asset === 'PNEE' ? 'PNEEs' : accept.asset;
  const lines = q.outputs.map((o) =>
    o.kind === 'p2pkh'
      ? { address: o.address, amount: `${o.satoshis.toLocaleString('en-US')} sats` }
      : { address: o.address, amount: `${fmtAtomic(o.amountAtomic, accept.decimals)} ${unit}` },
  );
  const sats = q.outputs.reduce((n, o) => n + (o.kind === 'p2pkh' ? o.satoshis : 0), 0);
  const tokens = q.outputs.reduce((n, o) => n + (o.kind === 'bsv21' ? o.amountAtomic : 0n), 0n);
  const parts: string[] = [];
  if (tokens > 0n) parts.push(`${fmtAtomic(tokens, accept.decimals)} ${unit}`);
  if (sats > 0) parts.push(`${sats.toLocaleString('en-US')} sats`);
  return { lines, sats, tokens, total: parts.join(' + ') };
}

// ── The memo output ──

/** OP_FALSE OP_RETURN <memo>: the output that binds the payment to the quote. */
export function memoScriptHex(memoHex: string): string {
  if (!/^([0-9a-f]{2})+$/i.test(memoHex)) throw new Error('Bad payment reference');
  const len = memoHex.length / 2;
  if (len > MAX_MEMO_BYTES) throw new Error('Payment reference too long');
  const push = len <= 75 ? len.toString(16).padStart(2, '0') : `4c${len.toString(16).padStart(2, '0')}`;
  return `006a${push}${memoHex.toLowerCase()}`;
}

// ── The spend: what the wallet is asked to build ──

export type BsvSpend = {
  kind: 'bsv';
  /** sendBsv requests: every P2PKH output, then the 0-sat memo. */
  requests: ({ address: string; satoshis: number } | { script: string; satoshis: 0 })[];
};
export type TokenSpend = {
  kind: 'bsv21';
  tokenId: string;
  /** sendBsv21 recipients: every token output, in quote order. */
  recipients: { amount: bigint; destination: { address: string } }[];
  /** Appended to sendBsv21's createAction: the quote's P2PKH outputs (as scripts), then the memo. */
  extraOutputs: { lockingScript: string; satoshis: number; outputDescription: string }[];
};

/** P2PKH locking script hex for an address (the SDK checks the base58 checksum). */
export function p2pkhScriptHex(address: string): string {
  if (!isAddress(address)) throw new Error('Bad address');
  return new P2PKH().lock(address).toHex();
}

export function buildSpend(q: Quote, accept: IssuerAccept): BsvSpend | TokenSpend {
  const memo = memoScriptHex(q.memoHex);
  if (accept.asset === 'BSV') {
    const requests: BsvSpend['requests'] = [];
    for (const o of q.outputs) {
      if (o.kind !== 'p2pkh') throw new Error('A BSV top-up cannot pay tokens');
      requests.push({ address: o.address, satoshis: o.satoshis });
    }
    requests.push({ script: memo, satoshis: 0 });
    return { kind: 'bsv', requests };
  }
  const tokenId = normTokenId(accept.tokenId ?? '');
  const recipients: TokenSpend['recipients'] = [];
  const extraOutputs: TokenSpend['extraOutputs'] = [];
  for (const o of q.outputs) {
    if (o.kind === 'bsv21') recipients.push({ amount: o.amountAtomic, destination: { address: o.address } });
    else
      extraOutputs.push({
        lockingScript: p2pkhScriptHex(o.address),
        satoshis: o.satoshis,
        outputDescription: 'Credits top-up',
      });
  }
  extraOutputs.push({ lockingScript: memo, satoshis: 0, outputDescription: 'Credits top-up reference' });
  return { kind: 'bsv21', tokenId, recipients, extraOutputs };
}

/**
 * A wallet whose next createAction gets `outputs` appended, once (sendBsv21 has no extra-outputs option and
 * builds with randomizeOutputs: false, so the token outputs keep their indexes and ours sit last).
 */
export const withExtraOutputs = <W extends object>(
  wallet: W,
  outputs: readonly { lockingScript: string; satoshis: number; outputDescription: string }[],
): W => {
  let used = false;
  return new Proxy(wallet, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'createAction') return (v as (...a: unknown[]) => unknown).bind(target);
      return (args: { outputs?: unknown[] }, ...rest: unknown[]) => {
        const next = used ? args : { ...args, outputs: [...(args.outputs ?? []), ...outputs] };
        used = true;
        return (v as (...a: unknown[]) => unknown).call(target, next, ...rest);
      };
    },
  });
};

/**
 * The outputs a PNEE top-up may carry beyond the quote: 1-sat token outputs (transfers, change), our extra
 * outputs exactly, and at most one indexer fee paid to `fee.feeScript`, no more than `fee.maxSats`. Anything else
 * stops the send.
 */
export function tokenSpendProblem(
  outputs: readonly { lockingScript: string; satoshis: number }[],
  extra: readonly { lockingScript: string; satoshis: number }[],
  fee: { feeScript: string; maxSats: number } | null,
): string | null {
  const want = extra.map((e) => `${e.lockingScript}:${e.satoshis}`);
  let feeSeen = false;
  for (const o of outputs) {
    const key = `${o.lockingScript}:${o.satoshis}`;
    const i = want.indexOf(key);
    if (i >= 0) {
      want.splice(i, 1);
      continue;
    }
    if (o.satoshis <= 1) continue;
    if (feeSeen || !fee || o.lockingScript !== fee.feeScript || o.satoshis > fee.maxSats)
      return 'This top-up pays someone you did not confirm.';
    feeSeen = true;
  }
  return want.length ? 'This top-up is missing an output from the quote.' : null;
}

// ── Claim ──

export type ClaimOutcome =
  | { kind: 'credited'; balance: number | null }
  | { kind: 'retry' }
  | { kind: 'failed'; message: string };

/** Plain words for the server's refusals. */
export function claimErrorText(status: number, code: string | null, fallback?: string | null): string {
  switch (code) {
    case 'quote_expired':
      return 'The quote expired before the payment arrived. Contact the issuer with the transaction id.';
    case 'already_claimed':
      return 'This top-up has already been credited.';
    case 'underpaid':
    case 'insufficient_payment':
      return "The payment didn't cover the quote. Contact the issuer with the transaction id.";
    case 'memo_mismatch':
      return "The payment reference didn't match. Contact the issuer with the transaction id.";
  }
  if (status === 402) return "The payment didn't cover the quote. Contact the issuer with the transaction id.";
  if (status === 409) return 'This top-up was already claimed, or the quote was used for another payment.';
  if (status === 422) return "The issuer couldn't check this payment. Contact the issuer with the transaction id.";
  if (status === 401) return 'Sign in again to finish this top-up.';
  return fallback || 'The issuer could not credit this top-up yet.';
}

/** A claim response (status, body) → what to do next. */
export function claimOutcome(status: number, body: unknown): ClaimOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code : null;
  if (status === 202 || code === 'not_indexed' || b.pending === true) return { kind: 'retry' };
  if (status >= 500 || status === 0) return { kind: 'retry' };
  if (status >= 200 && status < 300) return { kind: 'credited', balance: parseBalance(b) };
  return { kind: 'failed', message: claimErrorText(status, code, typeof b.error === 'string' ? b.error : null) };
}

/** Backoff between claim attempts: 2s, 4s, 8s, 16s, then 30s; null once `attempt` reaches `max`. */
export const claimDelayMs = (attempt: number, max = 8): number | null =>
  attempt >= max ? null : Math.min(30_000, 2000 * 2 ** attempt);

/**
 * Claim until credited, refused, or out of attempts (then the claim stays pending and the card retries later).
 * `post` returns the response status and body; a thrown network error counts as "retry".
 */
export async function claimWithRetry(
  post: () => Promise<{ status: number; body: unknown }>,
  opts: { sleep?: (ms: number) => Promise<void>; max?: number } = {},
): Promise<ClaimOutcome | { kind: 'pending' }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let out: ClaimOutcome;
    try {
      const r = await post();
      out = claimOutcome(r.status, r.body);
    } catch {
      out = { kind: 'retry' };
    }
    if (out.kind !== 'retry') return out;
    const wait = claimDelayMs(attempt, opts.max);
    if (wait === null) return { kind: 'pending' };
    await sleep(wait);
  }
}

// ── Claims sent but not yet credited (kept on this device, retried when the card shows) ──

export type PendingClaim = {
  issuerId: string;
  quoteId: string;
  txid: string;
  rawtx?: string;
  credits: number;
  at: number;
};

export const prunePendingClaims = (p: PendingClaim[], now = Date.now()) => p.filter((x) => now - x.at < 7 * 86_400_000);

const PENDING_KEY = 'bwallet.issuerCredits.pending';
export const loadPendingClaims = (): PendingClaim[] => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v)
      ? prunePendingClaims(v.filter((x) => x && typeof x.txid === 'string' && typeof x.issuerId === 'string'))
      : [];
  } catch {
    return [];
  }
};
export const savePendingClaims = (p: PendingClaim[]) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
};

// ── Stop + spent so far, per issuer, on this device ──

const STOP_KEY = 'bwallet.issuerCredits.stopped';
const SPENT_KEY = 'bwallet.issuerCredits.spent';
const readJson = <T>(k: string, d: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    return v && typeof v === 'object' ? (v as T) : d;
  } catch {
    return d;
  }
};
const writeJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** Has the person stopped this issuer's credits being spent from this device? */
export const issuerStopped = (id: string) => readJson<Record<string, boolean>>(STOP_KEY, {})[id] === true;
export const setIssuerStopped = (id: string, stopped: boolean) => {
  const m = readJson<Record<string, boolean>>(STOP_KEY, {});
  if (stopped) m[id] = true;
  else delete m[id];
  writeJson(STOP_KEY, m);
};

export const spentFor = (id: string) => {
  const v = readJson<Record<string, number>>(SPENT_KEY, {})[id];
  return typeof v === 'number' && v > 0 ? v : 0;
};

/** Spent so far grows by every fall in the balance this device has seen (top-ups only raise it). */
export const nextSpent = (spent: number, prev: number | null, next: number) =>
  prev !== null && next < prev ? spent + (prev - next) : spent;

export const recordBalance = (id: string, prev: number | null, next: number) => {
  const m = readJson<Record<string, number>>(SPENT_KEY, {});
  const s = nextSpent(m[id] ?? 0, prev, next);
  if (s !== (m[id] ?? 0)) {
    m[id] = s;
    writeJson(SPENT_KEY, m);
  }
  return s;
};

/** The tick-down: the balance shown `t` (0..1) of the way from `from` to `to`, whole credits. */
export const tickValue = (from: number, to: number, t: number) =>
  Math.round(from + (to - from) * Math.min(1, Math.max(0, t)));
