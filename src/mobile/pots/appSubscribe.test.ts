import { beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { amountSats, dueAt, getSub, makePot } = await import('./pots');
const { payDue } = await import('./payDue');
const { getAgentLog, setAgentDailyCap } = await import('../agents/agentAccounts');
const { answerSubscribe, createAppSub, handleSubscribeCall, parseSubscribeArgs, parseSubscribeMessage } =
  await import('./appSubscribe');

const T = (iso: string) => Date.parse(iso);
const ORIGIN = 'https://app.example.com';
const ADDR = PrivateKey.fromRandom().toAddress();
const req = (p: Record<string, unknown> = {}) => ({
  merchantName: 'Example Pro',
  payTo: 'pay@example.com',
  usdPerMonth: 5,
  description: 'Pro plan',
  appOrigin: ORIGIN,
  ...p,
});
type Outs = { address: string; sats: number }[];
const deps = (paid: Outs[], bsvUsd = 50) => ({
  bsvUsd,
  resolve: async () => ADDR,
  sign: async (_pot: string, outputs: Outs) => {
    paid.push(outputs);
    return { rawTx: `raw${paid.length}`, txid: `tx${paid.length}` };
  },
  broadcast: async () => undefined,
});

beforeEach(() => mem.clear());

describe('request parsing', () => {
  test('a valid request', () => {
    expect(parseSubscribeArgs(req(), ORIGIN)).toEqual({
      merchantName: 'Example Pro',
      payTo: 'pay@example.com',
      usdPerMonth: 5,
      description: 'Pro plan',
      appOrigin: ORIGIN,
    });
    expect(parseSubscribeArgs(req({ payTo: ADDR }), ORIGIN).payTo).toBe(ADDR);
  });
  test('appOrigin must be the real sender', () => {
    expect(() => parseSubscribeArgs(req(), 'https://evil.example')).toThrow('appOrigin');
  });
  test('rejects bad payees and amounts', () => {
    expect(() => parseSubscribeArgs(req({ payTo: 'not a payee' }), ORIGIN)).toThrow('payTo');
    expect(() => parseSubscribeArgs(req({ usdPerMonth: 0 }), ORIGIN)).toThrow('usdPerMonth');
    expect(() => parseSubscribeArgs(req({ usdPerMonth: 1000 }), ORIGIN)).toThrow('usdPerMonth');
    expect(() => parseSubscribeArgs(req({ usdPerMonth: '5' }), ORIGIN)).toThrow('usdPerMonth');
    expect(() => parseSubscribeArgs(req({ merchantName: '' }), ORIGIN)).toThrow('merchantName');
  });
  test('rounds to cents', () => {
    expect(parseSubscribeArgs(req({ usdPerMonth: 4.999 }), ORIGIN).usdPerMonth).toBe(5);
  });
  test('message envelope', () => {
    expect(parseSubscribeMessage({ type: 'BWX_SUBSCRIBE', isInvocation: true, id: 1, call: 'subscribe' })).toEqual({
      id: 1,
      call: 'subscribe',
      args: {},
    });
    expect(parseSubscribeMessage({ type: 'BWX_SUBSCRIBE', isInvocation: true, id: 1, call: 'pay' })).toBeNull();
    expect(parseSubscribeMessage({ type: 'CWI', isInvocation: true, id: 1, call: 'subscribe' })).toBeNull();
  });
});

describe('due dates and rate maths', () => {
  test('monthly from the 31st clamps to short months and goes back', () => {
    const start = T('2026-01-31T10:00:00Z');
    expect(new Date(dueAt(start, 'month', 1)).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(new Date(dueAt(start, 'month', 2)).toISOString()).toBe('2026-03-31T10:00:00.000Z');
  });
  test('dollars become sats at the day’s rate', () => {
    expect(amountSats({ value: 5, currency: 'USD' }, 50)).toBe(10_000_000);
    expect(amountSats({ value: 5, currency: 'USD' }, 25)).toBe(20_000_000);
    expect(amountSats({ value: 5, currency: 'USD' }, 0)).toBeNull(); // no price: wait, never guess
  });
});

describe('subscribe, status, cancel', () => {
  const NOW = T('2026-10-16T12:00:00Z');
  test('approve stores it; decline stores nothing', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    let kicked = 0;
    const d = { approve: async () => '1Pot', bsvUsd: () => 50, chargeSoon: () => void kicked++, now: () => NOW };
    const st = (await handleSubscribeCall('subscribe', req(), ORIGIN, d)) as { id: string; status: string };
    expect(st.status).toBe('active');
    expect(kicked).toBe(1);
    expect(getSub(st.id)).toMatchObject({ catchUp: 'latest', period: 'month', amount: { value: 5, currency: 'USD' } });
    const no = await answerSubscribe({ id: 2, call: 'subscribe', args: req() }, ORIGIN, {
      ...d,
      approve: async () => null,
    });
    expect(no).toMatchObject({ status: 'error', description: 'Declined' });
  });
  test('an app only sees and cancels its own', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const s = createAppSub(parseSubscribeArgs(req(), ORIGIN), '1Pot', 50, NOW);
    const d = { approve: async () => null, bsvUsd: () => 50 };
    await expect(handleSubscribeCall('status', { id: s.id }, 'https://other.example', d)).rejects.toThrow('Unknown');
    await expect(handleSubscribeCall('cancel', { id: s.id }, 'https://other.example', d)).rejects.toThrow('Unknown');
    expect(await handleSubscribeCall('list', {}, 'https://other.example', d)).toEqual([]);
    const c = (await handleSubscribeCall('cancel', { id: s.id }, ORIGIN, d)) as { status: string; nextCharge: null };
    expect(c.status).toBe('cancelled');
    expect(c.nextCharge).toBeNull();
  });
});

