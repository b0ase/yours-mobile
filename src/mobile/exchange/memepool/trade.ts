/**
 * Memepool buy/sell flow (docs/MEMEPOOL-TRADING-DESIGN.md). THIS FILE MOVES MONEY (money-paths.txt).
 *
 *   quote → prepare (trader {ord, pay}, our coins) → verify the template here → ONE approval sheet (the caller)
 *   → sign only our inputs (SIGHASH_ALL|FORKID) → submit → watch the transaction.
 *
 * A buy first sets the BSV for the trade aside on a fresh key of this wallet (a payment to itself), because Memepool
 * spends named coins and the wallet's own coins can't be signed one by one. If the trade doesn't happen, that coin
 * is taken back into the wallet's balance (cancel). Rules the owner set: one sheet; 409 = re-prepare once, and after
 * a signature never sign again silently (a fresh sheet instead); after submit, never re-sign, only watch.
 */
import { Random, Utils } from '@bsv/sdk';
import {
  CAP_SATS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_INDEX_FEE,
  MAX_SLIPPAGE_BPS,
  MIN_BUY_SATS,
  NETWORK_ALLOWANCE,
  QUOTE_TTL_MS,
  SELL_NETWORK_RESERVE,
} from './constants';
import {
  MemepoolHttpError,
  configProblem,
  getCoin,
  getConfig,
  getProof,
  getQuote,
  plainError,
  prepareTrade,
  submitTrade,
  type Fetcher,
} from './api';
import { CurveError, buyTokens, minTokensFor, parseCurve, sellSats, type CurveParams, type CurveState } from './curve';
import { assertNotPaused } from '../../config/killSwitch';
import { proofVerdict, type ProofVerdict } from './proof';
import {
  giveBack,
  giveBackIfSafe,
  idOf,
  safePut,
  safeRemove,
  sweepPending,
  toRecord,
  type Chain,
  type Outpoint,
  type PendingStore,
  type SignedSpend,
  type SweepResult,
} from './pending';
import { addressPkh, isAddress, parseP2pkh } from './script';
import type { CoinKey } from './sign';
import {
  TradeRefused,
  verifyTemplate,
  type CheckedTrade,
  type OurCoin,
  type Template,
  type VerifyContext,
} from './validate';

export { TradeRefused };

const ZERO = BigInt(0);

/** A coin of ours offered to a trade, with the key that signs it. */
export type OfferedCoin = { txid: string; vout: number; satoshis: number; script: string; amt?: bigint; key: CoinKey };
export type PayKey = { address: string; key: CoinKey; derivationPrefix: string; derivationSuffix: string };
export type OrdKey = { address: string; key: CoinKey };
export type Funding = { coin: OfferedCoin; beef: number[]; pay: PayKey };
/** Checks run inside a spend: each throws to stop it (the kill switch). */
export type SpendGuard = { beforeSign(): Promise<void>; beforeBroadcast(): Promise<void> };

/** What the flow needs from the wallet (memepool/wallet.ts builds it from the in-app BRC-100 wallet). */
export type TradeWallet = {
  newOrdKey(tokenId: string): Promise<OrdKey>;
  /** A BRC-29 payment key to ourselves. With a `nonce` it is re-derived (BRC-42), never random. */
  newPayKey(nonce?: { prefix: string; suffix: string }): Promise<PayKey>;
  /** Pay `sats` to our own `pay` key; resolves once the wallet has sent it. */
  fund(pay: PayKey, sats: number): Promise<Funding>;
  /** Take a funding coin that wasn't spent back into the wallet's balance. */
  returnFunding(f: Funding): Promise<void>;
  /**
   * "Recover now": spend the funding coin back to this wallet (createAction + signAction, internal change, normal fee),
   * which double-spends any trade Memepool holds. `guard` runs right before signing and right before broadcast.
   * Resolves to the txid.
   */
  spendBack(f: Funding, guard: SpendGuard): Promise<string>;
  /** Our token coins of `tokenId` that this wallet can sign, largest first. */
  tokenCoins(tokenId: string): Promise<OfferedCoin[]>;
  /** Unlocking scripts for exactly these input indexes. */
  sign(t: Template, indexes: number[], keyFor: (i: number) => CoinKey | undefined): Promise<Record<string, string>>;
  /** Record what the trade paid us (tokens, change, payout) once the network has it. */
  receive(txid: string, t: Template, p: { ord: OrdKey; pay: PayKey; sym: string; tokenId: string }): Promise<void>;
};

