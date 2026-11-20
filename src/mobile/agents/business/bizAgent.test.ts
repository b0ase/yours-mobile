import { beforeEach, describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk';
import {
  bizAgentPay,
  bizSpendAllowed,
  bizStatusOf,
  bizWriteOffPending,
  bizSpentToday,
  createBizAgent,
  deriveBizAgentKey,
  getBizAgent,
  getBizLog,
  getBizPending,
  setBizCap,
  setBizStopped,
  type BizAgentState,
  type BizCoin,
  type BizLogEntry,
} from './bizAgent';

const DAY = Date.UTC(2026, 9, 16, 12);
const RATE = 50; // $50 per BSV → 1 USD = 2,000,000 sats
const TO = new PrivateKey(7).toAddress();

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const acct = (p: Partial<BizAgentState> = {}): BizAgentState => ({
  ticker: 'SHOP',
  address: '1x',
  dailyCapUsd: 10,
  stopped: false,
  createdAt: 0,
  ...p,
});
const paid = (usd: number, at = DAY): BizLogEntry => ({ at, action: 'paid', detail: '', usd });

describe('bizSpendAllowed (pure gate)', () => {
  test('refuses without an account, when stopped, or when everything is stopped', () => {
    expect(bizSpendAllowed(null, false, [], 1, DAY).ok).toBe(false);
    expect(bizSpendAllowed(acct({ stopped: true }), false, [], 1, DAY)).toEqual({
      ok: false,
      reason: 'The agent account is stopped',
    });
    expect(bizSpendAllowed(acct(), true, [], 1, DAY)).toEqual({ ok: false, reason: 'All agents are stopped' });
  });
  test('daily cap counts paid, pending and failed today only', () => {
    const log: BizLogEntry[] = [
      paid(4),
      { at: DAY, action: 'pending', detail: '', usd: 3 },
      { at: DAY, action: 'failed', detail: '', usd: 1 },
      { at: DAY, action: 'refused', detail: '', usd: 99 },
      paid(50, DAY - 86_400_000),
    ];
    expect(bizSpentToday(log, DAY)).toBe(8);
    expect(bizSpendAllowed(acct(), false, log, 2, DAY).ok).toBe(true);
    const over = bizSpendAllowed(acct(), false, log, 2.01, DAY);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('$2.00 left of $10');
  });
  test('a new UTC day resets the cap', () => {
    expect(bizSpendAllowed(acct(), false, [paid(10, DAY)], 5, DAY + 86_400_000).ok).toBe(true);
  });
  test('refuses zero or non-finite amounts', () => {
    expect(bizSpendAllowed(acct(), false, [], 0, DAY).ok).toBe(false);
    expect(bizSpendAllowed(acct(), false, [], NaN, DAY).ok).toBe(false);
  });
});

describe('agent account', () => {
  const wallet = new ProtoWallet(new PrivateKey(42));
  let store: ReturnType<typeof memStore>;
  let coins: BizCoin[];
  let sent: string[];

  const fund = async (address: string, sats: number) => {
    const src = new Transaction();
    src.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: sats });
    coins = [{ txid: src.id('hex') as string, vout: 0, sats, sourceTx: src }];
  };
  const deps = (over: Partial<Parameters<typeof bizAgentPay>[1]> = {}) => ({
    wallet,
    findCoins: async () => coins,
    broadcast: async (raw: string) => void sent.push(raw),
    usdPerBsv: RATE,
    stopAll: () => false,
    store,
    now: () => DAY,
    ...over,
  });

  beforeEach(() => {
    store = memStore();
    coins = [];
    sent = [];
  });

  test('the key is derived from the wallet: same seed, same address; nothing secret is stored', async () => {
    const a = await createBizAgent(wallet, '$shop', 10, store, DAY);
    const again = await deriveBizAgentKey(new ProtoWallet(new PrivateKey(42)), 'SHOP');
    expect(again.toAddress()).toBe(a.address);
    const other = await deriveBizAgentKey(new ProtoWallet(new PrivateKey(43)), 'SHOP');
    expect(other.toAddress()).not.toBe(a.address);
    const raw = JSON.stringify([store.getItem('bwallet.bizAgent'), store.getItem('bwallet.bizAgentLog.SHOP')]);
    expect(raw).not.toContain(again.toWif());
    expect(raw).not.toContain(again.toHex());
  });

  test('pays within the cap and books it', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r = await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 10_000_000, detail: 'Refund' }, deps());
    expect(r.ok).toBe(true);
    expect(sent.length).toBe(1);
    const tx = Transaction.fromHex(sent[0]);
    expect(tx.outputs[0].satoshis).toBe(10_000_000);
    expect(getBizLog('SHOP', store)[0]).toMatchObject({ action: 'paid', usd: 5 });
  });

  test('refuses over the daily cap, without signing or broadcasting', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 100_000_000);
    expect((await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 16_000_000, detail: 'R1' }, deps())).ok).toBe(true);
    const r = await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 6_000_000, detail: 'R2' }, deps());
    expect(r.ok).toBe(false);
    expect(sent.length).toBe(1);
    expect(getBizLog('SHOP', store)[0].action).toBe('refused');
    setBizCap('SHOP', 20, store, DAY);
    expect((await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 6_000_000, detail: 'R3' }, deps())).ok).toBe(true);
  });

  test('Stop freezes all agent payments until Resume', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    setBizStopped('SHOP', true, store, DAY);
    const r = await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 1000, detail: 'R' }, deps());
    expect(r).toEqual({ ok: false, reason: 'The agent account is stopped' });
    expect(sent.length).toBe(0);
    setBizStopped('SHOP', false, store, DAY);
    expect((await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 1000, detail: 'R' }, deps())).ok).toBe(true);
  });

  test('Stop pressed while the payment is in progress wins before signing', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r = await bizAgentPay(
      { ticker: 'SHOP', address: TO, sats: 1000, detail: 'R' },
      deps({
        findCoins: async () => {
          setBizStopped('SHOP', true, store, DAY); // the owner taps Stop mid-payment
          return coins;
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(sent.length).toBe(0);
  });

  test('"Stop all agents" also freezes the business agent', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r = await bizAgentPay(
      { ticker: 'SHOP', address: TO, sats: 1000, detail: 'R' },
      deps({ stopAll: () => true }),
    );
    expect(r.ok).toBe(false);
    expect(sent.length).toBe(0);
  });

  test('a failed broadcast still counts toward the cap', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r = await bizAgentPay(
      { ticker: 'SHOP', address: TO, sats: 18_000_000, detail: 'R' },
      deps({ broadcast: async () => Promise.reject(new Error('Network request failed')) }),
    );
    expect(r.ok).toBe(false);
    expect(bizSpentToday(getBizLog('SHOP', store), DAY)).toBeCloseTo(9);
    expect((await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 4_000_000, detail: 'R' }, deps())).ok).toBe(false);
  });

  const inputsOf = (raw: string) =>
    Transaction.fromHex(raw).inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`);
  /** Two coins, so a fresh payment could be built from either one (a replacement need not share an input). */
  const fundTwo = (address: string) => {
    coins = [30_000_000, 20_000_000].map((sats) => {
      const src = new Transaction();
      src.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: sats });
      src.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 1 }); // distinct txids
      return { txid: src.id('hex') as string, vout: 0, sats, sourceTx: src };
    });
  };
  const refund = { ticker: 'SHOP', address: TO, sats: 2_000_000, data: ['00ff'], detail: 'Refund $amy' };
  const silent = async () => Promise.reject(new Error('timeout'));

  test('a refund that timed out, then a second tap: no second signature, only the same tx re-posted, until seen', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    let finds = 0;
    const hung = deps({
      findCoins: async () => (finds++, coins),
      broadcast: (raw: string) => (sent.push(raw), new Promise<void>(() => undefined)), // landed, but never answers
      broadcastTimeoutMs: 30,
    });
    const r1 = await bizAgentPay(refund, hung);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.pending).toBe(true);
    expect(r1.reason).toMatch(/hasn’t confirmed it yet/);
    const txid = r1.txid!;

    let status: 'unknown' | 'seen' = 'unknown';
    const tap = deps({
      findCoins: async () => (finds++, coins),
      txStatus: async () => status,
      broadcast: async (raw: string) => (sent.push(raw), Promise.reject(new Error('timeout'))),
      broadcastTimeoutMs: 30,
    });
    const r2 = await bizAgentPay(refund, tap);
    expect(r2).toMatchObject({ ok: false, pending: true, txid });
    if (!r2.ok) expect(r2.reason).toMatch(/hasn’t shown up on the network yet/);
    expect((await bizAgentPay({ ...refund, sats: 1000, detail: 'Other' }, tap)).ok).toBe(false);
    expect(finds).toBe(1); // nothing new was built or signed
    expect(new Set(sent).size).toBe(1); // only the first tx was ever posted

    status = 'seen';
    expect(await bizAgentPay(refund, tap)).toEqual({ ok: true, txid, usd: 1 });
    expect(finds).toBe(1);
    expect(getBizLog('SHOP', store).find((e) => e.txid === txid)).toMatchObject({ action: 'paid', usd: 1 });
    expect(getBizPending('SHOP', store)).toEqual([]);
  });

  test('REJECTED and DOUBLE_SPEND_ATTEMPTED are not final; only INVALID and MALFORMED are', () => {
    expect(bizStatusOf('REJECTED')).toBe('unknown');
    expect(bizStatusOf('DOUBLE_SPEND_ATTEMPTED')).toBe('unknown');
    expect(bizStatusOf('INVALID')).toBe('rejected');
    expect(bizStatusOf('MALFORMED')).toBe('rejected');
    expect(bizStatusOf('SEEN_ON_NETWORK')).toBe('seen');
    expect(bizStatusOf(null)).toBe('missing');
  });

  test('a wrong REJECTED: the payment stays pending and nothing new is signed while the same tx is refused', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    fundTwo(a.address);
    const refused = async (raw: string) => (sent.push(raw), Promise.reject(new Error('refused (REJECTED)')));
    const r1 = await bizAgentPay(refund, deps({ broadcast: refused }));
    expect(r1.ok).toBe(false);
    for (let k = 0; k < 3; k++)
      expect((await bizAgentPay(refund, deps({ txStatus: async () => 'unknown', broadcast: refused }))).ok).toBe(false);
    expect(new Set(sent).size).toBe(1);
    expect(getBizPending('SHOP', store).length).toBe(1);
  });

  test('written off (INVALID, or by the owner) and paid again: the replacement spends an old input, so one confirms', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    fundTwo(a.address);
    const r1 = await bizAgentPay(refund, deps({ broadcast: async (raw) => (sent.push(raw), silent()) }));
    expect(r1.ok).toBe(false);
    const oldInputs = inputsOf(sent[0]);
    // The old tx's biggest coin is also the replacement's first pick otherwise; make the other coin the bigger one.
    coins = coins.map((c) => (oldInputs.includes(`${c.txid}.${c.vout}`) ? c : { ...c, sats: 40_000_000 }));
    const r2 = await bizAgentPay(refund, deps({ txStatus: async () => 'rejected' }));
    expect(r2.ok).toBe(true);
    // It spends the old tx's coin (here it is the old tx again, signed the same way: the same txid), so the two can
    // never both confirm, although the other, bigger coin alone would have paid it.
    const shared = inputsOf(sent[1]).filter((x) => oldInputs.includes(x));
    expect(shared.length).toBeGreaterThan(0);
  });

  test('written off, but the old input is gone (spent on chain): the old one counts as paid, nothing is signed', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    fundTwo(a.address);
    const r1 = await bizAgentPay(refund, deps({ broadcast: async (raw) => (sent.push(raw), silent()) }));
    if (r1.ok) throw new Error('expected pending');
    bizWriteOffPending('SHOP', r1.txid!, store, DAY);
    const oldInputs = inputsOf(sent[0]);
    coins = coins.filter((c) => !oldInputs.includes(`${c.txid}.${c.vout}`)); // the old tx went out after all
    const r2 = await bizAgentPay(refund, deps());
    expect(r2).toEqual({ ok: true, txid: r1.txid!, usd: 1 });
    expect(sent.length).toBe(1);
    // And for good: the same refund again still gets that txid.
    expect(await bizAgentPay(refund, deps())).toEqual({ ok: true, txid: r1.txid!, usd: 1 });
    expect(sent.length).toBe(1);
  });

  test('a pending entry from before the signed tx was kept, unknown to the network: refused until the owner writes it off', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const old = 'e'.repeat(64);
    store.setItem(
      'bwallet.bizAgentLog.SHOP',
      JSON.stringify([{ at: DAY, action: 'pending', detail: 'Refund $bob', usd: 1, txid: old, id: old }]),
    );
    const missing = deps({ txStatus: async () => 'missing' });
    for (let k = 0; k < 2; k++) {
      const r = await bizAgentPay(refund, missing);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/can’t be checked.*write it off/);
    }
    expect(sent.length).toBe(0);
    bizWriteOffPending('SHOP', old, store, DAY);
    expect((await bizAgentPay(refund, missing)).ok).toBe(true);
    expect(sent.length).toBe(1);
  });

  test('300+ waiting taps keep the pending payment (its own store; repeated taps are one log line)', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r1 = await bizAgentPay(refund, deps({ broadcast: async (raw) => (sent.push(raw), silent()) }));
    if (r1.ok) throw new Error('expected pending');
    const waitDeps = deps({ broadcast: async (raw) => (sent.push(raw), silent()) });
    for (let k = 0; k < 320; k++) expect((await bizAgentPay(refund, waitDeps)).ok).toBe(false);
    expect(getBizPending('SHOP', store)).toMatchObject([{ txid: r1.txid, rawTx: sent[0] }]);
    expect(getBizLog('SHOP', store).filter((e) => e.action === 'refused').length).toBe(1);
    expect(new Set(sent).size).toBe(1);
    expect(await bizAgentPay(refund, deps({ txStatus: async () => 'seen' }))).toEqual({
      ok: true,
      txid: r1.txid!,
      usd: 1,
    });
    expect(new Set(sent).size).toBe(1);
  });

  test('paid, then the server record (onPaid) failed and the owner taps again: the same txid, always', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r1 = await bizAgentPay(refund, deps());
    expect(r1.ok).toBe(true);
    for (let k = 0; k < 3; k++) expect(await bizAgentPay(refund, deps())).toEqual(r1);
    // Even once the log has moved on past it (it keeps 300 lines).
    for (let k = 0; k < 310; k++) setBizCap('SHOP', 10 + (k % 2), store, DAY);
    expect(await bizAgentPay(refund, deps())).toEqual(r1);
    expect(sent.length).toBe(1);
  });

  test('an earlier payment settled while another was tapped: its own taps get its txid, every time', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const first = { ...refund, data: ['01'], detail: 'Refund A' };
    const r1 = await bizAgentPay(first, deps({ broadcast: silent }));
    if (r1.ok) throw new Error('expected pending');
    const seen = deps({ txStatus: async () => 'seen' });
    expect((await bizAgentPay({ ...first, data: ['02'], detail: 'Refund B' }, seen)).ok).toBe(true);
    expect(sent.length).toBe(1); // B only
    for (let k = 0; k < 2; k++) expect(await bizAgentPay(first, seen)).toEqual({ ok: true, txid: r1.txid!, usd: 1 });
    expect(sent.length).toBe(1);
  });

  test('two tabs pay the same refund at once: one signature (navigator.locks across tabs)', async () => {
    // A lock shared by both "tabs", as the browser's navigator.locks is.
    const chains = new Map<string, Promise<unknown>>();
    const locks = {
      request: <T>(name: string, cb: () => Promise<T>) => {
        const run = (chains.get(name) ?? Promise.resolve()).then(() => cb());
        chains.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    };
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, 'locks');
    Object.defineProperty(nav, 'locks', { value: locks, configurable: true });
    try {
      const tab2 = (await import('./bizAgent.ts?tab2')) as typeof import('./bizAgent');
      const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
      await fund(a.address, 50_000_000);
      const slow = deps({ broadcast: async (raw: string) => (sent.push(raw), new Promise((r) => setTimeout(r, 20))) });
      const [x, y] = await Promise.all([bizAgentPay(refund, slow), tab2.bizAgentPay(refund, slow)]);
      expect(sent.length).toBe(1);
      expect(x).toEqual(y);
      expect(x.ok).toBe(true);
    } finally {
      if (had) Object.defineProperty(nav, 'locks', had);
      else delete nav.locks;
    }
  });

  test('without navigator.locks, two payments at once in one tab still sign once', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const slow = deps({ broadcast: async (raw: string) => (sent.push(raw), new Promise((r) => setTimeout(r, 20))) });
    const [x, y] = await Promise.all([bizAgentPay(refund, slow), bizAgentPay(refund, slow)]);
    expect(sent.length).toBe(1);
    expect(x).toEqual(y);
  });

  test('no price, bad address or no account → refused', async () => {
    expect((await bizAgentPay({ ticker: 'NONE', address: TO, sats: 1000, detail: 'R' }, deps())).ok).toBe(false);
    await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    expect(
      (await bizAgentPay({ ticker: 'SHOP', address: TO, sats: 1000, detail: 'R' }, deps({ usdPerBsv: 0 }))).ok,
    ).toBe(false);
    expect((await bizAgentPay({ ticker: 'SHOP', address: 'nope', sats: 1000, detail: 'R' }, deps())).ok).toBe(false);
    expect(getBizAgent('shop', store)?.dailyCapUsd).toBe(10);
  });
});
