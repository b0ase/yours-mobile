/**
 * Pot spend caps (backlog 21 Nov 2026, cluster baware:pots-agent-caps): a sats order with no rate, a replayed payment
 * that was never booked, two tabs paying one period, a subscription moved into a pot with no cap, and reminders for
 * daily and hourly orders. One describe per b-Aware row.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { CLAIM_TTL_MS, addSubscription, claimPeriod, getPending, getSub, makePot, moveSub, savePending, saveSub } =
  await import('./pots');
const { PAY_LOCK, payDue } = await import('./payDue');
const { plannedReminders } = await import('./notifyPots');
type Subscription = import('./pots').Subscription;
const { appendAgentLog, checkAgentSpend, getAgentAccount, getAgentLog, ledgerSpentToday, setAgentDailyCap } =
  await import('../agents/agentAccounts');

const NOW = Date.parse('2026-03-10T12:00:00Z');
const DAY = 86_400_000;
type Outs = { address: string; sats: number }[];

describe('row 267: a sats order with no BSV rate is never paid against a $0 cap check', () => {
  beforeEach(() => mem.clear());

  test('no rate: nothing is signed, nothing is booked as free, and the order waits', async () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    const s = addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 3_000_000, currency: 'SAT' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
    setAgentDailyCap('1Pot', 1);
    const signed: Outs[] = [];
    const r = await payDue(
      {
        bsvUsd: 0,
        resolve: async () => '1Landlord',
        sign: async (_p, outs) => (signed.push(outs), { rawTx: 'RAW', txid: 'TX' }),
        broadcast: async () => undefined,
        spendingPaused: async () => false,
      },
      NOW,
    );
    expect(signed).toEqual([]);
    expect(r).toEqual([{ id: s.id, ok: false, reason: 'No price right now' }]);
    expect(getSub(s.id)?.periodIndex).toBe(0);
    expect(getAgentLog('1Pot').filter((l) => l.action === 'sub-pay')).toEqual([]);
  });

  test('with a rate, the same order is gated on its real dollar value', async () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 3_000_000, currency: 'SAT' },
        period: 'day',
        start: NOW - 2 * DAY - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
    setAgentDailyCap('1Pot', 1);
    let signs = 0;
    const r = await payDue(
      {
        bsvUsd: 50,
        resolve: async () => '1Landlord',
        sign: async () => (signs++, { rawTx: 'RAW', txid: 'TX' }),
        broadcast: async () => undefined,
        spendingPaused: async () => false,
      },
      NOW,
    );
    expect(signs).toBe(0);
    expect(r[0].ok).toBe(false);
    expect(ledgerSpentToday('1Pot', NOW)).toBe(0);
  });
});

describe('row 272: a replayed pot payment is booked once, whichever run settles it', () => {
  beforeEach(() => mem.clear());
  const setup = () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    const s = addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Landlord', address: '1Landlord' },
        amount: { value: 1, currency: 'USD' },
        period: 'day',
        start: NOW - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
    setAgentDailyCap('1Pot', 1);
    return s;
  };
  const deps = (sent: string[], signs: { n: number }) => ({
    bsvUsd: 50,
    resolve: async () => '1Landlord',
    sign: async () => (signs.n++, { rawTx: `RAW${signs.n}`, txid: `TX${signs.n}` }),
    broadcast: async (raw: string) => void sent.push(raw),
    spendingPaused: async () => false,
  });

  test('killed after the order advanced but before booking: the replay books it, and the cap holds', async () => {
    const s = setup();
    // The state a kill between saveSub and the log leaves: advanced, still pending, nothing booked.
    savePending({
      subId: s.id,
      potId: '1Pot',
      periodIndex: 0,
      count: 1,
      dueTimes: [s.start],
      rawTx: 'RAW0',
      txid: 'TX0',
      usd: 1,
      at: NOW,
      to: '1Landlord',
      sats: 2_000_000,
    });
    saveSub({ ...getSub(s.id)!, periodIndex: 1, paidCount: 1 });
    const sent: string[] = [];
    const signs = { n: 0 };
    const r = await payDue(deps(sent, signs), NOW);
    expect(r[0]).toMatchObject({ ok: true, txid: 'TX0' });
    expect(getPending(s.id)).toBeNull();
    expect(getAgentLog('1Pot').filter((l) => l.action === 'sub-pay' && l.txid === 'TX0')).toHaveLength(1);
    expect(ledgerSpentToday('1Pot', NOW)).toBe(1);
    // The cap space is used: the next due period (a day on) is refused today.
    expect(checkAgentSpend('1Pot', 1, NOW).ok).toBe(false);
  });

  test('killed after booking but before the record was cleared: the replay does not book it twice', async () => {
    const s = setup();
    savePending({
      subId: s.id,
      potId: '1Pot',
      periodIndex: 0,
      count: 1,
      dueTimes: [s.start],
      rawTx: 'RAW0',
      txid: 'TX0',
      usd: 1,
      at: NOW,
      to: '1Landlord',
      sats: 2_000_000,
    });
    saveSub({ ...getSub(s.id)!, periodIndex: 1, paidCount: 1 });
    appendAgentLog('1Pot', { at: NOW, action: 'sub-pay', detail: 'Paid Landlord $1.00', usd: 1, txid: 'TX0' });
    const sent: string[] = [];
    const r = await payDue(deps(sent, { n: 0 }), NOW);
    expect(r[0]).toMatchObject({ ok: true, txid: 'TX0' });
    expect(getAgentLog('1Pot').filter((l) => l.action === 'sub-pay')).toHaveLength(1);
    expect(ledgerSpentToday('1Pot', NOW)).toBe(1);
  });
});

describe('row 233: two tabs paying one period at once give one payment', () => {
  beforeEach(() => mem.clear());
  type PayDueFn = typeof payDue;
  // A second tab is a second JS realm: its own copy of payDue (its own one-run-at-a-time singleton), the same storage.
  const realm2 = async (): Promise<PayDueFn> => {
    const spec = './payDue?realm=2';
    return ((await import(spec)) as { payDue: PayDueFn }).payDue;
  };
  const setup = () => {
    makePot('1Pot', 'Rent', undefined, NOW);
    return addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Shop', address: '1Shop' },
        amount: { value: 5, currency: 'USD' },
        period: 'day',
        start: NOW - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
  };
  const tabDeps = (tag: string, network: string[], signMs = 30) => ({
    bsvUsd: 50,
    resolve: async () => '1Shop',
    sign: async () => {
      await new Promise((r) => setTimeout(r, signMs));
      return { rawTx: `RAW-${tag}`, txid: `TX-${tag}` };
    },
    broadcast: async (raw: string) => void network.push(raw),
    spendingPaused: async () => false,
  });
  /** navigator.locks as a browser gives it: one exclusive lock per name, shared by every tab of the origin. */
  const sharedLocks = () => {
    const tails = new Map<string, Promise<unknown>>();
    return {
      request: <T>(name: string, _o: object, cb: () => Promise<T>): Promise<T> => {
        const run = (tails.get(name) ?? Promise.resolve()).then(cb, cb);
        tails.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    };
  };
  const withLocks = async (locks: unknown, fn: () => Promise<void>) => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    if (locks) Object.defineProperty(nav, 'locks', { value: locks, configurable: true });
    try {
      await fn();
    } finally {
      delete nav.locks;
    }
  };

  test("with navigator.locks: the second tab's run starts only after the first one has paid, and pays nothing", async () => {
    const locks = sharedLocks();
    const names: string[] = [];
    await withLocks(
      { request: (n: string, o: object, cb: () => Promise<unknown>) => (names.push(n), locks.request(n, o, cb)) },
      async () => {
        const s = setup();
        const payDue2 = await realm2();
        const network: string[] = [];
        const events: string[] = [];
        const tab = (tag: string) => ({
          ...tabDeps(tag, network),
          // Asked first thing in a run (and again at broadcast): the first ask marks the run's start.
          spendingPaused: async () => (events.includes(`${tag} starts`) || events.push(`${tag} starts`), false),
          broadcast: async (raw: string) => void (network.push(raw), events.push(`${tag} sends`)),
        });
        await Promise.all([payDue(tab('A'), NOW), payDue2(tab('B'), NOW)]);
        expect(names).toEqual([PAY_LOCK, PAY_LOCK]);
        expect(events.slice(0, 2)).toEqual(['A starts', 'A sends']);
        expect(network).toEqual(['RAW-A']);
        expect(getSub(s.id)?.periodIndex).toBe(1);
        expect(getAgentLog('1Pot').filter((l) => l.action === 'sub-pay')).toHaveLength(1);
        expect(ledgerSpentToday('1Pot', NOW)).toBe(5);
      },
    );
  });

  test('no navigator.locks: a period another tab has claimed is not signed here until that claim lapses', async () => {
    const s = setup();
    claimPeriod(s.id, 0, 'other-tab', NOW);
    const network: string[] = [];
    let signs = 0;
    const d = { ...tabDeps('A', network), sign: async () => (signs++, { rawTx: 'RAW-A', txid: 'TX-A' }) };
    expect(await payDue(d, NOW + 1000)).toEqual([{ id: s.id, ok: false, reason: 'Being paid in another window' }]);
    expect(signs).toBe(0);
    expect(network).toEqual([]);
    // That tab died mid-sign and never recorded anything: after the claim lapses, this tab pays.
    expect((await payDue(d, NOW + CLAIM_TTL_MS + 1000))[0]).toMatchObject({ ok: true, txid: 'TX-A' });
    expect(network).toEqual(['RAW-A']);
  });

  test('no navigator.locks: another tab taking the period while this one signs means this tx is never sent', async () => {
    const s = setup();
    const network: string[] = [];
    const d = {
      ...tabDeps('A', network),
      // Tab B, in parallel, overwrites the claim (both read "no claim", B wrote last) while A signs.
      sign: async () => (claimPeriod(s.id, 0, 'tab-B', NOW - CLAIM_TTL_MS), { rawTx: 'RAW-A', txid: 'TX-A' }),
    };
    expect(await payDue(d, NOW)).toEqual([{ id: s.id, ok: false, reason: 'Being paid in another window' }]);
    expect(network).toEqual([]);
    expect(getPending(s.id)).toBeNull();
    expect(getSub(s.id)?.periodIndex).toBe(0);
  });

  test("no navigator.locks: another tab's recorded payment for the period stops this tab's tx before it is sent", async () => {
    const s = setup();
    const network: string[] = [];
    const theirs = {
      subId: s.id,
      potId: '1Pot',
      periodIndex: 0,
      count: 1,
      dueTimes: [s.start],
      rawTx: 'RAW-B',
      txid: 'TX-B',
      usd: 5,
      at: NOW,
      to: '1Shop',
      sats: 10_000_000,
    };
    const d = { ...tabDeps('A', network), sign: async () => (savePending(theirs), { rawTx: 'RAW-A', txid: 'TX-A' }) };
    expect(await payDue(d, NOW)).toEqual([{ id: s.id, ok: false, reason: 'Being paid in another window' }]);
    expect(network).toEqual([]);
    expect(getPending(s.id)?.txid).toBe('TX-B');
  });
});

