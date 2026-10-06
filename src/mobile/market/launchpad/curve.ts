/** Ported verbatim from tokenblaster.lol src/lib/launch/curve.ts (BlastPad bonding curve). Keep in sync. */
/**
 * The bonding curve, shared by the browser (quotes, the "how it works" slider) and the server
 * (which builds and checks every trade). Integer maths only: sats and whole tokens are bigints.
 *
 * Constant product on virtual reserves: (V0 + bsv in pool) × (T0 − tokens sold) = V0 × T0.
 * A coin starts at 1 BSV virtual / 1.073B virtual tokens (≈0.093 sats a token, ≈0.93 BSV market
 * cap) and graduates when 793.1M tokens are sold (≈2.83 BSV in the pool, ≈1.37 sats a token).
 * After graduation it keeps trading on the same curve: the pool is permanent liquidity.
 */
export const SUPPLY = BigInt(1_000_000_000); // tokens minted into the pool at launch, 0 decimals
export const V0 = BigInt(100_000_000); // virtual BSV reserve, sats
export const T0 = BigInt(1_073_000_000); // virtual token reserve
export const K = V0 * T0;
export const GRAD_SOLD = BigInt(793_100_000);

/** Fees, in basis points of the BSV side of a trade. */
export const HOUSE_BPS = BigInt(70); // 0.70% to TokenBlaster
export const ROUTE_BPS = BigInt(30); // 0.30% to the coin's route (creator, split, holders, buyback)
export const LAUNCH_FEE = 25_000; // sats, once, in the launch transaction
export const INDEX_FEE = 1_000; // sats per token output, to the token's GorillaPool fund address
/**
 * Paid in the launch transaction and forwarded to the token's GorillaPool fund once the indexer has
 * seen the deploy. GorillaPool only indexes ("includes") a BSV-21 token whose fund has reached 0.1 BSV;
 * until then wallets can't see its transfers and BlastPad can't verify sells.
 */
export const INDEX_THRESHOLD = 10_000_000; // GorillaPool includes a token once its fund reaches this (exactly)
export const INDEX_LAUNCH = INDEX_THRESHOLD + 1_000; // plus the network fee of forwarding it, so the fund lands at ≥ 0.1 BSV
export const MIN_BUY = 10_000; // sats (0.0001 BSV)
export const MAX_BUY = 2_000_000_000; // sats (20 BSV)

const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;
const fee = (sats: bigint, bps: bigint) => (sats * bps) / BigInt(10_000);

/** BSV in the pool (sats) when `sold` tokens are out of it. */
export const poolSats = (sold: bigint) => ceilDiv(K, T0 - sold) - V0;

/** Price of one token in sats at `sold`, as a float for display. */
export const price = (sold: bigint) => Number(V0 + poolSats(sold)) / Number(T0 - sold);

/** Market cap in sats (whole supply at the current price). */
export const marketCap = (sold: bigint) => price(sold) * Number(SUPPLY);

export const progress = (sold: bigint) => Math.min(1, Number(sold) / Number(GRAD_SOLD));

export type Quote = {
  side: 'buy' | 'sell';
  tokens: bigint; // tokens the buyer gets / the seller gives
  curveSats: bigint; // sats into (buy) or out of (sell) the pool
  houseFee: bigint;
  routeFee: bigint;
  /** Buy: sats the buyer pays in total (before network/index fees). Sell: sats the seller receives. */
  userSats: bigint;
  soldAfter: bigint;
};

/** Spend `spend` sats (fees included) on tokens at `sold`. */
export function quoteBuy(sold: bigint, spend: bigint): Quote {
  const house = fee(spend, HOUSE_BPS);
  const route = fee(spend, ROUTE_BPS);
  const net = spend - house - route;
  const vNow = V0 + poolSats(sold);
  const tNow = T0 - sold;
  // Tokens out such that the pool still satisfies the invariant (rounded in the pool's favour).
  let tokens = tNow - ceilDiv(K, vNow + net);
  const left = SUPPLY - sold;
  if (tokens > left) tokens = left;
  if (tokens < BigInt(0)) tokens = BigInt(0);
  const curveSats = poolSats(sold + tokens) - poolSats(sold);
  return {
    side: 'buy',
    tokens,
    curveSats,
    houseFee: house,
    routeFee: route,
    userSats: curveSats + house + route,
    soldAfter: sold + tokens,
  };
}

/** Sell `tokens` back into the pool at `sold`. */
export function quoteSell(sold: bigint, tokens: bigint): Quote {
  if (tokens > sold) tokens = sold;
  const curveSats = poolSats(sold) - poolSats(sold - tokens);
  const house = fee(curveSats, HOUSE_BPS);
  const route = fee(curveSats, ROUTE_BPS);
  return {
    side: 'sell',
    tokens,
    curveSats,
    houseFee: house,
    routeFee: route,
    userSats: curveSats - house - route,
    soldAfter: sold - tokens,
  };
}

/** Exact, unrounded amounts for confirmations and wallet descriptions: `0.00012345 BSV (12,345 sats)`. */
export const exactBsv = (sats: bigint) => {
  const neg = sats < BigInt(0);
  const a = neg ? -sats : sats;
  const whole = a / BigInt(100_000_000);
  const frac = (a % BigInt(100_000_000)).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac} BSV (${sats.toLocaleString('en-US')} sats)`;
};
/** Exact token count with thousands separators, e.g. `12,345,678`. */
export const exactTokens = (t: bigint) => t.toLocaleString('en-US');

/** Tokens per BSV etc. for display. */
export const fmtSats = (s: number | bigint) => {
  const n = Number(s) / 1e8;
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3);
};
export const fmtTokens = (t: number | bigint) => {
  const n = Number(t);
  return n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : `${n}`;
};
