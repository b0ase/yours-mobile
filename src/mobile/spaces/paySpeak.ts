import { OP, P2PKH, Script, Utils } from '@bsv/sdk';

/**
 * Pay to speak in a Space (bit-sign PR #289: rooms/[ticker]/speak/{quote,claim}).
 *
 *   quote  GET  → { enabled, price_sats, outputs[{address,sats}], op_return, expires_at, quote_id } | { enabled:false, reason }
 *   pay    the wallet pays every output at least its sats, plus OP_FALSE OP_RETURN <utf8 op_return> (REQUIRED)
 *   claim  POST { quote_id, txid, rawtx } → { ok, txid, role:'speaker', livekit|null }
 *
 * A paid quote can be claimed for 24 h, so {quote_id, txid, rawtx} is kept on the device until the
 * claim succeeds (or is refused for good), and claimed again on the next visit: a crash after paying
 * never loses the seat.
 *
 * bWalletX only: never in a store build (docs/STORE-AUDIT.md, paid features off). Literal env check so
 * Vite drops the whole module there.
 */
export const PAY_TO_SPEAK_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

export interface SpeakQuote {
  enabled: true;
  priceSats: number;
  outputs: { address: string; sats: number }[];
  opReturn: string;
  expiresAt: string | null;
  quoteId: string;
}
export type SpeakQuoteResult = SpeakQuote | { enabled: false; reason: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** A quote is enabled only when every field needed to pay is present and sane: no fake prices. */
export function parseSpeakQuote(data: unknown): SpeakQuoteResult {
  const d = obj(data);
  if (d.enabled !== true) return { enabled: false, reason: typeof d.reason === 'string' ? d.reason : 'off' };
  const outputs = Array.isArray(d.outputs)
    ? d.outputs.map((o) => obj(o)).map((o) => ({ address: String(o.address ?? ''), sats: Number(o.sats) }))
    : [];
  const priceSats = Number(d.price_sats);
  const ok =
    typeof d.quote_id === 'string' &&
    d.quote_id &&
    typeof d.op_return === 'string' &&
    d.op_return &&
    Number.isSafeInteger(priceSats) &&
    priceSats > 0 &&
    outputs.length > 0 &&
    outputs.every((o) => o.address && Number.isSafeInteger(o.sats) && o.sats > 0);
  if (!ok) return { enabled: false, reason: 'bad quote' };
  return {
    enabled: true,
    priceSats,
    outputs,
    opReturn: d.op_return as string,
    expiresAt: typeof d.expires_at === 'string' ? d.expires_at : null,
    quoteId: d.quote_id as string,
  };
}

export interface SpeakOutput {
  lockingScript: string;
  satoshis: number;
  outputDescription: string;
}

/** OP_FALSE OP_RETURN <utf8 memo>. */
export const memoScript = (memo: string): Script =>
  new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN).writeBin(Utils.toArray(memo, 'utf8'));

/** createAction outputs: each payee at least its sats, then the required memo. */
export function speakOutputs(q: SpeakQuote): SpeakOutput[] {
  if (!q.opReturn) throw new Error('The quote has no memo');
  return [
    ...q.outputs.map((o) => ({
      lockingScript: new P2PKH().lock(o.address).toHex(),
      satoshis: o.sats,
      outputDescription: 'Pay to speak',
    })),
    { lockingScript: memoScript(q.opReturn).toHex(), satoshis: 0, outputDescription: 'Pay to speak memo' },
  ];
}

// ── the paid-but-unclaimed seat, kept on the device ──

