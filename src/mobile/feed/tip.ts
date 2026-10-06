import { OP, P2PKH, Script, Utils, type Transaction } from '@bsv/sdk';
import { decodeScript, isTxid, MAP_PREFIX } from './post';
import { FEED_APP, type Source } from './sources';

/**
 * bChat tips and paid likes (bit-sign docs/BCHAT-PROTOCOL-v2-DRAFT.md §2, §5). PURE: no wallet, no network.
 * Mirrored in bit-sign src/lib/feed/tip.ts and bwalletx-indexer src/parse.ts; keep in step.
 *
 * One transaction carries the action AND the payment, so they are atomic and an indexer can
 * match them:
 *
 *   out k:   OP_FALSE OP_RETURN MAP SET app bChat type tip  v 2 context tx tx <txid> amount <A>        | AIP …
 *            OP_FALSE OP_RETURN MAP SET app bChat type like v 2 context tx tx <txid> amount <A> paid 1 | AIP …
 *   out k+1: P2PKH -> the post's author, exactly A sats
 *   then:    change (no bChat fee output)
 */
export const TIP_MIN_SATS = 546;
/** Hard ceiling on one tip (1 BSV) so a typo cannot empty a wallet. */
export const TIP_MAX_SATS = 100_000_000;
export const PAID_LIKE_DEFAULT_SATS = 1_000;
/** Tip sheet presets, in US dollars (converted to sats at the current rate). */
export const TIP_PRESETS_USD = [0.05, 0.25, 1] as const;
/** Sats fallbacks for the presets when the USD rate is unknown. */
export const TIP_PRESETS_SATS = [1_000, 5_000, 20_000] as const;

/**
 * Treechat relays every post through one shared signer, so the AIP address is Treechat's, not the
 * author's. A payment there would go to Treechat. Builders refuse these outright.
 * (Seen on bmap, 6 Oct 2026: app=treechat and app=treechat_staging.)
 */
export const TREECHAT_RELAY_ADDRESSES: readonly string[] = [
  '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK',
  '14A3GLQM96fymAvCrgMH4v3kY3WhjC184x',
];

export const TREECHAT_UNPAYABLE =
  'Treechat signs every post with one shared key, so a tip would go to Treechat, not the author.';

export type PayKind = 'tip' | 'like';
export type PayTo = { ok: true; address: string } | { ok: false; reason: string };

