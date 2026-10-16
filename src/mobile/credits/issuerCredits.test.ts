import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { P2PKH } from '@bsv/sdk';
import {
  QuoteError,
  buildSpend,
  claimDelayMs,
  claimOutcome,
  claimWithRetry,
  memoScriptHex,
  nextSpent,
  parseHistory,
  parsePaused,
  isUnavailable,
  historyAmount,
  parseIssuers,
  parseQuote,
  quoteSummary,
  tickValue,
  tokenSpendProblem,
  topUpAccepts,
  withExtraOutputs,
  type IssuerAccept,
} from './issuerCredits';

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ADDR2 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const PNEE = '1599c4e49a28c7791295f50613e1545aa9246dd592ae8b8f696b81916a475ae4_0';
const MNEE = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0';
const NOW = 1_800_000_000_000;

const issuersBody = {
  issuers: [
    { id: 'bcredits', name: 'bCredits', builtin: true, accepts: [], topup_enabled: true },
    {
      id: 'mandala',
      name: 'Mandala',
      handle: '$mandala',
      builtin: false,
      payee_address: ADDR,
      topup_enabled: true,
      accepts: [
        { asset: 'BSV', decimals: 8, token_id: null, price_atomic: 100, price_per_credit: '0.000001' },
        { asset: 'MNEE', decimals: 5, token_id: MNEE, price_atomic: 1000, price_per_credit: '0.01' },
        { asset: 'PNEE', decimals: 0, token_id: PNEE, price_atomic: '1', price_per_credit: '1' },
        { asset: 'DOGE', price_atomic: 1 },
      ],
    },
    { id: 'bad id!', name: 'x' },
  ],
};

const issuer = parseIssuers(issuersBody)[0];
const bsv = issuer.accepts.find((a) => a.asset === 'BSV') as IssuerAccept;
const pnee = issuer.accepts.find((a) => a.asset === 'PNEE') as IssuerAccept;

describe('parseIssuers', () => {
  test('skips the built-in bCredits and malformed rows; drops unknown assets', () => {
    const list = parseIssuers(issuersBody);
    expect(list.map((i) => i.id)).toEqual(['mandala']);
    expect(issuer.handle).toBe('mandala');
    expect(issuer.accepts.map((a) => a.asset)).toEqual(['BSV', 'MNEE', 'PNEE']);
    expect(pnee.priceAtomic).toBe(1n);
  });
  test('MNEE top-ups are hidden; none when top-ups are off', () => {
    expect(topUpAccepts(issuer).map((a) => a.asset)).toEqual(['BSV', 'PNEE']);
    expect(topUpAccepts({ ...issuer, topupEnabled: false })).toEqual([]);
  });
  test('garbage in, nothing out', () => {
    expect(parseIssuers(null)).toEqual([]);
    expect(parseIssuers({ issuers: 'x' })).toEqual([]);
  });
});

const bsvQuote = {
  quote_id: 'q1',
  outputs: [
    { type: 'p2pkh', address: ADDR, satoshis: 45_000 },
    { type: 'p2pkh', address: ADDR2, satoshis: 5_000 },
  ],
  memo_hex: 'deadbeef',
  expires_at: new Date(NOW + 60_000).toISOString(),
};

describe('parseQuote', () => {
  test('a BSV quote at the listed price', () => {
    const q = parseQuote(bsvQuote, { asset: 'BSV', accept: bsv, credits: 500 }, NOW);
    expect(q.outputs).toHaveLength(2);
    expect(q.expiresAt).toBe(NOW + 60_000);
  });
  test('refuses more than the listed price', () => {
    expect(() => parseQuote(bsvQuote, { asset: 'BSV', accept: bsv, credits: 100 }, NOW)).toThrow(QuoteError);
  });
  test('refuses an expired quote, a bad memo, an unknown output kind', () => {
    const ctx = { asset: 'BSV' as const, accept: bsv, credits: 500 };
    expect(() => parseQuote({ ...bsvQuote, expires_at: NOW - 1 }, ctx, NOW)).toThrow('expired');
    expect(() => parseQuote({ ...bsvQuote, memo_hex: 'xyz' }, ctx, NOW)).toThrow(QuoteError);
    expect(() => parseQuote({ ...bsvQuote, outputs: [{ type: 'script', address: ADDR }] }, ctx, NOW)).toThrow(
      QuoteError,
    );
    expect(() =>
      parseQuote({ ...bsvQuote, outputs: [{ type: 'p2pkh', address: 'nope', satoshis: 1 }] }, ctx, NOW),
    ).toThrow(QuoteError);
  });
  test('a PNEE quote must pay the accepted token, within price', () => {
    const ctx = { asset: 'PNEE' as const, accept: pnee, credits: 100 };
    const good = {
      quote_id: 'q2',
      outputs: [{ type: 'bsv21', token_id: PNEE, address: ADDR, amount_atomic: '100' }],
      memo_hex: 'ab',
      expires_at: (NOW + 60_000) / 1000,
    };
    expect(parseQuote(good, ctx, NOW).outputs[0]).toMatchObject({ kind: 'bsv21', amountAtomic: 100n });
    const other = { ...good, outputs: [{ type: 'bsv21', token_id: MNEE, address: ADDR, amount_atomic: '100' }] };
    expect(() => parseQuote(other, ctx, NOW)).toThrow('different token');
    const dear = { ...good, outputs: [{ type: 'bsv21', token_id: PNEE, address: ADDR, amount_atomic: '500' }] };
    expect(() => parseQuote(dear, ctx, NOW)).toThrow('listed price');
  });
});

