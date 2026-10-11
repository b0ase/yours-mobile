import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatSpent, limitRaw, parsePaidState, payPlan, planTotal, shouldPay, type ListenPlan } from './paidListen';

const plan: ListenPlan = {
  v: 1,
  ticker: 'LOUNGE',
  spaceId: 'sp1',
  payer: 'alice',
  minute: 3,
  body: 'space-listen:sp1:3',
  rule: 'space-listen',
  charges: [
    { unit: 'sats', amount: '30000', to: '1BjTE7Az3eUWQn4K56SxHJUwwy6zoHYp5g' },
    { unit: 'sats', amount: '20000', to: '13WRxSgUYReyawKo2gbRvKHhDEYb29Xd3K' },
  ],
  issuedAt: 1,
};

describe('paid listening', () => {
  it('totals a plan', () => {
    expect(planTotal(plan)).toBe(BigInt(50_000));
  });

  it('pays only when approved, near the end of paid time, and under the limit', () => {
    const base = {
      approved: true,
      plan,
      paidThrough: 100_000,
      now: 90_000,
      spent: BigInt(0),
      limit: BigInt(1_000_000),
      busy: false,
    };
    expect(shouldPay(base)).toBe('pay');
    expect(shouldPay({ ...base, approved: false })).toBe('wait');
    expect(shouldPay({ ...base, busy: true })).toBe('wait');
    expect(shouldPay({ ...base, now: 10_000 })).toBe('wait');
    expect(shouldPay({ ...base, spent: BigInt(960_000) })).toBe('limit');
    expect(shouldPay({ ...base, plan: undefined })).toBe('wait');
  });

  it('turns the listener limit into sats or raw tokens', () => {
    expect(limitRaw(1, { kind: 'bsv' }, 20)).toBe(BigInt(5_000_000));
    expect(limitRaw(1, { kind: 'bsv' }, null)).toBe(BigInt(0));
    expect(limitRaw(2.5, { kind: 'bsv21', tokenId: 'x_0', sym: 'PNEE', dec: 2 }, null)).toBe(BigInt(250));
  });

  it('formats what was spent', () => {
    expect(formatSpent(BigInt(5_000_000), { kind: 'bsv' }, 20)).toBe('$1.00');
    expect(formatSpent(BigInt(250), { kind: 'bsv21', tokenId: 'x_0', sym: 'PNEE', dec: 2 }, null)).toBe('2.5 $PNEE');
  });

  it('parses the server state', () => {
    const s = parsePaidState({
      config: {
        enabled: true,
        amount: 0.01,
        per: 'minute',
        currency: { kind: 'bsv' },
        dest: 'stage',
        hostSharePct: 10,
      },
      price: '$0.01 a minute',
      canConfigure: false,
      me: { role: 'listener', paidThrough: 123, hearing: false },
      plan,
      sig: 'ab',
    });
    expect(s.config?.enabled).toBe(true);
    expect(s.config?.freeFirstMinute).toBe(true);
    expect(s.me?.hearing).toBe(false);
    expect(s.plan?.minute).toBe(3);
    expect(parsePaidState(null).config).toBeNull();
  });

  it('pays through the wallet then reports to bChatX; a refusal releases the coins', async () => {
    const calls: string[] = [];
    const deps = {
      payForMessage: async () => {
        calls.push('sign');
        return { beef: 'beef', txid: 'tx1' };
      },
      releasePayment: async () => {
        calls.push('release');
      },
    };
    const ok = await payPlan(
      {} as never,
      { spacePaid: async () => ({}), spacePaidAction: async () => ({ paidThrough: 99 }) },
      plan,
      'sig',
      deps,
    );
    expect(ok).toEqual({ txid: 'tx1', paidThrough: 99 });
    const refuse = {
      spacePaid: async () => ({}),
      spacePaidAction: async () => {
        throw new Error('no');
      },
    };
    await expect(payPlan({} as never, refuse, plan, 'sig', deps)).rejects.toThrow('no');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['sign', 'sign', 'release']);
  });

  it('is never in a store build (literal env switch, lazy chunk)', () => {
    const src = readFileSync('src/mobile/spaces/paidListen.ts', 'utf8');
    expect(src).toContain("import.meta.env.VITE_STORE_BUILD === '1'");
    const screen = readFileSync('src/mobile/spaces/SpaceScreen.tsx', 'utf8');
    expect(screen).toContain("PAID_LISTENING_ENABLED ? lazy(() => import('./PaidListening')) : null");
  });
});