/** A mainnet P2PKH address (base58check, version 0). */
export function isP2pkhAddress(a: unknown): a is string {
  if (typeof a !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return false;
  try {
    const { prefix, data } = Utils.fromBase58Check(a);
    return (prefix as number[]).length === 1 && (prefix as number[])[0] === 0 && (data as number[]).length === 20;
  } catch {
    return false;
  }
}

/**
 * Where a tip / paid like for this post goes (§5 "author address resolution"):
 *   bChat / Bitcoin Schema: the post's AIP signing address.
 *   Twetch: the address of the author's Twetch public key (the key that AIP-signs their posts).
 *   Treechat: never (shared relay signer).
 */
export function payDestination(post: { source: Source; author: { address: string } }): PayTo {
  if (post.source === 'treechat') return { ok: false, reason: TREECHAT_UNPAYABLE };
  const a = post.author.address;
  if (TREECHAT_RELAY_ADDRESSES.includes(a)) return { ok: false, reason: TREECHAT_UNPAYABLE };
  if (!isP2pkhAddress(a)) return { ok: false, reason: 'This post has no payable author address.' };
  return { ok: true, address: a };
}

export function validateAmount(sats: unknown): string | null {
  if (typeof sats !== 'number' || !Number.isSafeInteger(sats)) return 'Enter a whole number of sats.';
  if (sats < TIP_MIN_SATS) return `The smallest payment is ${TIP_MIN_SATS} sats.`;
  if (sats > TIP_MAX_SATS) return 'That is more than one tip can send.';
  return null;
}

const pushStr = (s: Script, v: string) => s.writeBin(Utils.toArray(v, 'utf8'));

/** The unsigned MAP script for a tip or paid like (AIP is appended by the signer). */
export function buildPayScript(kind: PayKind, txid: string, sats: number, app = FEED_APP): Script {
  if (!isTxid(txid)) throw new Error('That post id is not valid.');
  const bad = validateAmount(sats);
  if (bad) throw new Error(bad);
  const kv: [string, string][] = [
    ['app', app],
    ['type', kind],
    ['v', '2'],
    ['context', 'tx'],
    ['tx', txid.toLowerCase()],
    ['amount', String(sats)],
  ];
  if (kind === 'like') kv.push(['paid', '1']);
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  pushStr(s, MAP_PREFIX);
  pushStr(s, 'SET');
  for (const [k, v] of kv) {
    pushStr(s, k);
    pushStr(s, v);
  }
  return s;
}

export const buildTipScript = (txid: string, sats: number, app = FEED_APP) => buildPayScript('tip', txid, sats, app);
export const buildPaidLikeScript = (txid: string, sats: number, app = FEED_APP) =>
  buildPayScript('like', txid, sats, app);

export type PayPlan = { script: Script; payment: { address: string; satoshis: number; lockingScript: Script } };

/**
 * Everything a wallet needs for one tip / paid like: the MAP script (output k) and the payment
 * output (k+1). Throws, never pays, when the author is unpayable (Treechat, relay, no address).
 */
export function planPayment(
  kind: PayKind,
  post: { txid: string; source: Source; author: { address: string } },
  sats: number,
): PayPlan {
  const to = payDestination(post);
  if (!to.ok) throw new Error(to.reason);
  const script = buildPayScript(kind, post.txid, sats);
  return { script, payment: { address: to.address, satoshis: sats, lockingScript: new P2PKH().lock(to.address) } };
}

// ── reading ──────────────────────────────────────────────────────────────────────

export type ParsedPayment = {
  kind: PayKind;
  /** The post paid for. */
  target: string;
  amount: number;
  /** Address of output k+1 when it is P2PKH, else null. */
  payTo: string | null;
  /** Output k+1 exists, is P2PKH and carries exactly `amount` (≥ dust). Not yet matched to the author. */
  valid: boolean;
  /** AIP signer (the payer), when signed. */
  from: string | null;
};

const P2PKH_RE = /^76a914([0-9a-f]{40})88ac$/;

/** A tip / paid like in a transaction, or null if it carries none. */
export function parsePayment(tx: Pick<Transaction, 'outputs'>): ParsedPayment | null {
  for (let k = 0; k < tx.outputs.length; k++) {
    const script = tx.outputs[k].lockingScript;
    if (!script.chunks.some((c) => c.op === OP.OP_RETURN)) continue;
    const d = decodeScript(script);
    if (!d || !d.MAP.app) continue;
    const m = d.MAP;
    const kind: PayKind | null = m.type === 'tip' ? 'tip' : m.type === 'like' && m.paid === '1' ? 'like' : null;
    if (!kind) return null;
    const target = isTxid(m.tx) ? m.tx.toLowerCase() : null;
    if (!target || !/^[1-9]\d*$/.test(m.amount ?? '')) return null;
    const amount = Number(m.amount);
    const next = tx.outputs[k + 1];
    const pkh = next ? P2PKH_RE.exec(next.lockingScript.toHex()) : null;
    const payTo = pkh ? Utils.toBase58Check(Utils.toArray(pkh[1], 'hex'), [0]) : null;
    const valid = !!payTo && Number.isSafeInteger(amount) && amount >= TIP_MIN_SATS && next!.satoshis === amount;
    return { kind, target, amount, payTo, valid, from: d.aip?.address ?? null };
  }
  return null;
}

/**
 * Sum of verified payments to `author` for each post: only valid payment outputs that pay the
 * resolved author count (§5: anything else counts as 0).
 */
export function tipTotals(
  payments: ParsedPayment[],
  authorOf: (txid: string) => string | null,
): Map<string, { sats: number; count: number }> {
  const out = new Map<string, { sats: number; count: number }>();
  for (const p of payments) {
    const author = authorOf(p.target);
    if (!p.valid || !author || p.payTo !== author || TREECHAT_RELAY_ADDRESSES.includes(author)) continue;
    const t = out.get(p.target) ?? { sats: 0, count: 0 };
    t.sats += p.amount;
    t.count += 1;
    out.set(p.target, t);
  }
  return out;
}