describe('charger', () => {
  const START = T('2026-06-16T12:00:00Z');
  const setup = () => {
    makePot('1Pot', 'Apps', undefined, START);
    return createAppSub(parseSubscribeArgs(req({ payTo: ADDR }), ORIGIN), '1Pot', 50, START);
  };

  test('first month pays at once, with a receipt; a second run pays nothing', async () => {
    const s = setup();
    const paid: Outs[] = [];
    const r = await payDue(deps(paid), START + 1000);
    expect(r).toEqual([{ id: s.id, ok: true, count: 1, txid: 'tx1' }]);
    expect(paid).toEqual([[{ address: ADDR, sats: 10_000_000 }]]);
    expect(getSub(s.id)?.lastReceipt).toMatchObject({ txid: 'tx1', usd: 5, sats: 10_000_000 });
    expect(await payDue(deps(paid), START + 2000)).toEqual([]);
    expect(paid.length).toBe(1);
  });

  test('concurrent runs share one payment (no double charge)', async () => {
    setup();
    const paid: Outs[] = [];
    await Promise.all([payDue(deps(paid), START + 1000), payDue(deps(paid), START + 1000)]);
    expect(paid.length).toBe(1);
  });

  test('missed months never stack: pays one month on next open, at that day’s rate', async () => {
    const s = setup();
    const paid: Outs[] = [];
    await payDue(deps(paid), START + 1000); // June
    const later = T('2026-10-20T09:00:00Z'); // July, Aug, Sep, Oct all missed
    const r = await payDue(deps(paid, 100), later);
    expect(r).toEqual([{ id: s.id, ok: true, count: 1, txid: 'tx2' }]);
    expect(paid[1]).toEqual([{ address: ADDR, sats: 5_000_000 }]); // $5 at $100/BSV
    expect(getAgentLog('1Pot').some((l) => l.action === 'sub-skip' && /3 missed/.test(l.detail))).toBe(true);
    const next = dueAt(s.start, 'month', getSub(s.id)!.periodIndex);
    expect(new Date(next).toISOString()).toBe('2026-11-16T12:00:00.000Z');
    expect(await payDue(deps(paid, 100), later + 1000)).toEqual([]);
  });

  test('respects the pot’s daily cap', async () => {
    const s = setup();
    setAgentDailyCap('1Pot', 1);
    const paid: Outs[] = [];
    const r = await payDue(deps(paid), START + 1000);
    expect(r[0]).toMatchObject({ id: s.id, ok: false });
    expect(paid.length).toBe(0);
  });
});