export type Deps = {
  fetch: Fetcher;
  wallet: TradeWallet;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where a buy's funding is written down so a restart can recover it (pending.ts). */
  pending?: PendingStore;
  /** The kill switch for "Recover now" (default: assertNotPaused('spending')). Throws to stop the spend. */
  spendingCheck?: () => Promise<void>;
};
const nowOf = (d: Deps) => (d.now ?? Date.now)();
const sleepOf = (d: Deps) => d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

export type Market = {
  tokenId: string;
  sym: string;
  params: CurveParams;
  state: CurveState;
  proof: ProofVerdict;
  indexAddress: string | null;
};

const plain = (why: string): never => {
  throw new TradeRefused(why);
};

/** Everything a trade needs to know about one coin, or a plain-English refusal. */
export async function loadMarket(d: Deps, tokenId: string): Promise<Market> {
  const [cfg, coin, proofBody] = await Promise.all([
    getConfig(d.fetch),
    getCoin(d.fetch, tokenId),
    getProof(d.fetch),
  ]).catch((e) => plain(plainError(e)));
  const why = configProblem(cfg);
  if (why) plain(why);
  const proof = proofVerdict(proofBody, tokenId);
  if (!proof.healthy) plain(proof.why);
  if (coin.status !== 'live' || coin.haltReason || coin.pause) plain('Memepool has paused trading this coin for now.');
  if (proof.healthy && (coin.poolPay !== proof.row.poolPay || coin.poolOrd !== proof.row.poolOrd))
    plain("This coin's pool doesn't match Memepool's proof of reserves, so we won't trade it.");
  const curve = parseCurve(coin);
  if (!curve) plain("Memepool's numbers for this coin don't add up, so we won't trade it.");
  const ix = (coin.indexer as { fundAddress?: unknown } | undefined)?.fundAddress;
  return {
    tokenId,
    sym: typeof coin.sym === 'string' ? coin.sym.slice(0, 20) : tokenId.slice(0, 6),
    params: curve!.params,
    state: curve!.state,
    proof,
    indexAddress: isAddress(ix) ? ix : null,
  };
}

const clampSlip = (bps: number) => Math.max(10, Math.min(MAX_SLIPPAGE_BPS, Math.floor(bps || DEFAULT_SLIPPAGE_BPS)));
const num = (v: unknown): bigint | null =>
  typeof v === 'string' && /^\d{1,20}$/.test(v)
    ? BigInt(v)
    : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? BigInt(v)
      : null;

/** A checked trade waiting for the user's Allow. */
export type Prepared = {
  side: 'buy' | 'sell';
  market: Market;
  /** Buy: sats budget. Sell: tokens. */
  amount: bigint;
  slippageBps: number;
  quoteId: string;
  template: Template;
  /** Our deadline for signing: Memepool's expiry, capped at QUOTE_TTL_MS. */
  expiresAt: number;
  /** Memepool's own expiry, uncapped: how long it may still use a trade we signed. */
  quoteExpiresAt: number;
  checked: CheckedTrade;
  limits: VerifyContext['limits'];
  /** Buy: the most that can leave the wallet (what the sheet shows). */
  maxSpend: bigint;
  ord: OrdKey;
  pay: PayKey;
  coins: OfferedCoin[];
  funding: Funding | null;
  /** Signatures already made over `funding` on an earlier sheet (409, then a new sheet). */
  signed?: SignedSpend[];
};

type Limits = { limits: VerifyContext['limits']; maxSpend: bigint; indexFee: number };

