/**
 * Money safety for BlastPad trades: the server proposes a plan (pool inputs + fixed outputs); before
 * the user is asked to confirm, and before anything is signed, the plan is rebuilt here from our own
 * curve maths and the pool's on-chain state (the pool coins in the plan's BEEF), and refused unless
 * every output is exactly what the curve and the fee rules allow. Nothing in the plan is trusted:
 * not its quote, not the board's `sold`, not the satoshis it claims for the pool inputs.
 */
import { Beef, P2PKH, Script, Utils } from '@bsv/sdk';
import { HOUSE_ADDRESS, MAX_INDEX_FEE, SUPPLY, exactBsv, exactTokens, quoteBuy, quoteSell, type Quote } from './curve';
import { bsv21 } from './tokens';
import type { TradePlan } from './shape';

export { HOUSE_ADDRESS, MAX_INDEX_FEE };
/** Dust the token coins add (1 sat each), the only slack allowed on top of amount + index fee. */
export const ALLOWANCE = BigInt(2);

export class PlanError extends Error {}
const refuse = (why: string): never => {
  throw new PlanError(`Refusing to sign: ${why}`);
};

/** One output as the user will see it before confirming. */
export type PlanRow = { what: string; to: string; sats: number; tokens?: bigint };
export type CheckedPlan = {
  quote: Quote; // our quote, at the pool's on-chain state
  sold: bigint; // tokens sold, from the pool's token coin
  indexFee: number;
  /** Total BSV that leaves the wallet for the plan's outputs (buy), or the pool's net payout (sell, negative). */
  net: bigint;
  rows: PlanRow[];
};

