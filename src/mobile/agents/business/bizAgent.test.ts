import { beforeEach, describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk';
import {
  bizAgentPay,
  bizSpendAllowed,
  bizSpentToday,
  createBizAgent,
  deriveBizAgentKey,
  getBizAgent,
  getBizLog,
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

  test('a refund that timed out, then a second tap: no second signature or broadcast until it is seen on chain', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const refund = { ticker: 'SHOP', address: TO, sats: 2_000_000, data: ['00ff'], detail: 'Refund $amy' };
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
    expect(sent.length).toBe(1);
    expect(getBizLog('SHOP', store)[0]).toMatchObject({ action: 'pending', txid });

    // Second tap while the network has no word on it: refused plainly, nothing signed or posted.
    let status: 'unknown' | 'seen' = 'unknown';
    const tap = deps({
      findCoins: async () => (finds++, coins),
      txStatus: async () => status,
      broadcastTimeoutMs: 30,
    });
    const r2 = await bizAgentPay(refund, tap);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/hasn’t shown up on the network yet/);
    expect(sent.length).toBe(1);
    expect(finds).toBe(1);
    // A different payment from the same room waits too.
    expect((await bizAgentPay({ ...refund, sats: 1000, detail: 'Other' }, tap)).ok).toBe(false);
    expect(sent.length).toBe(1);
    expect(finds).toBe(1);

    // Seen on chain: recorded as paid, and the same refund tapped again gets that txid (the server records it).
    status = 'seen';
    const r3 = await bizAgentPay(refund, tap);
    expect(r3).toEqual({ ok: true, txid, usd: 1 });
    expect(sent.length).toBe(1);
    expect(finds).toBe(1);
    expect(getBizLog('SHOP', store).find((e) => e.txid === txid)).toMatchObject({ action: 'paid', usd: 1 });
    expect(bizSpentToday(getBizLog('SHOP', store), DAY)).toBeCloseTo(1);
  });

  test('any broadcast error is pending, not failed; a refusal on chain settles it and payments go on', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const r1 = await bizAgentPay(
      { ticker: 'SHOP', address: TO, sats: 2_000_000, detail: 'R1' },
      deps({ broadcast: async () => Promise.reject(new Error('Payment refused by the network (REJECTED)')) }),
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.pending).toBe(true);
    expect(getBizLog('SHOP', store)[0].action).toBe('pending');
    const r2 = await bizAgentPay(
      { ticker: 'SHOP', address: TO, sats: 1000, detail: 'R2' },
      deps({ txStatus: async () => 'rejected' }),
    );
    expect(r2.ok).toBe(true);
    const log = getBizLog('SHOP', store);
    expect(log.find((e) => e.detail.startsWith('R1'))).toMatchObject({ action: 'failed' });
    expect(log.find((e) => e.detail === 'R1: refused by the network')?.rawTx).toBeUndefined();
  });

  test('a pending payment the network never heard of: the SAME signed tx is posted again, never a new one', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const pay = { ticker: 'SHOP', address: TO, sats: 2_000_000, detail: 'R' };
    const posted: string[] = [];
    const r1 = await bizAgentPay(
      pay,
      deps({ broadcast: async (raw: string) => (posted.push(raw), Promise.reject(new Error('timeout'))) }),
    );
    expect(r1.ok).toBe(false);
    const r2 = await bizAgentPay(
      pay,
      deps({ txStatus: async () => 'missing', broadcast: async (raw: string) => void posted.push(raw) }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok && !r1.ok) expect(r2.txid).toBe(r1.txid!);
    expect(posted.length).toBe(2);
    expect(posted[1]).toBe(posted[0]);
  });

  test('an earlier payment settled while another was tapped: its own next tap gets its txid, not a second payment', async () => {
    const a = await createBizAgent(wallet, 'SHOP', 10, store, DAY);
    await fund(a.address, 50_000_000);
    const first = { ticker: 'SHOP', address: TO, sats: 2_000_000, data: ['01'], detail: 'Refund A' };
    const r1 = await bizAgentPay(first, deps({ broadcast: async () => Promise.reject(new Error('timeout')) }));
    expect(r1.ok).toBe(false);
    const seen = deps({ txStatus: async () => 'seen' });
    expect((await bizAgentPay({ ...first, data: ['02'], detail: 'Refund B' }, seen)).ok).toBe(true);
    expect(sent.length).toBe(1); // B only
    const again = await bizAgentPay(first, seen);
    expect(again.ok).toBe(true);
    if (again.ok && !r1.ok) expect(again.txid).toBe(r1.txid!);
    expect(sent.length).toBe(1);
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