/** Limits from OUR curve maths at the user's slippage, cross-checked with Memepool's quote. */
async function limitsFor(d: Deps, m: Market, side: 'buy' | 'sell', amount: bigint, slip: number): Promise<Limits> {
  const q = await getQuote(d.fetch, m.tokenId, side, amount).catch((e) => plain(plainError(e)));
  const qTokens = num(q.tokens);
  const qGross = num(q.grossSats);
  const indexFee = Number(num(q.indexFeeSats) ?? -1);
  if (qTokens === null || qGross === null || !(indexFee >= 0)) plain("Memepool's quote doesn't add up.");
  if (indexFee > MAX_INDEX_FEE) plain('Memepool asks for an unusually high indexer fee.');
  try {
    if (side === 'buy') {
      if (amount < MIN_BUY_SATS) plain('The smallest buy on Memepool is 0.0001 BSV.');
      if (amount > CAP_SATS) plain('The most you can buy in one go is 1 BSV.');
      const ours = buyTokens(m.params, m.state, amount);
      const minTokens = minTokensFor(ours, slip);
      if (minTokens <= ZERO) plain('That buy is too small to get any tokens.');
      if (qTokens! < minTokens) plain('The price moved more than you allowed. Try again.');
      const charged = qGross! < amount ? qGross! : amount;
      const maxSpend = charged + BigInt(indexFee + NETWORK_ALLOWANCE);
      return { limits: { maxSpendSats: maxSpend, minTokens }, maxSpend, indexFee };
    }
    const ours = sellSats(m.params, m.state, amount);
    if (ours.gross > CAP_SATS) plain('The most you can sell in one go is 1 BSV worth. Sell fewer tokens.');
    const expected = ours.net - BigInt(indexFee + SELL_NETWORK_RESERVE);
    const minSats = (expected * BigInt(10_000 - slip)) / BigInt(10_000);
    if (minSats < BigInt(1)) plain('That sell is too small to cover its fees.');
    return { limits: { tokens: amount, minSats }, maxSpend: ZERO, indexFee };
  } catch (e) {
    if (e instanceof CurveError) plain(e.message);
    throw e;
  }
}

/** POST /trade/prepare and verify. 409 = once more; a coin the network hasn't shown yet is waited for. */
async function prepareAndVerify(
  d: Deps,
  m: Market,
  side: 'buy' | 'sell',
  amount: bigint,
  l: Limits,
  ord: OrdKey,
  pay: PayKey,
  coins: OfferedCoin[],
): Promise<{ template: Template; quoteId: string; expiresAt: number; quoteExpiresAt: number; checked: CheckedTrade }> {
  const body = {
    tokenId: m.tokenId,
    side,
    ...(side === 'buy'
      ? { sats: Number(amount), minTokens: (l.limits as { minTokens: bigint }).minTokens.toString() }
      : { tokens: amount.toString(), minSats: Number((l.limits as { minSats: bigint }).minSats) }),
    trader: { ord: ord.address, pay: pay.address },
    coins: coins.map((c) => ({ txid: c.txid, vout: c.vout })),
  };
  let prep: Record<string, unknown> | null = null;
  let stale = 0;
  for (let wait = 0; !prep; ) {
    try {
      prep = await prepareTrade(d.fetch, body);
    } catch (e) {
      if (e instanceof MemepoolHttpError && e.status === 409 && stale++ < 1) continue; // re-prepare once
      if (e instanceof MemepoolHttpError && e.code === 'unknown_coin' && wait++ < 10) {
        await sleepOf(d)(1500); // our just-sent coin hasn't reached Memepool's indexer yet
        continue;
      }
      plain(plainError(e));
    }
  }
  const template = prep!.template as Template;
  const quoteId = prep!.quoteId;
  if (typeof quoteId !== 'string' || !quoteId || !template) plain("Memepool sent an answer this wallet can't read.");
  const exp = Number(prep!.expiresAt);
  const now = nowOf(d);
  // Memepool may send seconds or ms; never trust more than our own TTL for signing.
  const theirs = Number.isFinite(exp) && exp > 0 ? (exp < 1e12 ? exp * 1000 : exp) : NaN;
  const expiresAt = Math.min(Number.isFinite(theirs) ? theirs : Infinity, now + QUOTE_TTL_MS);
  // But Memepool may keep a signed trade until ITS expiry, so recovery waits for the later of the two.
  const quoteExpiresAt = Number.isFinite(theirs) ? Math.max(theirs, expiresAt) : expiresAt;
  const ctx: VerifyContext = {
    side,
    tokenId: m.tokenId,
    me: {
      ord: ord.address,
      pay: pay.address,
      coins: new Map<string, OurCoin>(
        coins.map((c) => [`${c.txid}_${c.vout}`, { satoshis: c.satoshis, script: c.script, amt: c.amt }]),
      ),
    },
    proof: m.proof,
    indexAddress: m.indexAddress,
    limits: l.limits,
    expiresAt,
    now,
  };
  return { template, quoteId: quoteId as string, expiresAt, quoteExpiresAt, checked: verifyTemplate(template, ctx) };
}