describe('quote → transaction', () => {
  test('memo output is OP_FALSE OP_RETURN <memo>', () => {
    expect(memoScriptHex('deadbeef')).toBe('006a04deadbeef');
    expect(memoScriptHex('ab'.repeat(100))).toBe(`006a4c64${'ab'.repeat(100)}`);
  });

  test('BSV: every P2PKH output, then the memo', () => {
    const q = parseQuote(bsvQuote, { asset: 'BSV', accept: bsv, credits: 500 }, NOW);
    const s = buildSpend(q, bsv);
    expect(s).toEqual({
      kind: 'bsv',
      requests: [
        { address: ADDR, satoshis: 45_000 },
        { address: ADDR2, satoshis: 5_000 },
        { script: '006a04deadbeef', satoshis: 0 },
      ],
    });
  });

  test('PNEE: token recipients, then side P2PKH outputs and the memo appended to createAction', async () => {
    const q = parseQuote(
      {
        quote_id: 'q3',
        outputs: [
          { type: 'bsv21', token_id: PNEE, address: ADDR, amount_atomic: '90' },
          { type: 'bsv21', token_id: PNEE, address: ADDR2, amount_atomic: '10' },
          { type: 'p2pkh', address: ADDR2, satoshis: 500 },
        ],
        memo_hex: 'cafe',
        expires_at: NOW + 60_000,
      },
      { asset: 'PNEE', accept: pnee, credits: 100 },
      NOW,
    );
    const s = buildSpend(q, pnee);
    if (s.kind !== 'bsv21') throw new Error('want bsv21');
    expect(s.tokenId).toBe(PNEE);
    expect(s.recipients).toEqual([
      { amount: 90n, destination: { address: ADDR } },
      { amount: 10n, destination: { address: ADDR2 } },
    ]);
    const p2 = new P2PKH().lock(ADDR2).toHex();
    expect(s.extraOutputs.map((o) => [o.lockingScript, o.satoshis])).toEqual([
      [p2, 500],
      ['006a02cafe', 0],
    ]);

    // The wrapped wallet appends them once, after sendBsv21's own outputs.
    const seen: unknown[][] = [];
    const wallet = { createAction: async (a: { outputs: unknown[] }) => (seen.push(a.outputs), { txid: 't' }) };
    const w = withExtraOutputs(wallet, s.extraOutputs);
    await w.createAction({ outputs: [{ lockingScript: 'tok', satoshis: 1 }] });
    await w.createAction({ outputs: [] });
    expect(seen[0]).toHaveLength(3);
    expect((seen[0][2] as { lockingScript: string }).lockingScript).toBe('006a02cafe');
    expect(seen[1]).toHaveLength(0);

    // Guard: quote outputs + 1-sat token outputs + one confirmed fee pass; anything else stops it.
    const fee = { feeScript: new P2PKH().lock(ADDR).toHex(), maxSats: 300 };
    const outs = [
      { lockingScript: 'tok1', satoshis: 1 },
      { lockingScript: 'tok2', satoshis: 1 },
      ...s.extraOutputs,
      { lockingScript: fee.feeScript, satoshis: 200 },
    ];
    expect(tokenSpendProblem(outs, s.extraOutputs, fee)).toBeNull();
    expect(tokenSpendProblem([...outs, { lockingScript: 'x', satoshis: 99 }], s.extraOutputs, fee)).not.toBeNull();
    expect(tokenSpendProblem(outs.slice(0, 2), s.extraOutputs, fee)).toContain('missing');
    expect(tokenSpendProblem(outs, s.extraOutputs, null)).not.toBeNull();
  });

  test('summary lists every output and the total', () => {
    const q = parseQuote(bsvQuote, { asset: 'BSV', accept: bsv, credits: 500 }, NOW);
    const sum = quoteSummary(q, bsv);
    expect(sum.lines).toHaveLength(2);
    expect(sum.total).toBe('50,000 sats');
  });
});

