/**
 * bMail delivery safety (18 Oct 2026, after a Bureau test lost a 55,219-sat stamp to a relay size limit):
 *  - Envelopes stay small: the postage BEEF carries only what the recipient needs (stops at mined parents), and a
 *    parent mined since the wallet built the tx gets a merkle proof instead of its ancestors.
 *  - A hard size guard runs BEFORE any broadcast, against the relay's own limit (GET /limits, else the default).
 *  - A pending-postage record (local) keeps a signed or paid stamp so a failed send retries with the SAME stamp.
 */
import { MerklePath, Transaction, Utils, Hash } from '@bsv/sdk';

/** The relay's default cap on message.body (bwalletx-messagebox MAX_BODY_BYTES). */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export const TOO_LARGE_CONFIRMING =
  'This letter is too large to send right now: the coins paying its stamp are still confirming. Nothing was charged. Try again after the next block (about 10 minutes).';
export const TOO_LARGE_TEXT = 'This letter is too large to send. Shorten it and try again.';

export class LetterTooLargeError extends Error {
  constructor(
    message: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(message);
    this.name = 'LetterTooLargeError';
  }
}

const limits = new Map<string, number>();

/** Relay preflight: the relay's body limit (cached per host). Falls back to the default when it can't say. */
export const relayLimit = async (host: string, fetchImpl: typeof fetch = fetch): Promise<number> => {
  const known = limits.get(host);
  if (known) return known;
  try {
    const ctl = typeof AbortController === 'undefined' ? undefined : new AbortController();
    const t = setTimeout(() => ctl?.abort(), 3000);
    const r = await fetchImpl(`${host}/limits`, { signal: ctl?.signal }).finally(() => clearTimeout(t));
    const j = r.ok ? ((await r.json()) as { maxBodyBytes?: unknown }) : null;
    const n = Number(j?.maxBodyBytes);
    if (Number.isSafeInteger(n) && n > 1024) {
      limits.set(host, n);
      return n;
    }
  } catch {
    /* relay without /limits: use the default */
  }
  return DEFAULT_MAX_BODY_BYTES;
};

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

// ── BEEF trimming ──

/** Looks up a merkle proof for a mined txid; null when not mined (or unknown). */
export type ProofFetcher = (txid: string) => Promise<MerklePath | null>;

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** WhatsOnChain TSC proof → BRC-74 MerklePath, checked against the block's merkle root. */
export const wocProof =
  (fetchImpl: typeof fetch = fetch): ProofFetcher =>
  async (txid) => {
    try {
      const r = await fetchImpl(`${WOC}/tx/${txid}/proof/tsc`);
      if (!r.ok) return null;
      const raw = (await r.json()) as unknown;
      const p = (Array.isArray(raw) ? raw[0] : raw) as { index?: number; target?: string; nodes?: string[] } | null;
      if (!p || typeof p.index !== 'number' || typeof p.target !== 'string' || !Array.isArray(p.nodes)) return null;
      const b = await fetchImpl(`${WOC}/block/hash/${p.target}`);
      if (!b.ok) return null;
      const block = (await b.json()) as { height?: number; merkleroot?: string };
      if (typeof block.height !== 'number') return null;
      const mp = tscToMerklePath(txid, p.index, p.nodes, block.height);
      if (block.merkleroot && mp.computeRoot(txid) !== block.merkleroot) return null;
      return mp;
    } catch {
      return null;
    }
  };

export const tscToMerklePath = (txid: string, index: number, nodes: string[], height: number): MerklePath => {
  const leaf = (offset: number, n: string) => (n === '*' ? { offset, duplicate: true } : { offset, hash: n });
  const path = nodes.map((n, i) => {
    const sib = leaf((index >> i) ^ 1, n);
    if (i > 0) return [sib];
    return [{ offset: index, hash: txid, txid: true }, sib].sort((a, b) => a.offset - b.offset);
  });
  if (!path.length) path.push([{ offset: 0, hash: txid, txid: true }]); // single-tx block
  return new MerklePath(height, path);
};

/**
 * Smallest AtomicBEEF for the postage: only the ancestry the recipient needs (it stops at any tx with a proof),
 * and unconfirmed parents that have been mined since get their proof so their ancestors drop out.
 */
export const trimPostageBeef = async (beefHex: string, fetchProof?: ProofFetcher): Promise<string> => {
  const tx = Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex'));
  if (fetchProof) {
    const seen = new Set<string>();
    const walk = async (t: Transaction, depth: number) => {
      for (const input of t.inputs) {
        const src = input.sourceTransaction;
        if (!src || src.merklePath) continue;
        const id = src.id('hex');
        if (seen.has(id)) continue;
        seen.add(id);
        const mp = await fetchProof(id);
        if (mp) src.merklePath = mp;
        else if (depth < 4) await walk(src, depth + 1);
      }
    };
    await walk(tx, 0);
  }
  const out = Utils.toHex(tx.toAtomicBEEF());
  return out.length < beefHex.length ? out : beefHex;
};

// ── pending postage ──

export type PendingState = 'signed' | 'broadcast';
export type PendingPostage<P> = {
  key: string;
  id: string;
  to: string;
  postage: P;
  /** signed = made with noSend, not broadcast yet (abortable); broadcast = paid. */
  state: PendingState;
  at: number;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const ls = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const PENDING_KEY = (me: string) => `bwx.bmail.pending.${me}`;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/** Same letter = same recipient + subject + body: a retry of it reuses the stamp. */
export const letterKey = (to: string, subject: string, body: string) =>
  Utils.toHex(Hash.sha256(Utils.toArray(`${to}\n${subject}\n${body}`, 'utf8'))).slice(0, 32);

export const loadPending = <P>(me: string, st: Store | null = ls(), now = Date.now()): PendingPostage<P>[] => {
  try {
    const raw = JSON.parse(st?.getItem(PENDING_KEY(me)) ?? '[]') as PendingPostage<P>[];
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.key === 'string' && now - p.at < MAX_AGE) : [];
  } catch {
    return [];
  }
};

const savePending = <P>(me: string, xs: PendingPostage<P>[], st: Store | null) => {
  try {
    if (xs.length) st?.setItem(PENDING_KEY(me), JSON.stringify(xs));
    else st?.removeItem(PENDING_KEY(me));
  } catch {
    /* storage full / blocked: the send still works, only the retry memory is lost */
  }
};

export const putPending = <P>(me: string, p: PendingPostage<P>, st: Store | null = ls()) =>
  savePending(me, [p, ...loadPending<P>(me, st).filter((x) => x.key !== p.key)], st);

export const dropPending = (me: string, key: string, st: Store | null = ls()) =>
  savePending(
    me,
    loadPending(me, st).filter((x) => x.key !== key),
    st,
  );

/** A relay answer that means "never": no point keeping an unbroadcast stamp for it. */
export const isRefusal = (e: unknown) =>
  /HTTP 4\d\d|too large|blocked|LetterTooLarge/i.test(String((e as Error)?.message ?? e));