/** Quote, prepare and check a buy of `budget` sats. Sets the BSV aside first (see the header). */
export async function prepareBuy(d: Deps, m: Market, budget: bigint, slippageBps: number): Promise<Prepared> {
  const slip = clampSlip(slippageBps);
  const l = await limitsFor(d, m, 'buy', budget, slip);
  const ord = await d.wallet.newOrdKey(m.tokenId);
  const nonce = { prefix: Utils.toBase64(Random(10)), suffix: Utils.toBase64(Random(10)) };
  const pay = await d.wallet.newPayKey(nonce);
  // Write the key's nonce down BEFORE any BSV moves, so a crash can never strand the funding. If it can't be written,
  // nothing has moved yet: refuse the buy rather than fund a coin nobody could find again.
  const noted =
    !d.pending ||
    safePut(d.pending, {
      id: idOf(nonce.prefix, nonce.suffix),
      ...nonce,
      sats: Number(l.maxSpend),
      state: 'pending',
      createdAt: nowOf(d),
    });
  if (!noted) plain("This wallet couldn't save the note it needs before setting BSV aside. Nothing was spent.");
  // If fund() throws we can't know the BSV didn't go out, so the nonce record stays; the sweep finds its coin by address.
  const funding = await d.wallet.fund(pay, Number(l.maxSpend));
  // The funding coin is written down (slim, no BEEF) before going on and before any give-back. If it can't be, the
  // BSV goes back now; if that fails too, the nonce record above lets the next sweep find the coin by its address.
  if (d.pending && !safePut(d.pending, toRecord(funding, Number(l.maxSpend), 'pending', nowOf(d)))) {
    const back = await giveBack(d.wallet, d.pending, funding).catch(() => false);
    plain(
      back
        ? "This wallet couldn't save its note of the BSV set aside, so it was put back. Nothing was bought."
        : "This wallet couldn't save its note of the BSV set aside. Nothing was bought. The BSV comes back to your balance by itself: open Memepool again in about 10 minutes.",
    );
  }
  try {
    const r = await prepareAndVerify(d, m, 'buy', budget, l, ord, pay, [funding.coin]);
    return {
      side: 'buy',
      market: m,
      amount: budget,
      slippageBps: slip,
      ...r,
      ...l,
      ord,
      pay,
      coins: [funding.coin],
      funding,
    };
  } catch (e) {
    // Nothing was signed. A failed give-back keeps the record for the sweep.
    await giveBack(d.wallet, d.pending, funding).catch(() => false);
    throw e;
  }
}

/** Quote, prepare and check a sell of `tokens`. */
export async function prepareSell(d: Deps, m: Market, tokens: bigint, slippageBps: number): Promise<Prepared> {
  const slip = clampSlip(slippageBps);
  if (tokens <= ZERO) plain('Enter how many tokens to sell.');
  const l = await limitsFor(d, m, 'sell', tokens, slip);
  const all = await d.wallet.tokenCoins(m.tokenId);
  const coins: OfferedCoin[] = [];
  let held = ZERO;
  for (const c of all) {
    if (held >= tokens || coins.length >= 8) break;
    coins.push(c);
    held += c.amt ?? ZERO;
  }
  if (held < tokens) plain(`You can sell ${held.toLocaleString('en-US')} right now (new coins can take a minute).`);
  const ord = await d.wallet.newOrdKey(m.tokenId); // where any tokens left over come back
  const pay = await d.wallet.newPayKey(); // where the BSV comes back
  const r = await prepareAndVerify(d, m, 'sell', tokens, l, ord, pay, coins);
  return { side: 'sell', market: m, amount: tokens, slippageBps: slip, ...r, ...l, ord, pay, coins, funding: null };
}

export type ExecuteResult =
  /** Memepool took it and is broadcasting. Watch `txid`; never sign again. */
  | { kind: 'sent'; txid: string }
  /** Someone traded first. Here's a fresh, checked trade: show it on a NEW sheet, never sign it silently. */
  | { kind: 'new-sheet'; prepared: Prepared; brokeMinimum: boolean }
  /** We don't know whether Memepool broadcast it. Watch our coin; never sign again. */
  | { kind: 'unsure'; message: string };

/** How long past the later quote expiry (ours, Memepool's) before a signed funding may come back. */
export const UNSURE_MARGIN_MS = 2 * 60 * 1000;