describe('row 350: moving a subscription into a pot with no cap gives that pot its cap', () => {
  beforeEach(() => mem.clear());
  const order = (potId: string, value: number, period: 'day' | { seconds: number } = 'day') =>
    addSubscription(
      {
        potId,
        payee: { name: 'Shop', address: '1Shop' },
        amount: { value, currency: 'USD' },
        period,
        start: NOW + DAY,
        maxCount: null,
      },
      50,
      NOW,
    );

  test('a virgin pot gets the default cap from the moved order, and a big spend is refused', () => {
    makePot('1A', 'A', undefined, NOW);
    makePot('1B', 'B', undefined, NOW);
    const s = order('1A', 10);
    expect(checkAgentSpend('1A', 10_000, NOW).ok).toBe(false);
    moveSub(s.id, '1B', NOW, 50);
    expect(getSub(s.id)?.potId).toBe('1B');
    expect(getAgentAccount('1B')?.dailyCapUsd).toBe(33);
    expect(checkAgentSpend('1B', 10_000, NOW).ok).toBe(false);
  });

  test('an hourly order moved into a virgin pot is capped like one created there', () => {
    makePot('1C', 'C', undefined, NOW);
    makePot('1D', 'D', undefined, NOW);
    const s = order('1C', 100, { seconds: 3600 });
    moveSub(s.id, '1D', NOW, 50);
    expect(getAgentAccount('1D')?.dailyCapUsd).toBe(getAgentAccount('1C')?.dailyCapUsd);
    expect(checkAgentSpend('1D', 2_400, NOW).ok).toBe(false);
  });

  test('a pot that already has a cap keeps it', () => {
    makePot('1A', 'A', undefined, NOW);
    makePot('1B', 'B', undefined, NOW);
    order('1B', 1);
    setAgentDailyCap('1B', 7);
    const s = order('1A', 10);
    moveSub(s.id, '1B', NOW, 50);
    expect(getAgentAccount('1B')?.dailyCapUsd).toBe(7);
  });
});