export interface PendingSpeak {
  ticker: string;
  quoteId: string;
  txid: string;
  rawtx: string;
  paidAt: number;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
const key = (ticker: string) => `bw.paySpeak.${ticker.toUpperCase()}`;
const store = (): KV | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function savePending(p: PendingSpeak, kv: KV | null = store()): void {
  try {
    kv?.setItem(key(p.ticker), JSON.stringify(p));
  } catch {
    /* no storage */
  }
}

export function loadPending(ticker: string, now = Date.now(), kv: KV | null = store()): PendingSpeak | null {
  try {
    const p = JSON.parse(kv?.getItem(key(ticker)) ?? 'null') as PendingSpeak | null;
    if (!p || typeof p.txid !== 'string' || typeof p.rawtx !== 'string' || typeof p.quoteId !== 'string') return null;
    if (now - p.paidAt > CLAIM_WINDOW_MS) {
      kv?.removeItem(key(ticker));
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

export function clearPending(ticker: string, kv: KV | null = store()): void {
  try {
    kv?.removeItem(key(ticker));
  } catch {
    /* no storage */
  }
}

// ── claim ──

export interface LiveKitGrant {
  token: string;
  url: string;
  room?: string;
}
export interface SpeakClaim {
  ok: true;
  txid: string;
  livekit: LiveKitGrant | null;
}

export function parseSpeakClaim(data: unknown): SpeakClaim | null {
  const d = obj(data);
  if (d.ok !== true) return null;
  const lk = obj(d.livekit);
  return {
    ok: true,
    txid: String(d.txid ?? ''),
    livekit:
      typeof lk.token === 'string' && typeof lk.url === 'string'
        ? { token: lk.token, url: lk.url, room: typeof lk.room === 'string' ? lk.room : undefined }
        : null,
  };
}

/**
 * What to do after a failed claim:
 *   retry  keep the payment and try again (not seen yet, rate limit, server trouble, stage full)
 *   drop   the payment can never be claimed (txid used, quote bad, Space ended, underpaid)
 */
export type ClaimFailure = { message: string; action: 'retry' | 'drop' };

const codeOf = (data: unknown): string => {
  const d = obj(data);
  return String(d.code ?? d.error ?? d.reason ?? '').toLowerCase();
};

const KEEP = (message: string): ClaimFailure => ({ message, action: 'retry' });
const DROP = (message: string): ClaimFailure => ({ message, action: 'drop' });

/** bit-sign #289's machine `code` in every error body. */
const BY_CODE: Record<string, ClaimFailure> = {
  unauthenticated: KEEP('Sign in to bChat again, then retry. Your payment is kept.'),
  rate_limited: KEEP('Too many tries. Waiting a moment…'),
  room_not_found: KEEP('bChat couldn’t find this room. Your payment is kept; retry later.'),
  bad_tx: KEEP('The payment could not be read. Try again.'),
  not_seen: KEEP('The network hasn’t seen your payment yet. Retrying…'),
  broadcast_failed: KEEP('bChat couldn’t broadcast the payment just now. Retrying…'),
  internal: KEEP('bChat had a problem. Your payment is kept; retrying…'),
  not_enabled: KEEP('Pay to speak is off in this Space right now. Your payment is kept.'),
  stage_full: KEEP('The stage is full. Your payment is kept; retry when a seat opens.'),
  not_joined: KEEP('Join the Space first, then retry. Your payment is kept.'),
  space_ended: DROP('This Space has ended.'),
  quote_expired: DROP('That quote has expired.'),
  quote_invalid: DROP('That quote isn’t valid.'),
  txid_used: DROP('That payment has already bought a seat.'),
  underpaid: DROP('The payment was less than the price.'),
  no_memo: DROP('The payment had no memo, so it can’t buy a seat.'),
};

export function claimErrorFor(status: number, data: unknown): ClaimFailure {
  const code = String(obj(data).code ?? '').toLowerCase();
  if (BY_CODE[code]) return BY_CODE[code];
  // Fallback for bodies without a code: match the status and text.
  const c = codeOf(data);
  switch (status) {
    case 400:
      return { message: 'The payment could not be read. Try again.', action: 'retry' };
    case 401:
      return { message: 'Sign in to bChat again, then retry. Your payment is kept.', action: 'retry' };
    case 402:
      return /memo/.test(c)
        ? { message: 'The payment had no memo, so it can’t buy a seat.', action: 'drop' }
        : { message: 'The payment was less than the price.', action: 'drop' };
    case 404:
      return { message: 'The network hasn’t seen your payment yet. Retrying…', action: 'retry' };
    case 409:
      if (/full/.test(c))
        return { message: 'The stage is full. Your payment is kept; retry when a seat opens.', action: 'retry' };
      if (/not.?joined/.test(c))
        return { message: 'Join the Space first, then retry. Your payment is kept.', action: 'retry' };
      if (/ended|no.?live/.test(c)) return { message: 'This Space has ended.', action: 'drop' };
      if (/used/.test(c)) return { message: 'That payment has already bought a seat.', action: 'drop' };
      return { message: 'That quote has expired or isn’t valid.', action: 'drop' };
    case 429:
      return { message: 'Too many tries. Waiting a moment…', action: 'retry' };
    case 502:
      return { message: 'bChat couldn’t check the payment just now. Retrying…', action: 'retry' };
    default:
      return { message: 'Couldn’t claim your seat. Retrying…', action: 'retry' };
  }
}

export interface SpeakClient {
  speakQuote(ticker: string): Promise<unknown>;
  speakClaim(ticker: string, body: { quote_id: string; txid: string; rawtx: string }): Promise<unknown>;
}

type ErrLike = { status?: number; data?: unknown };

/**
 * Claim a paid seat, retrying the retryable failures with backoff. The pending record is cleared only
 * on success or a permanent refusal.
 */
export async function claimPending(
  client: SpeakClient,
  p: PendingSpeak,
  o: { tries?: number; wait?: (ms: number) => Promise<void>; kv?: KV | null; onFail?: (f: ClaimFailure) => void } = {},
): Promise<{ ok: true; claim: SpeakClaim } | { ok: false; failure: ClaimFailure }> {
  const tries = o.tries ?? 4;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const kv = o.kv === undefined ? store() : o.kv;
  let last: ClaimFailure = { message: 'Couldn’t claim your seat.', action: 'retry' };
  for (let i = 0; i < tries; i++) {
    try {
      const claim = parseSpeakClaim(
        await client.speakClaim(p.ticker, { quote_id: p.quoteId, txid: p.txid, rawtx: p.rawtx }),
      );
      if (!claim) throw Object.assign(new Error('bad claim'), { status: 0 });
      clearPending(p.ticker, kv);
      return { ok: true, claim };
    } catch (e) {
      const err = e as ErrLike;
      last = claimErrorFor(typeof err.status === 'number' ? err.status : 0, err.data);
      o.onFail?.(last);
      if (last.action === 'drop') {
        clearPending(p.ticker, kv);
        return { ok: false, failure: last };
      }
      // A full stage, a missing join or a signed-out session won't fix itself in seconds.
      const st = err.status;
      if (st === 401 || st === 409) return { ok: false, failure: last };
      if (i < tries - 1) await wait(Math.min(2000 * 2 ** i, 15_000));
    }
  }
  return { ok: false, failure: last };
}