/** The same checks as before the sheet, right before signing (the quote may have expired while it was open); then sign. */
async function checkAndSign(
  d: Deps,
  p: Prepared,
  keys: Map<string, CoinKey>,
): Promise<{ unlocks: Record<string, string>; others: Outpoint[] }> {
  const checked = verifyTemplate(p.template, {
    side: p.side,
    tokenId: p.market.tokenId,
    me: {
      ord: p.ord.address,
      pay: p.pay.address,
      coins: new Map(
        p.coins.map((c) => [`${c.txid}_${c.vout}`, { satoshis: c.satoshis, script: c.script, amt: c.amt }]),
      ),
    },
    proof: p.market.proof,
    indexAddress: p.market.indexAddress,
    limits: p.limits,
    expiresAt: p.expiresAt,
    now: nowOf(d),
  });
  const unlocks = await d.wallet.sign(p.template, checked.ourInputs, (i) => {
    const inp = p.template.inputs[i];
    return keys.get(`${inp.txid}_${inp.vout}`);
  });
  // The pool's coins in this transaction: if another transaction spends one, this signature can never be used.
  const others = p.template.inputs
    .filter((_, i) => !checked.ourInputs.includes(i))
    .map((i) => ({ txid: i.txid, vout: i.vout }));
  return { unlocks, others };
}

/** The user said Allow: check again, sign only our inputs, submit. */
export async function executeTrade(d: Deps, p: Prepared): Promise<ExecuteResult> {
  const keys = new Map(p.coins.map((c) => [`${c.txid}_${c.vout}`, c.key]));
  let signedNow: { unlocks: Record<string, string>; others: Outpoint[] };
  try {
    signedNow = await checkAndSign(d, p, keys);
  } catch (e) {
    // Nothing from this sheet left the device. An earlier sheet's signature (p.signed) may still be live, so the BSV
    // goes back now only under the same rule as a close; otherwise the sweep returns it later.
    await releaseIfSafe(d, p, p.signed);
    throw e;
  }
  const { unlocks, others } = signedNow;
  const signed: SignedSpend[] = [
    ...(p.signed ?? []),
    { others, notBefore: Math.max(p.expiresAt, p.quoteExpiresAt) + UNSURE_MARGIN_MS },
  ];
  // Write the signature down BEFORE it goes to Memepool, so a funding with a live signature is never swept back. If
  // it can't be written, it is never sent.
  if (
    p.funding &&
    d.pending &&
    !safePut(d.pending, toRecord(p.funding, p.coins[0].satoshis, 'signed', nowOf(d), signed))
  ) {
    await releaseIfSafe(d, p, p.signed);
    plain("This wallet couldn't save a note it needs before sending the trade, so nothing was sent.");
  }
  let out: Record<string, unknown>;
  try {
    out = await submitTrade(d.fetch, { quoteId: p.quoteId, unlocks });
  } catch (e) {
    if (e instanceof MemepoolHttpError && e.status === 409) {
      // Stale. Our coins weren't spent. Re-prepare once from a fresh look at the coin; the user decides again.
      try {
        const m = await loadMarket(d, p.market.tokenId);
        const l = await limitsFor(d, m, p.side, p.amount, p.slippageBps);
        const r = await prepareAndVerify(d, m, p.side, p.amount, l, p.ord, p.pay, p.coins);
        const brokeMinimum =
          p.side === 'buy'
            ? r.checked.tokens < (p.limits as { minTokens: bigint }).minTokens
            : r.checked.sats < (p.limits as { minSats: bigint }).minSats;
        return { kind: 'new-sheet', brokeMinimum, prepared: { ...p, market: m, ...r, ...l, signed } };
      } catch (reload) {
        // The signature was handed over: the funding waits under the signed rule, timed from now.
        markFunding(d, p, 'unsure', signed);
        throw reload;
      }
    }
    if (e instanceof MemepoolHttpError && e.status >= 400 && e.status < 500) {
      // A definite refusal of THIS signature: nothing was broadcast. An earlier sheet's signature still follows the
      // close rule, so the BSV goes back now only if there is none (or it is dead).
      await releaseIfSafe(d, p, p.signed);
      plain(plainError(e));
    }
    markFunding(d, p, 'unsure', signed);
    return {
      kind: 'unsure',
      message: "We sent the trade but Memepool didn't confirm it. We're watching the network for it.",
    };
  }
  const txid = typeof out.txid === 'string' && /^[0-9a-f]{64}$/.test(out.txid) ? out.txid : null;
  markFunding(d, p, txid ? 'sent' : 'unsure', signed);
  if (!txid)
    return { kind: 'unsure', message: "Memepool took the trade but didn't say its id. We're watching for it." };
  return { kind: 'sent', txid };
}