describe('claim', () => {
  test('outcomes', () => {
    expect(claimOutcome(200, { credited: 500, balance: 900 })).toEqual({ kind: 'credited', balance: 900 });
    expect(claimOutcome(202, { code: 'not_indexed' })).toEqual({ kind: 'retry' });
    expect(claimOutcome(503, {})).toEqual({ kind: 'retry' });
    for (const s of [402, 409, 422]) expect(claimOutcome(s, { error: 'x', code: 'z' }).kind).toBe('failed');
    expect(claimOutcome(409, { code: 'already_claimed' })).toMatchObject({
      message: expect.stringContaining('already'),
    });
  });

  test('backoff doubles to 30s then gives up', () => {
    expect([0, 1, 2, 3, 4, 5].map((a) => claimDelayMs(a))).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(claimDelayMs(8)).toBeNull();
  });

  test('retries not_indexed until credited', async () => {
    const waits: number[] = [];
    const answers = [
      { status: 202, body: { code: 'not_indexed' } },
      { status: 0, body: null },
      { status: 200, body: { credited: 1, balance: 7 } },
    ];
    let i = 0;
    const out = await claimWithRetry(async () => answers[i++], { sleep: async (ms) => void waits.push(ms) });
    expect(out).toEqual({ kind: 'credited', balance: 7 });
    expect(waits).toEqual([2000, 4000]);
  });

  test('a network throw retries; out of attempts leaves it pending; a refusal stops at once', async () => {
    const sleep = async () => undefined;
    let n = 0;
    expect(
      await claimWithRetry(
        async () => {
          n++;
          throw new Error('offline');
        },
        { sleep, max: 3 },
      ),
    ).toEqual({ kind: 'pending' });
    expect(n).toBe(4);
    n = 0;
    const r = await claimWithRetry(async () => (n++, { status: 422, body: { code: 'bad' } }), { sleep });
    expect(r.kind).toBe('failed');
    expect(n).toBe(1);
  });
});

describe('card', () => {
  test('spent so far grows only when the balance falls', () => {
    expect(nextSpent(0, null, 100)).toBe(0);
    expect(nextSpent(0, 100, 90)).toBe(10);
    expect(nextSpent(10, 90, 500)).toBe(10);
  });
  test('tick-down eases from old to new', () => {
    expect(tickValue(100, 90, 0)).toBe(100);
    expect(tickValue(100, 90, 0.5)).toBe(95);
    expect(tickValue(100, 90, 2)).toBe(90);
  });
});

describe('flag', () => {
  test('off by default: needs VITE_ISSUER_CREDITS=1 and never in a store build', async () => {
    const src = readFileSync(new URL('../storeBuild.ts', import.meta.url), 'utf8');
    const expr = /export const ISSUER_CREDITS_ENABLED: boolean =([^;]*);/s.exec(src)?.[1] ?? '';
    expect(expr).toContain("import.meta.env.VITE_ISSUER_CREDITS === '1' &&");
    expect(expr).toContain("import.meta.env.VITE_STORE_BUILD === '1'");
    const { ISSUER_CREDITS_ENABLED } = await import('../storeBuild');
    expect(ISSUER_CREDITS_ENABLED).toBe(false);
    const car = readFileSync(new URL('../wallet/BalanceCarousel.tsx', import.meta.url), 'utf8');
    expect(car).toContain("ISSUER_CREDITS_ENABLED ? lazy(() => import('../credits/IssuerCreditCards')) : null");
  });
});

describe('history + pause (#296)', () => {
  test('parses history; spent so far is spent_total', () => {
    const h = parseHistory({
      entries: [
        { id: 'a', kind: 'debit', units: -5, balance_after: 95, ref: 'mandala reply', created_at: '2026-10-16' },
        { id: 'b', kind: 'topup', units: 100, balance_after: 100, txid: 'ab'.repeat(32), created_at: '2026-10-15' },
        { id: 'c', units: 'x' },
      ],
      spent_total: 5,
      topped_up_total: 100,
      paused: true,
      next_before: 'cur',
    });
    expect(h?.entries).toHaveLength(2);
    expect(h).toMatchObject({ spentTotal: 5, toppedUpTotal: 100, paused: true, nextBefore: 'cur' });
    expect(historyAmount(h!.entries[0])).toBe('−5');
    expect(historyAmount(h!.entries[1])).toBe('+100');
    expect(parseHistory({ error: 'x' })).toBeNull();
  });
  test('paused from /balance; 404/503 fall back to device-only', () => {
    expect(parsePaused({ balance: 1, paused: false })).toBe(false);
    expect(parsePaused({ balance: 1 })).toBeNull();
    expect([404, 503, 409, 200].map(isUnavailable)).toEqual([true, true, false, false]);
  });
  test('contact_url: https only', () => {
    const base = { id: 'x', name: 'X', accepts: [] };
    expect(parseIssuers({ issuers: [{ ...base, contact_url: 'https://x.com/a' }] })[0].contactUrl).toBe(
      'https://x.com/a',
    );
    expect(parseIssuers({ issuers: [{ ...base, contact_url: 'javascript:alert(1)' }] })[0].contactUrl).toBeNull();
  });
});
