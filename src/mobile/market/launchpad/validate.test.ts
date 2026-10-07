import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { Beef, P2PKH, PrivateKey, Script, Transaction, type WalletInterface } from '@bsv/sdk';
import { SUPPLY, poolSats, quoteBuy, quoteSell } from './curve';
import { bsv21 } from './tokens';
import type { TradePlan } from './shape';
import { HOUSE_ADDRESS, checkSellPayout, minimums, payoutOutput, validatePlan, type PlanContext } from './validate';
import { trade } from './client';
import { CURVE_COINS_ENABLED, STORE_BUILD } from '../../storeBuild';

const COIN = `${'ab'.repeat(32)}_1`;
const addr = () => PrivateKey.fromRandom().toAddress();
const TOKEN_ADDR = addr();
const RESERVE_ADDR = addr();
const FUND_ADDR = addr();
const ROUTE_ADDR = addr();
const ME = addr();
const BUY_TO = addr();
const p2pkh = (a: string) => new P2PKH().lock(a).toHex();

const SOLD = BigInt(96_657_870);
const RESERVE = poolSats(SOLD);

/** A pool with SOLD tokens out, and a plan built the way the honest server builds it. */
function honest(side: 'buy' | 'sell', amount: bigint, opts: { reserve?: boolean } = {}) {
  const withReserve = opts.reserve ?? true;
  const src = new Transaction();
  src.addOutput({ lockingScript: bsv21(COIN, SUPPLY - SOLD, TOKEN_ADDR), satoshis: 1 });
  if (withReserve) src.addOutput({ lockingScript: Script.fromHex(p2pkh(RESERVE_ADDR)), satoshis: Number(RESERVE) });
  const beef = new Beef();
  beef.mergeTransaction(src);
  const txid = src.id('hex');
  const reserve = withReserve ? RESERVE : BigInt(0);
  const q = side === 'buy' ? quoteBuy(SOLD, amount) : quoteSell(SOLD, amount);
  const inputs: TradePlan['inputs'] = [{ outpoint: `${txid}_0`, sats: 1, what: 'pool tokens' }];
  if (withReserve) inputs.push({ outpoint: `${txid}_1`, sats: Number(RESERVE), what: 'pool BSV' });
  const outputs: TradePlan['outputs'] = [];
  const tokenAmt = SUPPLY - SOLD;
  if (side === 'buy') {
    outputs.push({ script: bsv21(COIN, q.tokens, BUY_TO).toHex(), sats: 1, what: 'to you' });
    outputs.push({ script: bsv21(COIN, tokenAmt - q.tokens, TOKEN_ADDR).toHex(), sats: 1, what: 'rest' });
    outputs.push({ script: p2pkh(RESERVE_ADDR), sats: Number(reserve + q.curveSats), what: 'BSV into the pool' });
  } else {
    outputs.push({ script: bsv21(COIN, tokenAmt + q.tokens, TOKEN_ADDR).toHex(), sats: 1, what: 'into pool' });
    outputs.push({ script: p2pkh(RESERVE_ADDR), sats: Number(reserve - q.curveSats), what: 'pool after' });
  }
  outputs.push({ script: p2pkh(HOUSE_ADDRESS), sats: Number(q.houseFee), what: 'house' });
  outputs.push({ script: p2pkh(ROUTE_ADDR), sats: Number(q.routeFee), what: 'route' });
  outputs.push({ script: p2pkh(FUND_ADDR), sats: 2000, what: 'index' });
  const plan: TradePlan = {
    lease: 'lease-1',
    side,
    tokenId: COIN,
    sym: 'TEST',
    inputs,
    outputs,
    beef: beef.toHex(),
    quote: {
      tokens: q.tokens.toString(),
      curveSats: q.curveSats.toString(),
      houseFee: q.houseFee.toString(),
      routeFee: q.routeFee.toString(),
      userSats: q.userSats.toString(),
      soldAfter: q.soldAfter.toString(),
      indexFee: 2000,
    },
    expires: Date.now() + 90_000,
  };
  const ctx: PlanContext = {
    side,
    coinId: COIN,
    amount,
    boardSold: SOLD,
    slippageBps: 300,
    buyAddress: side === 'buy' ? BUY_TO : undefined,
    routeAddress: ROUTE_ADDR,
    mine: [ME],
  };
  return { plan, ctx, q };
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const BUY = BigInt(1_000_000);
const SELL = BigInt(10_000_000);

describe('validatePlan: accepts the honest plan', () => {
  test('buy', () => {
    const { plan, ctx, q } = honest('buy', BUY);
    const c = validatePlan(plan, ctx);
    expect(c.quote.tokens).toBe(q.tokens);
    expect(c.sold).toBe(SOLD);
    expect(c.rows.length).toBe(plan.outputs.length);
    expect(c.rows[0].to).toBe(BUY_TO);
    expect(c.net <= BUY + BigInt(2000) + BigInt(2)).toBe(true);
  });
  test('sell', () => {
    const { plan, ctx, q } = honest('sell', SELL);
    const c = validatePlan(plan, ctx);
    expect(c.quote.userSats).toBe(q.userSats);
    expect(-c.net + BigInt(2000)).toBe(q.userSats);
  });
  test('first buy (no pool BSV input yet), vault route (unknown address)', () => {
    const { plan, ctx } = honest('buy', BUY, { reserve: false });
    expect(() => validatePlan(plan, { ...ctx, routeAddress: null })).not.toThrow();
  });
});

describe('validatePlan: refuses malicious plans', () => {
  const bad = (side: 'buy' | 'sell', mutate: (p: TradePlan, c: PlanContext) => void, msg: RegExp) => {
    const { plan, ctx } = honest(side, side === 'buy' ? BUY : SELL);
    const p = clone(plan);
    const c = { ...ctx };
    mutate(p, c);
    expect(() => validatePlan(p, c)).toThrow(msg);
  };
  test('extra output', () =>
    bad('buy', (p) => p.outputs.push({ script: p2pkh(addr()), sats: 50_000, what: 'tip' }), /unexpected output/));
  test('extra output on a sell', () =>
    bad('sell', (p) => p.outputs.push({ script: p2pkh(addr()), sats: 1, what: 'x' }), /unexpected output/));
  test('inflated house fee', () =>
    bad('buy', (p) => (p.outputs[3].sats += 10_000), /output 3/));
  test('house fee to another address', () =>
    bad('buy', (p) => (p.outputs[3].script = p2pkh(addr())), /wrong script or recipient/));
  test('route fee to another address', () =>
    bad('sell', (p) => (p.outputs[3].script = p2pkh(addr())), /wrong script or recipient/));
  test('inflated index fee (over the cap)', () =>
    bad('buy', (p) => {
      p.outputs[5].sats = 50_000;
      p.quote.indexFee = 50_000;
    }, /index fee is too high/));
  test('index fee not as quoted', () => bad('buy', (p) => (p.outputs[5].sats = 4000), /index fee output/));
  test('inflated BSV into the pool', () => bad('buy', (p) => (p.outputs[2].sats += 100_000), /output 2/));
  test('wrong token amount to the buyer', () =>
    bad('buy', (p) => {
      const q = BigInt(p.quote.tokens) / BigInt(2);
      p.outputs[0].script = bsv21(COIN, q, BUY_TO).toHex();
    }, /fewer tokens than your minimum/));
  test('slightly fewer tokens (within slippage) still not the curve amount', () =>
    bad('buy', (p) => {
      p.outputs[0].script = bsv21(COIN, BigInt(p.quote.tokens) - BigInt(1), BUY_TO).toHex();
    }, /output 0 does not send the tokens to your wallet/));
  test('wrong token id', () =>
    bad('buy', (p) => {
      p.outputs[0].script = bsv21(`${'cd'.repeat(32)}_0`, BigInt(p.quote.tokens), BUY_TO).toHex();
    }, /not this coin/));
  test('tokens to another recipient', () =>
    bad('buy', (p) => {
      p.outputs[0].script = bsv21(COIN, BigInt(p.quote.tokens), addr()).toHex();
    }, /not send the tokens to your wallet/));
  test('short sell payout (pool keeps more BSV)', () => bad('sell', (p) => (p.outputs[1].sats += 50_000), /output 1/));
  test('quote mismatch (tokens)', () =>
    bad('buy', (p) => (p.quote.tokens = (BigInt(p.quote.tokens) + BigInt(1)).toString()), /quote \(tokens\)/));
  test('quote mismatch (userSats)', () =>
    bad('sell', (p) => (p.quote.userSats = (BigInt(p.quote.userSats) - BigInt(1)).toString()), /quote \(userSats\)/));
  test('board sold faked low: on-chain fill worse than the slippage limit', () =>
    bad('buy', (_p, c) => (c.boardSold = BigInt(0)), /slippage/));
  test('pool input sats misreported', () => bad('sell', (p) => (p.inputs[1].sats += 1), /pool input 1/));
  test('pool input is the user own coin', () =>
    bad('sell', (_p, c) => (c.mine = [RESERVE_ADDR]), /your own BSV/));
  test('different coin', () => bad('buy', (p) => (p.tokenId = `${'cd'.repeat(32)}_0`), /different coin/));
  test('other side', () => bad('buy', (p) => (p.side = 'sell'), /other side/));
  test('missing output', () => bad('sell', (p) => p.outputs.splice(2, 1), /output 2|output 3/));
});

describe('sell payout', () => {
  test('needs a P2PKH to the user with at least minSats', () => {
    const fixed = 5;
    const pad = Array.from({ length: fixed }, () => ({ lockingScript: Script.fromHex(p2pkh(addr())), satoshis: 1 }));
    const pay = payoutOutput(ME, BigInt(5000));
    const ok = [...pad, { lockingScript: Script.fromHex(pay.script), satoshis: 5000 }];
    expect(checkSellPayout(ok, fixed, ME, BigInt(5000))).toBe(true);
    expect(checkSellPayout(ok, fixed, ME, BigInt(5001))).toBe(false);
    const elsewhere = [...pad, { lockingScript: Script.fromHex(p2pkh(addr())), satoshis: 5000 }];
    expect(checkSellPayout(elsewhere, fixed, ME, BigInt(1))).toBe(false);
  });
  test('minimums follow the shown quote', () => {
    const m = minimums('sell', SOLD, SELL, 300);
    expect(m.minSats).toBe((m.ref.userSats * BigInt(9700)) / BigInt(10_000));
  });
});

describe('trade() refuses a malicious server plan before the wallet signs anything', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const run = async (mutate: (p: TradePlan) => void) => {
    const { plan } = honest('buy', BUY);
    const steps: string[] = [];
    let created = 0;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      steps.push(b.step);
      if (b.step !== 'prepare') return new Response('{}');
      const p = clone(plan);
      // The plan's buyer output must be to the fresh key the client asked for.
      p.outputs[0].script = bsv21(COIN, BigInt(p.quote.tokens), b.to).toHex();
      mutate(p);
      return new Response(JSON.stringify({ plan: p }));
    }) as unknown as typeof fetch;
    const pub = PrivateKey.fromRandom().toPublicKey().toString();
    const client = {
      getPublicKey: async () => ({ publicKey: pub }),
      createAction: async () => {
        created++;
        throw new Error('should not be reached');
      },
    } as unknown as WalletInterface;
    const err = await trade({ client, address: ME, publicKey: pub }, { id: COIN, sym: 'TEST', routeAddress: ROUTE_ADDR }, 'buy', BUY, SOLD, 300).then(
      () => null,
      (e: Error) => e,
    );
    return { err, created, steps };
  };
  test('extra output: refused, pool released, wallet never asked', async () => {
    const r = await run((p) => p.outputs.push({ script: p2pkh(addr()), sats: 99_999, what: 'x' }));
    expect(r.err?.message).toMatch(/Refusing to sign/);
    expect(r.created).toBe(0);
    expect(r.steps).toEqual(['prepare', 'cancel']);
  });
  test('inflated fee: refused', async () => {
    const r = await run((p) => (p.outputs[3].sats *= 2));
    expect(r.err?.message).toMatch(/Refusing to sign/);
    expect(r.created).toBe(0);
  });
  test('honest plan reaches the wallet', async () => {
    const r = await run(() => undefined);
    expect(r.created).toBe(1);
    expect(r.err?.message).toBe('should not be reached');
  });
});

describe('CURVE_COINS_ENABLED gating', () => {
  test('is the inverse of STORE_BUILD in this build', () => {
    expect(CURVE_COINS_ENABLED).toBe(!STORE_BUILD);
  });
  test('derives from the same env as STORE_BUILD', () => {
    const src = readFileSync(new URL('../../storeBuild.ts', import.meta.url), 'utf8');
    const cond = (name: string) => {
      const m = new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(src);
      return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
    };
    expect(cond('STORE_BUILD')).toContain("import.meta.env.VITE_STORE_BUILD === '1'");
    expect(cond('CURVE_COINS_ENABLED')).toBe(cond('STORE_BUILD'));
  });
  test('the market only loads the panel behind the flag', () => {
    const src = readFileSync(new URL('../MarketPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('const CurvePanel = CURVE_COINS_ENABLED ? lazy(loadCurvePanel) : null;');
  });
});