/** Give a buy's funding back now if no signature over it can still be used (pending.ts giveBackIfSafe). */
async function releaseIfSafe(d: Deps, p: Prepared, signed: SignedSpend[] | undefined): Promise<boolean> {
  if (!p.funding) return false;
  return giveBackIfSafe(d.wallet, d.pending, wocChain(d), p.funding, signed, nowOf(d)).catch(() => false);
}

/** Every signature written down for this funding, plus any the sheet carries. */
function signedFor(d: Deps, p: Prepared): SignedSpend[] {
  if (!p.funding) return [];
  const id = idOf(p.funding.pay.derivationPrefix, p.funding.pay.derivationSuffix);
  let rec: SignedSpend[] = [];
  try {
    rec = d.pending?.list().find((r) => r.id === id)?.signed ?? [];
  } catch {
    /* unreadable store: only what the sheet carries */
  }
  return [...(p.signed ?? []), ...rec];
}

/**
 * The user said Cancel (or the sheet closed): a buy's set-aside BSV goes back into the wallet. After a 409 the sheet
 * is a fresh one but an earlier signature exists, so the close rule applies: no give-back while it may still be used.
 */
export async function cancelPrepared(d: Deps, p: Prepared): Promise<void> {
  if (!p.funding) return;
  const signed = signedFor(d, p);
  if (signed.length) {
    await releaseIfSafe(d, p, signed); // if still live, the record waits for the sweep
    return;
  }
  if (!(await giveBack(d.wallet, d.pending, p.funding))) throw new Error('The BSV could not be put back yet.');
}

/**
 * Record what became of a buy's funding after we signed. Never throws: the trade already went to Memepool, so a
 * storage failure here must not read as a failed trade (that invites a second buy). If it can't be written, the
 * 'signed' record written before the submit stays, which the sweep treats the same way.
 */
function markFunding(d: Deps, p: Prepared, state: 'unsure' | 'sent', signed: SignedSpend[]) {
  if (!p.funding || !d.pending) return;
  safePut(d.pending, toRecord(p.funding, p.coins[0].satoshis, state, nowOf(d), signed));
}

/**
 * The sheet closed after an unsure submit. Memepool may still hold our signed spend, so the BSV goes back only once
 * every signature over it is dead for good (another, confirmed transaction spent a pool coin it needs) and the later
 * quote expiry (ours, Memepool's) is UNSURE_MARGIN_MS behind us. Otherwise the record stays for the sweep.
 * Returns true if it went back.
 */
