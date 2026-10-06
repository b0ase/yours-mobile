import { OP, P2PKH, Script, Utils, type Transaction } from '@bsv/sdk';
import { decodeScript, isTxid, MAP_PREFIX } from './post';
import { FEED_APP, SOURCE_REGISTRY, type Source } from './sources';

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
 *   [k+2:    P2PKH -> client fee, only with MAP fee/feeTo (bChat's is 0)]
 *   [next:   P2PKH -> the post's HOME app, H sats, only with MAP home/homeTo (spec §6.2)]
 *   then:    change
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

/** Client fee caps (spec §6.1): ≤ 5% of the author amount and ≤ 10,000 sats, never from the author's share. */
export const CLIENT_FEE_MAX_PCT = 5;
export const CLIENT_FEE_MAX_SATS = 10_000;
/** bChat's own client fee. 0 = none (the owner has not set one): no fee output, no fee keys. */
export const BCHAT_CLIENT_FEE: { pct: number; address: string } = { pct: 0, address: '' };

export const clientFeeAllowed = (fee: number, amount: number): boolean =>
  Number.isSafeInteger(fee) && fee >= 1 && fee <= CLIENT_FEE_MAX_SATS && fee * 100 <= amount * CLIENT_FEE_MAX_PCT;

export type ClientFee = { address: string; satoshis: number };

/** The client fee for a payment under a fee policy (rounded down, capped); null for none. */
export function clientFeeFor(
  amount: number,
  policy: { pct: number; address: string } = BCHAT_CLIENT_FEE,
): ClientFee | null {
  if (!policy.pct || !policy.address || !isP2pkhAddress(policy.address)) return null;
  const sats = Math.min(Math.floor((amount * Math.min(policy.pct, CLIENT_FEE_MAX_PCT)) / 100), CLIENT_FEE_MAX_SATS);
  return sats >= 1 ? { address: policy.address, satoshis: sats } : null;
}

/**
 * Home app share (spec §6.2): a tip / paid like on a post from ANOTHER app adds
 * BCHAT_HOME_SHARE_PCT % of the author amount ON TOP, as its own output, to the address that app
 * published for itself (SOURCE_REGISTRY[source].homePayTo). Same caps as the client fee. No
 * published address → no share, silently. Never to the author, never from the author's amount.
 */
export const HOME_SHARE_MAX_PCT = 5;
export const HOME_SHARE_MAX_SATS = 10_000;
export const BCHAT_HOME_SHARE_PCT = 5;
export const homeShareAllowed = (home: number, amount: number): boolean =>
  Number.isSafeInteger(home) && home >= 1 && home <= HOME_SHARE_MAX_SATS && home * 100 <= amount * HOME_SHARE_MAX_PCT;
export type HomeShare = { address: string; satoshis: number; app: string };

/** The home app's published payment address for a source, or null (none published). */
export function homePayToOf(source: Source): string | null {
  if (source === 'bchat' || source === 'other') return null;
  const a = SOURCE_REGISTRY[source]?.homePayTo;
  return a && isP2pkhAddress(a) ? a : null;
}

/** The home share for `amount` sats on a post from `source`, or null. `homeTo` overrides the registry. */
export function homeShareFor(
  source: Source,
  amount: number,
  homeTo: string | null = homePayToOf(source),
  pct = BCHAT_HOME_SHARE_PCT,
): HomeShare | null {
  if (source === 'bchat' || !homeTo || !isP2pkhAddress(homeTo) || !(pct > 0)) return null;
  const sats = Math.min(Math.floor((amount * Math.min(pct, HOME_SHARE_MAX_PCT)) / 100), HOME_SHARE_MAX_SATS);
  return sats >= 1 ? { address: homeTo, satoshis: sats, app: SOURCE_REGISTRY[source].label } : null;
}

export function validateAmount(sats: unknown): string | null {
  if (typeof sats !== 'number' || !Number.isSafeInteger(sats)) return 'Enter a whole number of sats.';
  if (sats < TIP_MIN_SATS) return `The smallest payment is ${TIP_MIN_SATS} sats.`;
  if (sats > TIP_MAX_SATS) return 'That is more than one tip can send.';
  return null;
}

const pushStr = (s: Script, v: string) => s.writeBin(Utils.toArray(v, 'utf8'));

/** The unsigned MAP script for a tip or paid like (AIP is appended by the signer). */
export function buildPayScript(
  kind: PayKind,
  txid: string,
  sats: number,
  app = FEED_APP,
  fee: ClientFee | null = null,
  home: { address: string; satoshis: number } | null = null,
): Script {
  if (!isTxid(txid)) throw new Error('That post id is not valid.');
  const bad = validateAmount(sats);
  if (bad) throw new Error(bad);
  if (fee && (!clientFeeAllowed(fee.satoshis, sats) || !isP2pkhAddress(fee.address)))
    throw new Error('That app fee is over the allowed cap.');
  if (home && (!homeShareAllowed(home.satoshis, sats) || !isP2pkhAddress(home.address)))
    throw new Error('That home app share is over the allowed cap.');
  if (home && fee && home.address === fee.address)
    throw new Error('The home app share and the app fee cannot share an address.');
  const kv: [string, string][] = [
    ['app', app],
    ['type', kind],
    ['v', '2'],
    ['context', 'tx'],
    ['tx', txid.toLowerCase()],
    ['amount', String(sats)],
  ];
  if (kind === 'like') kv.push(['paid', '1']);
  if (fee) kv.push(['fee', String(fee.satoshis)], ['feeTo', fee.address]);
  if (home) kv.push(['home', String(home.satoshis)], ['homeTo', home.address]);
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  pushStr(s, MAP_PREFIX);
  pushStr(s, 'SET');
  for (const [k, v] of kv) {
    pushStr(s, k);
    pushStr(s, v);
  }
  return s;
}

type HomeOut = { address: string; satoshis: number } | null;
export const buildTipScript = (
  txid: string,
  sats: number,
  app = FEED_APP,
  fee: ClientFee | null = null,
  home: HomeOut = null,
) => buildPayScript('tip', txid, sats, app, fee, home);
export const buildPaidLikeScript = (
  txid: string,
  sats: number,
  app = FEED_APP,
  fee: ClientFee | null = null,
  home: HomeOut = null,
) => buildPayScript('like', txid, sats, app, fee, home);

type PayOutput = { address: string; satoshis: number; lockingScript: Script };
/**
 * `payment` is output k+1 (the author, exactly the amount); `payment.fee`, when set, is output k+2;
 * `payment.home`, when set, is the output after that (k+2 with no fee, k+3 with one).
 */
export type PayPlan = { script: Script; payment: PayOutput & { fee?: PayOutput; home?: PayOutput & { app: string } } };

/**
 * Everything a wallet needs for one tip / paid like: the MAP script (output k) and the payment
 * output (k+1). Throws, never pays, when the author is unpayable (Treechat, relay, no address).
 */
export function planPayment(
  kind: PayKind,
  post: { txid: string; source: Source; author: { address: string } },
  sats: number,
  policy: { pct: number; address: string } = BCHAT_CLIENT_FEE,
  opts: { homeTo?: string | null } = {},
): PayPlan {
  const to = payDestination(post);
  if (!to.ok) throw new Error(to.reason);
  const fee = clientFeeFor(sats, policy);
  if (fee && fee.address === to.address) throw new Error('The app fee cannot go to the author.');
  let home = homeShareFor(post.source, sats, opts.homeTo === undefined ? homePayToOf(post.source) : opts.homeTo);
  // Never to the author or the fee address: skip silently (the author is still paid in full).
  if (home && (home.address === to.address || home.address === fee?.address)) home = null;
  const script = buildPayScript(kind, post.txid, sats, FEED_APP, fee, home);
  return {
    script,
    payment: {
      address: to.address,
      satoshis: sats,
      lockingScript: new P2PKH().lock(to.address),
      ...(fee ? { fee: { ...fee, lockingScript: new P2PKH().lock(fee.address) } } : {}),
      ...(home ? { home: { ...home, lockingScript: new P2PKH().lock(home.address) } } : {}),
    },
  };
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
  /** Declared client fee (§6.1), 0 when none; its destination. */
  fee: number;
  feeTo: string | null;
  /** No fee declared, or output k+2 pays `feeTo` exactly `fee` within the caps. Never affects `valid`. */
  feeValid: boolean;
  /** Declared home app share (§6.2), 0 when none; its destination. */
  home: number;
  homeTo: string | null;
  /** No share declared, or the output after the fee (or k+2) pays `homeTo` exactly `home` within the caps. Never affects `valid`. */
  homeValid: boolean;
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
    const fee = /^[1-9]\d*$/.test(m.fee ?? '') ? Number(m.fee) : 0;
    const feeTo = fee ? (m.feeTo ?? '').trim() || null : null;
    let feeValid = true;
    if (fee) {
      const fo = tx.outputs[k + 2];
      const fpkh = fo ? P2PKH_RE.exec(fo.lockingScript.toHex()) : null;
      const fto = fpkh ? Utils.toBase58Check(Utils.toArray(fpkh[1], 'hex'), [0]) : null;
      feeValid = !!feeTo && fto === feeTo && fo!.satoshis === fee && clientFeeAllowed(fee, amount) && feeTo !== payTo;
    }
    const home = /^[1-9]\d*$/.test(m.home ?? '') ? Number(m.home) : 0;
    const homeTo = home ? (m.homeTo ?? '').trim() || null : null;
    let homeValid = true;
    if (home) {
      const ho = tx.outputs[k + 2 + (fee ? 1 : 0)];
      const hpkh = ho ? P2PKH_RE.exec(ho.lockingScript.toHex()) : null;
      const hto = hpkh ? Utils.toBase58Check(Utils.toArray(hpkh[1], 'hex'), [0]) : null;
      homeValid =
        !!homeTo &&
        hto === homeTo &&
        ho!.satoshis === home &&
        homeShareAllowed(home, amount) &&
        homeTo !== payTo &&
        homeTo !== feeTo;
    }
    return {
      kind,
      target,
      amount,
      payTo,
      valid,
      from: d.aip?.address ?? null,
      fee,
      feeTo,
      feeValid,
      home,
      homeTo,
      homeValid,
    };
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