/** The `{"p":"bsv-20",…}` JSON of an inscription script (hex), if any. */
export function bsv20Json(hex: string): { op?: string; id?: string; amt?: string } | null {
  if (!hex || !hex.includes(Utils.toHex(Utils.toArray('bsv-20', 'utf8')))) return null;
  const text = Utils.toUTF8(Utils.toArray(hex, 'hex').map((b) => (b < 32 || b > 126 ? 32 : b)));
  const m = text.match(/\{"p":"bsv-20"[^}]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const p2pkhHex = (address: string) => new P2PKH().lock(address).toHex();
/** The address of a bare P2PKH script, or null. */
export const p2pkhAddress = (hex: string): string | null =>
  /^76a914[0-9a-f]{40}88ac$/.test(hex) ? Utils.toBase58Check(Utils.toArray(hex.slice(6, 46), 'hex'), [0]) : null;
/** The address of the P2PKH lock that ends an inscription script, or null. */
const trailingAddress = (hex: string): string | null => (hex.length > 50 ? p2pkhAddress(hex.slice(-50)) : null);

const isInt = (s: unknown) => typeof s === 'string' && /^\d+$/.test(s);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export type PlanContext = {
  side: 'buy' | 'sell';
  coinId: string;
  amount: bigint; // buy: sats to spend (fees included); sell: tokens
  /** The board's `sold`, which the user's on-screen quote was made from (slippage reference). */
  boardSold: bigint;
  slippageBps: number;
  /** Buy: the fresh address the tokens go to. */
  buyAddress?: string;
  /** The coin's route fee address when known (creator route); otherwise any P2PKH of the exact fee. */
  routeAddress?: string | null;
  /** Addresses of this wallet: no pool input may be locked to them. */
  mine?: string[];
};

/** Minimum fill for the slippage limit, from the quote the user was shown. */
export function minimums(side: 'buy' | 'sell', boardSold: bigint, amount: bigint, slippageBps: number) {
  const ref = side === 'buy' ? quoteBuy(boardSold, amount) : quoteSell(boardSold, amount);
  const keep = BigInt(10_000 - slippageBps);
  return {
    ref,
    minTokens: side === 'buy' ? (ref.tokens * keep) / BigInt(10_000) : BigInt(0),
    minSats: side === 'sell' ? (ref.userSats * keep) / BigInt(10_000) : BigInt(0),
  };
}

/**
 * Check the server's plan. Throws PlanError (message starts "Refusing to sign") on anything that is
 * not exactly the curve trade the user asked for; returns the checked quote and the rows to show.
 */
export function validatePlan(plan: TradePlan, ctx: PlanContext): CheckedPlan {
  const { side, coinId, amount } = ctx;
  if (!plan || typeof plan !== 'object') return refuse('no trade plan.');
  if (plan.side !== side) refuse('the plan is for the other side of the trade.');
  if (plan.tokenId !== coinId) refuse('the plan is for a different coin.');
  if (!Array.isArray(plan.inputs) || !Array.isArray(plan.outputs)) refuse('malformed plan.');
  if (plan.inputs.length < 1 || plan.inputs.length > 2) refuse('unexpected pool inputs.');
  if (side === 'sell' && plan.inputs.length !== 2) refuse('the pool has no BSV to pay you.');
  if (side === 'buy' && (!ctx.buyAddress || !/^1/.test(ctx.buyAddress))) refuse('no address for your tokens.');

  // The pool's state, from its coins (the plan's BEEF), not from anything the server says.
  let beef: Beef;
  try {
    beef = Beef.fromString(plan.beef, 'hex');
  } catch {
    return refuse('the pool history does not parse.');
  }
  const source = (outpoint: string) => {
    const m = /^([0-9a-f]{64})_(\d+)$/.exec(outpoint ?? '');
    if (!m) return refuse(`bad pool input ${outpoint}.`);
    const tx = beef.findTxid(m[1])?.tx;
    if (!tx || tx.id('hex') !== m[1]) return refuse('the pool history is missing.');
    const out = tx.outputs[Number(m[2])];
    if (!out) return refuse('the pool history is missing.');
    return { script: out.lockingScript.toHex(), sats: BigInt(out.satoshis ?? 0) };
  };
  const mine = new Set((ctx.mine ?? []).filter(Boolean));

  const tok = source(plan.inputs[0].outpoint);
  const j = bsv20Json(tok.script);
  const tokenAddr = trailingAddress(tok.script);
  const isPoolToken =
    !!j &&
    !!tokenAddr &&
    isInt(j.amt) &&
    ((j.op === 'transfer' && j.id === coinId && tok.script === bsv21(coinId, BigInt(j.amt!), tokenAddr).toHex()) ||
      (j.op === 'deploy+mint' && plan.inputs[0].outpoint === coinId));
  if (!isPoolToken) refuse('the first input is not this coin’s pool.');
  if (mine.has(tokenAddr!)) refuse('the plan spends your own coin as the pool’s.');
  const poolTokens = BigInt(j!.amt!);
  if (poolTokens > SUPPLY || tok.sats !== BigInt(1)) refuse('the pool’s token coin is not a curve pool.');

  let reserveAddr: string | null = null;
  let reserve = BigInt(0);
  if (plan.inputs.length === 2) {
    const r = source(plan.inputs[1].outpoint);
    reserveAddr = p2pkhAddress(r.script);
    if (!reserveAddr) refuse('the pool’s BSV input is not a plain coin.');
    if (mine.has(reserveAddr!)) refuse('the plan spends your own BSV as the pool’s.');
    reserve = r.sats;
  }
  plan.inputs.forEach((inp, i) => {
    const actual = i === 0 ? tok.sats : reserve;
    if (BigInt(inp.sats) !== actual) refuse(`pool input ${i} is worth ${actual} sats, not ${inp.sats}.`);
  });

  // Our quote at the pool's on-chain state; slippage against what the user was shown.
  const sold = SUPPLY - poolTokens;
  const q = side === 'buy' ? quoteBuy(sold, amount) : quoteSell(sold, amount);
  const { minTokens, minSats } = minimums(side, ctx.boardSold, amount, ctx.slippageBps);
  if (side === 'buy' && (q.tokens <= BigInt(0) || q.tokens < minTokens))
    refuse('the price moved past your slippage limit.');
  if (side === 'sell' && (q.tokens !== amount || q.userSats <= BigInt(0) || q.userSats < minSats))
    refuse('the price moved past your slippage limit.');

  // The server's quote must be ours, exactly.
  const pq = plan.quote ?? ({} as TradePlan['quote']);
  for (const k of ['tokens', 'curveSats', 'houseFee', 'routeFee', 'userSats', 'soldAfter'] as const) {
    if (String(pq[k]) !== q[k].toString()) refuse(`the server’s quote (${k}) does not match the curve.`);
  }
  const indexFee = pq.indexFee;
  if (!Number.isInteger(indexFee) || indexFee < 0 || indexFee > MAX_INDEX_FEE) refuse('the index fee is too high.');

  // Rebuild the fixed outputs. Fees go to known addresses with exact amounts; nothing else is allowed.
  type Want = { script: string | null; sats: bigint; what: string; to: string; tokens?: bigint };
  const want: Want[] = [];
  if (side === 'buy') {
    const to = ctx.buyAddress!;
    want.push({
      script: bsv21(coinId, q.tokens, to).toHex(),
      sats: BigInt(1),
      what: 'Tokens to you',
      to,
      tokens: q.tokens,
    });
    const rest = poolTokens - q.tokens;
    if (rest < BigInt(0)) refuse('the pool does not hold that many tokens.');
    if (rest > BigInt(0))
      want.push({
        script: bsv21(coinId, rest, tokenAddr!).toHex(),
        sats: BigInt(1),
        what: 'Rest of the tokens back to the pool',
        to: tokenAddr!,
        tokens: rest,
      });
    const addr = reserveAddr ?? null;
    if (!addr && reserve !== BigInt(0)) refuse('the pool’s BSV is missing.');
    want.push({
      script: addr ? p2pkhHex(addr) : null,
      sats: reserve + q.curveSats,
      what: 'BSV into the pool',
      to: addr ?? '',
    });
  } else {
    want.push({
      script: bsv21(coinId, poolTokens + q.tokens, tokenAddr!).toHex(),
      sats: BigInt(1),
      what: 'Your tokens into the pool',
      to: tokenAddr!,
      tokens: poolTokens + q.tokens,
    });
    if (reserve < q.curveSats) refuse('the pool holds less BSV than this sell pays.');
    want.push({
      script: p2pkhHex(reserveAddr!),
      sats: reserve - q.curveSats,
      what: 'The pool’s BSV after paying you',
      to: reserveAddr!,
    });
  }
  if (q.houseFee > BigInt(0))
    want.push({
      script: p2pkhHex(HOUSE_ADDRESS),
      sats: q.houseFee,
      what: 'TokenBlaster fee (0.70%)',
      to: HOUSE_ADDRESS,
    });
  if (q.routeFee > BigInt(0))
    want.push({
      script: ctx.routeAddress ? p2pkhHex(ctx.routeAddress) : null,
      sats: q.routeFee,
      what: 'Coin route fee (0.30%)',
      to: ctx.routeAddress ?? '',
    });

  const outs = plan.outputs;
  const rows: PlanRow[] = [];
  let i = 0;
  for (; i < want.length; i++) {
    const w = want[i];
    const o = outs[i];
    if (!o) refuse(`output ${i} (${w.what}) is missing.`);
    if (!Number.isSafeInteger(o.sats) || BigInt(o.sats) !== w.sats)
      refuse(`output ${i} (${w.what}) is ${o.sats} sats, expected ${w.sats}.`);
    let to = w.to;
    if (w.script === null) {
      // Pool reserve on a first buy / a vault route: any plain P2PKH that isn't ours.
      const a = p2pkhAddress(o.script);
      if (!a) refuse(`output ${i} (${w.what}) is not a plain payment.`);
      if (mine.has(a!)) refuse(`output ${i} (${w.what}) has the wrong recipient.`);
      to = a!;
    } else if (o.script !== w.script) {
      if (i === 0 && side === 'buy') {
        const jj = bsv20Json(o.script);
        if (!jj || jj.id !== coinId) refuse('the tokens in output 0 are not this coin.');
        if (!isInt(jj!.amt) || BigInt(jj!.amt!) < minTokens) refuse('output 0 carries fewer tokens than your minimum.');
        refuse('output 0 does not send the tokens to your wallet.');
      }
      refuse(`output ${i} (${w.what}) has the wrong script or recipient.`);
    }
    rows.push({ what: w.what, to, sats: o.sats, ...(w.tokens !== undefined ? { tokens: w.tokens } : {}) });
  }
  // Optional last output: the token's index fund, capped and exactly the quoted index fee.
  if (outs.length > i) {
    const o = outs[i];
    const a = p2pkhAddress(o.script);
    if (!a || mine.has(a)) refuse('the index fee output is not a plain payment.');
    if (o.sats !== indexFee) refuse(`the index fee output is ${o.sats} sats, quoted ${indexFee}.`);
    rows.push({ what: 'Token index fund', to: a!, sats: o.sats });
    i++;
  } else if (indexFee !== 0) refuse('the index fee is quoted but not paid.');
  if (outs.length !== i) refuse(`the plan has ${outs.length - i} unexpected output(s).`);

  // Total BSV the wallet funds for the fixed outputs, net of the pool's inputs.
  const outSum = outs.reduce((n, o) => n + BigInt(o.sats), BigInt(0));
  const net = outSum - tok.sats - reserve;
  if (side === 'buy' && net > amount + BigInt(indexFee) + ALLOWANCE)
    refuse(`the trade would take ${exactBsv(net)} from your wallet, more than ${exactBsv(amount)} + index fee.`);
  if (side === 'sell' && -net + BigInt(indexFee) < q.userSats) refuse('the pool does not release your payout.');
  return { quote: q, sold, indexFee, net, rows };
}

/** The P2PKH payout the client adds to a sell (to the user's own address). */
export const payoutOutput = (address: string, sats: bigint) => ({ script: p2pkhHex(address), sats });

/**
 * After the wallet built the transaction: a sell must pay at least `minSats` to the user's own
 * address (a P2PKH output), on top of the plan's fixed outputs.
 */
export function checkSellPayout(
  outputs: { lockingScript: Script; satoshis?: number }[],
  fixed: number,
  address: string,
  minSats: bigint,
): boolean {
  const lock = p2pkhHex(address);
  return outputs.slice(fixed).some((o) => o.lockingScript.toHex() === lock && BigInt(o.satoshis ?? 0) >= minSats);
}

export const describeRow = (r: PlanRow, sym: string) =>
  r.tokens !== undefined
    ? `${exactTokens(r.tokens)} $${sym} → ${short(r.to)}`
    : `${exactBsv(BigInt(r.sats))} → ${r.to ? short(r.to) : '?'}`;