export async function closeUnsure(d: Deps, p: Prepared): Promise<boolean> {
  if (!p.funding) return false;
  const signed = signedFor(d, p);
  if (!signed.length) return false; // a submit happened, so a signature exists; without its record, never guess
  return releaseIfSafe(d, p, signed);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The network, as WhatsOnChain answers it. Its plain `/spent` checks confirmed and unconfirmed (mempool) spends in
 * one call; 404 = a known coin nothing spent, 400 = a coin it doesn't know (read as unknown). `/tx/hash` has a
 * blockhash and confirmations only once the transaction is in a block. `/address/../unspent/all` lists confirmed and
 * mempool coins, flagging ones a mempool transaction already spends (left out here).
 */
export function wocChain(d: Deps): Chain {
  const get = (path: string) => d.fetch(`${WOC}${path}`, { credentials: 'omit' }).catch(() => null);
  const json = async (r: Response) => (await r.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    async spentBy(o) {
      const r = await get(`/tx/${o.txid}/${o.vout}/spent`);
      if (!r) return 'unknown';
      if (r.ok) {
        const j = await json(r);
        return typeof j?.txid === 'string' && HEX64.test(j.txid) ? j.txid : 'unknown';
      }
      return r.status === 404 ? 'unspent' : 'unknown';
    },
    async tx(txid) {
      const r = await get(`/tx/hash/${txid}`);
      if (!r?.ok) return null;
      const j = await json(r);
      if (!j || !Array.isArray(j.vin)) return null;
      const confirmed = typeof j.blockhash === 'string' && j.blockhash.length > 0 && Number(j.confirmations) > 0;
      const inputs = (j.vin as { txid?: unknown; vout?: unknown }[])
        .filter((i) => typeof i?.txid === 'string' && Number.isInteger(i.vout))
        .map((i) => ({ txid: i.txid as string, vout: i.vout as number }));
      return { confirmed, inputs };
    },
    async unspentAt(address) {
      const r = await get(`/address/${address}/unspent/all`);
      if (!r?.ok) return null;
      const j = await json(r);
      if (!j || !Array.isArray(j.result) || j.error) return null;
      return (j.result as { tx_hash?: unknown; tx_pos?: unknown; value?: unknown; isSpentInMempoolTx?: unknown }[])
        .filter(
          (u) =>
            typeof u.tx_hash === 'string' &&
            HEX64.test(u.tx_hash) &&
            Number.isInteger(u.tx_pos) &&
            Number.isSafeInteger(u.value) &&
            (u.value as number) > 0 &&
            u.isSpentInMempoolTx !== true,
        )
        .map((u) => ({ txid: u.tx_hash as string, vout: u.tx_pos as number, satoshis: u.value as number }));
    },
  };
}

// A younger record may be a sheet open in another tab (signed records also wait for their own notBefore).
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

/** One sweep per store at a time: a second call while one runs (two tabs' worth, StrictMode) shares that run. */
const sweeping = new Map<unknown, Promise<SweepResult>>();

/** On start: put back any funding left over from a buy that never finished. */
export function sweepFundings(d: Deps): Promise<SweepResult> {
  const store = d.pending;
  if (!store) return Promise.resolve({ returned: 0, spent: 0, kept: 0 });
  const key = store.id ?? store;
  const running = sweeping.get(key);
  if (running) return running;
  const run = sweepPending(d.wallet, store, wocChain(d), { minAgeMs: SWEEP_MIN_AGE_MS, now: nowOf(d) }).finally(() =>
    sweeping.delete(key),
  );
  sweeping.set(key, run);
  return run;
}

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** Wait until the network knows `txid` (up to ~2 minutes). Never signs anything. */
export async function watchTx(d: Deps, txid: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await d.fetch(`${WOC}/tx/hash/${txid}`, { credentials: 'omit' }).catch(() => null);
    if (r?.ok) return true;
    await sleepOf(d)(3000);
  }
  return false;
}

/** After an unsure submit: which transaction (if any) spent our first coin. Never signs anything. */
export async function watchSpend(d: Deps, coin: { txid: string; vout: number }, tries = 40): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const r = await d.fetch(`${WOC}/tx/${coin.txid}/${coin.vout}/spent`, { credentials: 'omit' }).catch(() => null);
    if (r?.ok) {
      const j = (await r.json().catch(() => null)) as { txid?: unknown } | null;
      if (typeof j?.txid === 'string' && /^[0-9a-f]{64}$/.test(j.txid)) return j.txid;
    }
    await sleepOf(d)(3000);
  }
  return null;
}

export { DEFAULT_SLIPPAGE_BPS };

/** Why a funding is still waiting, in the words the Memepool screen shows. */
export type StuckReason = 'quote-running' | 'live-signature' | 'old-record' | 'not-returned';
export const STUCK_WHY: Record<StuckReason, string> = {
  'quote-running': "Memepool's price for this buy is still open. Wait a few minutes.",
  'live-signature':
    'Memepool may still hold your signed trade, so it can’t come back by itself until another trade on that coin. Recover now cancels the trade by moving the BSV back to your wallet.',
  'old-record':
    'Left from an earlier version that didn’t note the trade. Recover now moves the BSV back to your wallet.',
  'not-returned': 'This wallet couldn’t take it back by itself. Recover now moves the BSV back to your wallet.',
};
export type StuckFunding = { id: string; sats: number; reason: StuckReason; canRecover: boolean; waitUntil?: number };

/**
 * Fundings the sweep could not return (run it first): still unspent on the network, old enough not to be a sheet in
 * another tab, and this wallet's own. Only reads; nothing here spends. `canRecover` says whether "Recover now" may run.
 */