describe('row 268: daily and hourly orders get a reminder too', () => {
  const at = (iso: string) => Date.parse(iso);
  const order = (p: Partial<Subscription>): Subscription => ({
    id: 's1',
    potId: '1Pot',
    payee: { name: 'Shop', address: '1Shop' },
    amount: { value: 1, currency: 'USD' },
    period: 'day',
    start: at('2026-03-05T09:00:00Z'),
    maxCount: null,
    paidCount: 0,
    periodIndex: 0,
    nextDue: 0,
    status: 'active',
    mode: 'onOpen',
    ...p,
  });

  test('a daily order due in 6 hours is reminded before it is due', () => {
    const now = at('2026-03-05T03:00:00Z');
    const r = plannedReminders([order({})], () => 'Rent', now);
    expect(r).toHaveLength(1);
    expect(r[0].at).toBeGreaterThan(now);
    expect(r[0].at).toBeLessThan(at('2026-03-05T09:00:00Z'));
    expect(r[0].title).not.toContain('tomorrow');
  });

  test('a daily order opened right after a payment is reminded half a day before the next one', () => {
    const now = at('2026-03-05T09:30:00Z');
    const r = plannedReminders([order({ periodIndex: 1 })], () => 'Rent', now);
    expect(r).toHaveLength(1);
    expect(r[0].at).toBe(at('2026-03-05T21:00:00Z'));
    expect(r[0].title).toBe('Shop: $1.00 in 12 hours');
  });

  test('an hourly order is reminded half an hour before it is due', () => {
    const now = at('2026-03-05T08:10:00Z');
    const r = plannedReminders([order({ period: { seconds: 3600 } })], () => 'Rent', now);
    expect(r).toHaveLength(1);
    expect(r[0].at).toBe(at('2026-03-05T08:30:00Z'));
    expect(r[0].title).toBe('Shop: $1.00 in 30 minutes');
  });

  test('a monthly order is still reminded a day ahead', () => {
    const now = at('2026-03-01T00:00:00Z');
    const r = plannedReminders([order({ period: 'month' })], () => 'Rent', now);
    expect(r[0].at).toBe(at('2026-03-04T09:00:00Z'));
    expect(r[0].title).toBe('Shop: $1.00 tomorrow');
  });
});