export async function stuckFundings(d: Deps): Promise<StuckFunding[]> {
  if (!d.pending) return [];
  const chain = wocChain(d);
  const now = nowOf(d);
  const out: StuckFunding[] = [];
  for (const r of d.pending.list()) {
    if (!r.funding || now - r.createdAt < SWEEP_MIN_AGE_MS) continue;
    const pay = await d.wallet.newPayKey({ prefix: r.prefix, suffix: r.suffix }).catch(() => null);
    const pkh = pay ? addressPkh(pay.address) : null;
    if (!pkh || parseP2pkh(r.funding.script) !== pkh) continue;
    if ((await chain.spentBy({ txid: r.funding.txid, vout: r.funding.vout }).catch(() => 'unknown')) !== 'unspent')
      continue;
    const base = { id: r.id, sats: r.funding.satoshis };
    if (r.state === 'pending') out.push({ ...base, reason: 'not-returned', canRecover: true });
    else if (!r.signed?.length) out.push({ ...base, reason: 'old-record', canRecover: true });
    else {
      const until = Math.max(...r.signed.map((x) => x.notBefore));
      out.push(
        now > until
          ? { ...base, reason: 'live-signature', canRecover: true }
          : { ...base, reason: 'quote-running', canRecover: false, waitUntil: until },
      );
    }
  }
  return out;
}

export type RecoverResult =
  /** The BSV is back in the wallet (its own change). */
  | { kind: 'recovered'; txid: string }
  /** Memepool's trade spent the coin first: the buy went through. */
  | { kind: 'went-through' };

/** What the Memepool screen says after "Recover now". */
export const recoverMessage = (r: RecoverResult): string =>
  r.kind === 'recovered'
    ? 'Done. The BSV is back in your wallet.'
    : "Memepool's trade went through first, so this buy happened. Its tokens come to your wallet.";

/** The wallet's broadcast refused our spend because the coin was already spent (WERR_REVIEW_ACTIONS doubleSpend). */
export const isDoubleSpend = (e: unknown): boolean =>
  !!(e as { reviewActionResults?: { status?: string }[] } | null)?.reviewActionResults?.some(
    (r) => r?.status === 'doubleSpend',
  ) || /double ?spend/i.test(e instanceof Error ? e.message : String(e));

/**
 * "Recover now", only ever from the user's tap on the approval sheet: spend the funding coin back to this wallet,
 * which double-spends any trade Memepool still holds. Refused while spending is paused (checked right before signing
 * and again before broadcast). Success drops the record; a double-spend refusal with the coin seen spent means
 * Memepool's trade won (record dropped); any other failure keeps the record and throws.
 */
export async function recoverNow(d: Deps, id: string): Promise<RecoverResult> {
  const r = d.pending?.list().find((x) => x.id === id);
  if (!d.pending || !r?.funding) plain('There is nothing to recover here any more.');
  const store = d.pending!;
  const funding = r!.funding!;
  if (r!.signed?.length && r!.signed.some((x) => !(nowOf(d) > x.notBefore)))
    plain("Memepool's price for this buy is still open. Try again in a few minutes.");
  const pay = await d.wallet.newPayKey({ prefix: r!.prefix, suffix: r!.suffix });
  if (parseP2pkh(funding.script) !== addressPkh(pay.address)) plain('That BSV isn’t held by this wallet account.');
  const chain = wocChain(d);
  const coin = { txid: funding.txid, vout: funding.vout };
  const before = await chain.spentBy(coin).catch(() => 'unknown' as const);
  if (before === 'unknown') plain("We can't check the network right now. Try again soon.");
  if (before !== 'unspent') {
    safeRemove(store, id);
    return { kind: 'went-through' };
  }
  const check = d.spendingCheck ?? (() => assertNotPaused('spending'));
  const f: Funding = {
    coin: { ...coin, satoshis: funding.satoshis, script: funding.script, key: pay.key },
    beef: [],
    pay,
  };
  try {
    const txid = await d.wallet.spendBack(f, { beforeSign: check, beforeBroadcast: check });
    safeRemove(store, id);
    return { kind: 'recovered', txid };
  } catch (e) {
    if (isDoubleSpend(e)) {
      const after = await chain.spentBy(coin).catch(() => 'unknown' as const);
      if (after !== 'unspent' && after !== 'unknown') {
        safeRemove(store, id);
        return { kind: 'went-through' };
      }
    }
    throw e;
  }
}
