/**
 * Recover change from my 12 words: the derivation (toolbox patch), the WhatsOnChain spend client and the walk.
 * Local only: random keys, fake network. The full round trip on the real toolbox is in src/incident/seedChange.roundtrip.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { KeyDeriver, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import { Wallet } from '@bsv/wallet-toolbox-client';
import { validateBase64String } from '@bsv/sdk/wallet/validationHelpers';
import { brc29Script } from './recoverByTxid';
import {
  changeDerivation,
  deterministicChangeOf,
  recoverSeedChange,
  seedChangeSummary,
  wocSpentLookup,
  type FoundChange,
  type SeedChangeDeps,
  type SeedChangeState,
  type SpendState,
} from './seedChange';

const W = Wallet as unknown as {
  bwxChangePrefix: (kd: unknown, outpoints: string[]) => string | undefined;
  bwxChangeSuffix: (vout: number) => string;
  bwxDeterministicChange: boolean;
};
const txid = (n: number) => n.toString(16).padStart(64, '0');
const kdOf = () => new KeyDeriver(PrivateKey.fromRandom());
/** The locking script of this wallet's change at vout of a transaction with these inputs. */
const changeScript = (kd: KeyDeriver, ins: string[], vout: number) =>
  LockingScript.fromHex(brc29Script(kd, changeDerivation(kd, ins, vout)!));

describe('deterministic change derivation (toolbox patch)', () => {
  test('the same inputs give the same prefix, in any order', () => {
    const kd = kdOf();
    const a = W.bwxChangePrefix(kd, [`${txid(1)}.0`, `${txid(2)}.3`]);
    expect(a).toBeString();
    expect(W.bwxChangePrefix(kd, [`${txid(2)}.3`, `${txid(1)}.0`])).toBe(a);
    expect(W.bwxChangePrefix(kd, [`${txid(1).toUpperCase()}.0`, `${txid(2)}.3`])).toBe(a);
    // Same seed, a new key deriver (a new device): the same prefix.
    const again = new KeyDeriver(kd.rootKey);
    expect(W.bwxChangePrefix(again, [`${txid(1)}.0`, `${txid(2)}.3`])).toBe(a);
  });

  test('different wallets or different inputs give different prefixes', () => {
    const kd = kdOf();
    const ins = [`${txid(1)}.0`];
    const p = W.bwxChangePrefix(kd, ins);
    expect(W.bwxChangePrefix(kdOf(), ins)).not.toBe(p);
    expect(W.bwxChangePrefix(kd, [`${txid(1)}.1`])).not.toBe(p);
    expect(W.bwxChangePrefix(kd, [`${txid(1)}.0`, `${txid(3)}.0`])).not.toBe(p);
  });

  test('same length as the random prefix (16 bytes, base64); suffix is the vout, valid base64', () => {
    const p = W.bwxChangePrefix(kdOf(), [`${txid(9)}.4`])!;
    expect(Utils.toArray(p, 'base64').length).toBe(16);
    expect(p.length).toBe(24);
    expect(() => validateBase64String(p, 'derivationPrefix')).not.toThrow();
    expect(W.bwxChangeSuffix(0)).toBe('MA==');
    expect(W.bwxChangeSuffix(12)).toBe('MTI=');
    for (const v of [0, 1, 9, 10, 255, 100000]) {
      const s = W.bwxChangeSuffix(v);
      expect(() => validateBase64String(s, 'derivationSuffix')).not.toThrow();
      expect(Utils.toUTF8(Utils.toArray(s, 'base64'))).toBe(String(v));
    }
  });

  test('no prefix (random change as before) for no inputs or a malformed outpoint', () => {
    const kd = kdOf();
    expect(W.bwxChangePrefix(kd, [])).toBeUndefined();
    expect(W.bwxChangePrefix(kd, ['undefined.0'])).toBeUndefined();
    expect(W.bwxChangePrefix(kd, [`${txid(1)}.0`, 'null.1'])).toBeUndefined();
    expect(W.bwxChangePrefix(undefined, [`${txid(1)}.0`])).toBeUndefined();
    expect(W.bwxDeterministicChange).toBe(true);
  });

  test('deterministicChangeOf finds exactly this wallet’s change outputs of a transaction', () => {
    const kd = kdOf();
    const tx = new Transaction();
    tx.addInput({ sourceTXID: txid(5), sourceOutputIndex: 2, unlockingScript: new UnlockingScript() });
    tx.addInput({ sourceTXID: txid(6), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    const ins = [`${txid(5)}.2`, `${txid(6)}.0`];
    const someone = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    tx.addOutput({ lockingScript: someone, satoshis: 1000 });
    tx.addOutput({ lockingScript: changeScript(kd, ins, 1), satoshis: 5 });
    tx.addOutput({ lockingScript: changeScript(kd, ins, 2), satoshis: 777 });
    // Right key, wrong vout: not change of this transaction.
    tx.addOutput({ lockingScript: changeScript(kd, ins, 0), satoshis: 9 });
    const found = deterministicChangeOf(kd, tx);
    expect(found.map((f) => [f.vout, f.satoshis])).toEqual([
      [1, 5],
      [2, 777],
    ]);
    expect(found[0].derivationPrefix).toBe(W.bwxChangePrefix(kd, ins)!);
    expect(found[0].derivationSuffix).toBe('MQ==');
    // Another wallet sees nothing of its own here.
    expect(deterministicChangeOf(kdOf(), tx)).toEqual([]);
  });
});

describe('WhatsOnChain spend lookup', () => {
  const res = (status: number, body?: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
  test('404 = unspent, 200 {txid} = spent, junk = unclear; dot outpoints only', async () => {
    const urls: string[] = [];
    const answers: Record<string, Response> = {
      [`${txid(1)}/0`]: res(404),
      [`${txid(1)}/1`]: res(200, { txid: txid(7).toUpperCase(), vin: 0, status: 'confirmed' }),
      [`${txid(1)}/2`]: res(200, { nope: 1 }),
      [`${txid(1)}/3`]: res(400),
    };
    const look = wocSpentLookup({
      fetch: async (u) => {
        urls.push(u);
        return answers[u.split('/tx/')[1].replace('/spent', '')];
      },
      minIntervalMs: 0,
      sleep: async () => undefined,
    });
    expect(await look(`${txid(1)}.0`)).toEqual({ state: 'unspent' });
    expect(await look(`${txid(1)}.1`)).toEqual({ state: 'spent', by: txid(7) });
    expect(await look(`${txid(1)}.2`)).toEqual({ state: 'unclear' });
    expect(await look(`${txid(1)}.3`)).toEqual({ state: 'unclear' });
    expect(await look(`${txid(1)}_0`)).toEqual({ state: 'unclear' });
    expect(urls[0]).toBe(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid(1)}/0/spent`);
  });

  test('429 is retried with waits; never spent or unspent without a clear answer', async () => {
    let n = 0;
    const waits: number[] = [];
    const look = wocSpentLookup({
      fetch: async () => (++n < 3 ? res(429) : res(404)),
      minIntervalMs: 0,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await look(`${txid(2)}.0`)).toEqual({ state: 'unspent' });
    expect(n).toBe(3);
    expect(waits.filter((w) => w >= 1000).length).toBe(2);
    const down = wocSpentLookup({ fetch: async () => res(503), minIntervalMs: 0, sleep: async () => undefined });
    expect(await down(`${txid(2)}.0`)).toEqual({ state: 'unclear' });
    const throws = wocSpentLookup({
      fetch: async () => {
        throw new Error('offline');
      },
      minIntervalMs: 0,
      sleep: async () => undefined,
    });
    expect(await throws(`${txid(2)}.0`)).toEqual({ state: 'unclear' });
  });

  test('calls are spaced (rate limit)', async () => {
    const at: number[] = [];
    const look = wocSpentLookup({
      fetch: async () => {
        at.push(Date.now());
        return res(404);
      },
      minIntervalMs: 40,
    });
    await Promise.all([look(`${txid(3)}.0`), look(`${txid(3)}.1`), look(`${txid(3)}.2`)]);
    expect(at.length).toBe(3);
    expect(at[2] - at[0]).toBeGreaterThanOrEqual(75);
  });
});

/** A small fake chain of this wallet's payments for the walk: deposit → p1 → p2 → p3 (change of p3 unspent). */
function fakeChain(kd: KeyDeriver, hops: number) {
  const raw = new Map<string, number[]>();
  const spent = new Map<string, string>();
  const someone = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
  const deposit = new Transaction();
  deposit.addInput({ sourceTXID: txid(77), sourceOutputIndex: 0, unlockingScript: someone });
  const depositAddr = PrivateKey.fromRandom().toAddress();
  deposit.addOutput({ lockingScript: new P2PKH().lock(depositAddr), satoshis: 100_000 });
  raw.set(deposit.id('hex'), deposit.toBinary());
  let prev = `${deposit.id('hex')}.0`;
  const txs: string[] = [];
  let sats = 100_000;
  for (let i = 0; i < hops; i++) {
    const tx = new Transaction();
    const [ptxid, pvout] = prev.split('.');
    tx.addInput({ sourceTXID: ptxid, sourceOutputIndex: Number(pvout), unlockingScript: someone });
    tx.addOutput({ lockingScript: someone, satoshis: 1000 });
    sats -= 1100;
    tx.addOutput({ lockingScript: changeScript(kd, [prev], 1), satoshis: sats });
    const id = tx.id('hex');
    raw.set(id, tx.toBinary());
    spent.set(prev, id);
    txs.push(id);
    prev = `${id}.1`;
  }
  return { raw, spent, txs, depositAddr, deposit: deposit.id('hex'), tail: prev, tailSats: sats };
}

const memKV = () => {
  let v: SeedChangeState | null = null;
  return {
    load: async () => (v ? (JSON.parse(JSON.stringify(v)) as SeedChangeState) : null),
    save: async (s: SeedChangeState) => void (v = JSON.parse(JSON.stringify(s))),
    peek: () => v,
  };
};

function walkDeps(kd: KeyDeriver, c: ReturnType<typeof fakeChain>, over: Partial<SeedChangeDeps> = {}) {
  const claimed: { txid: string; change: FoundChange[] }[] = [];
  const held = new Set<string>();
  let lookups = 0;
  const deps: SeedChangeDeps = {
    keyDeriver: kd as never,
    storageOutpoints: async () => ({ open: [], settled: [] }),
    seedAddresses: async () => [c.depositAddr],
    addressHistory: async (a) => (a === c.depositAddr ? [c.deposit, c.txs[0]] : []),
    spentBy: async (o): Promise<SpendState> => {
      lookups++;
      const by = c.spent.get(o);
      return by ? { state: 'spent', by } : { state: 'unspent' };
    },
    getRawTx: async (t) => c.raw.get(t),
    claim: async (t, change) => {
      claimed.push({ txid: t, change });
      return change.map((x) => {
        const k = `${t}.${x.vout}`;
        const state = held.has(k) ? ('already' as const) : ('restored' as const);
        held.add(k);
        return { vout: x.vout, state };
      });
    },
    kv: memKV(),
    ...over,
  };
  return { deps, claimed, lookups: () => lookups };
}

describe('the walk', () => {
  test('from a seed address forward along the change chain to the unspent tail, which is claimed', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 4);
    const { deps, claimed } = walkDeps(kd, c);
    const r = await recoverSeedChange(deps);
    expect(r.done).toBe(true);
    expect(r.restoredSats).toBe(c.tailSats);
    expect(claimed.map((x) => `${x.txid}.${x.change.map((y) => y.vout)}`)).toEqual([c.tail]);
    expect(seedChangeSummary(r)).toMatch(/^Found 0\.\d+ BSV of change from your 12 words/);
    expect(seedChangeSummary(r)).toMatch(/before this update can’t be found/);
  });

  test('idempotent: a second run claims nothing new and reports it as already in the wallet', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 3);
    const { deps } = walkDeps(kd, c);
    expect((await recoverSeedChange(deps)).restoredSats).toBe(c.tailSats);
    const again = await recoverSeedChange(deps);
    expect(again.restoredSats).toBe(0);
    expect(again.alreadySats).toBe(c.tailSats);
    expect(seedChangeSummary(again)).toMatch(/already in your wallet/);
  });

  test('resumable: a run that hits its time budget saves its place, and the next run finishes the walk', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 6);
    let clock = 0;
    const tick = 10;
    const { deps, claimed } = walkDeps(kd, c, {
      now: () => (clock += tick),
      runMs: 60, // a handful of steps per run
    });
    const runs = [];
    for (let i = 0; i < 20; i++) {
      const r = await recoverSeedChange(deps);
      runs.push(r);
      if (r.done) break;
      expect(r.paused).toBe(true);
      expect(seedChangeSummary(r)).toMatch(/Paused: checked/);
    }
    expect(runs.length).toBeGreaterThan(2);
    const last = runs[runs.length - 1];
    expect(last.done).toBe(true);
    expect(runs.reduce((n, r) => n + (r.restored ? 1 : 0), 0)).toBeGreaterThan(0);
    expect(claimed.map((x) => x.txid)).toEqual([c.tail.slice(0, 64)]);
  });

  test('depth limit: the walk stops after maxDepth hops and says so', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 6);
    const { deps, claimed } = walkDeps(kd, c, { maxDepth: 2 });
    const r = await recoverSeedChange(deps);
    expect(r.tooDeep).toBeGreaterThan(0);
    expect(claimed).toEqual([]);
  });

  test('a lookup with no clear answer is retried next run, never treated as unspent', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 2);
    let busy = true;
    const { deps, claimed } = walkDeps(kd, c, {
      spentBy: async (o) => {
        if (busy && o === c.tail) return { state: 'unclear' };
        const by = c.spent.get(o);
        return by ? { state: 'spent', by } : { state: 'unspent' };
      },
    });
    const r1 = await recoverSeedChange(deps);
    expect(r1.done).toBe(false);
    expect(r1.retry).toBe(1);
    expect(claimed).toEqual([]);
    expect(seedChangeSummary(r1)).toMatch(/no clear answer/);
    busy = false;
    const r2 = await recoverSeedChange(deps);
    expect(r2.done).toBe(true);
    expect(r2.restoredSats).toBe(c.tailSats);
  });

  test('storage start points: a coin storage thinks unspent, spent on chain by a payment storage lost', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 2);
    const { deps } = walkDeps(kd, c, {
      seedAddresses: async () => [],
      // the first payment's change is held as spendable; the chain says the second payment spent it
      storageOutpoints: async () => ({ open: [`${c.txs[0]}.1`], settled: [] }),
    });
    const r = await recoverSeedChange(deps);
    expect(r.restoredSats).toBe(c.tailSats);
  });

  test('outputs storage holds as spent by its own settled payment are not looked up again', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 3);
    const looked: string[] = [];
    const { deps } = walkDeps(kd, c, {
      storageOutpoints: async () => ({ open: [c.tail], settled: [`${c.txs[0]}.1`, `${c.txs[1]}.1`] }),
      spentBy: async (o) => {
        looked.push(o);
        const by = c.spent.get(o);
        return by ? { state: 'spent', by } : { state: 'unspent' };
      },
    });
    await recoverSeedChange(deps);
    expect(looked).not.toContain(`${c.txs[0]}.1`);
    expect(looked).not.toContain(`${c.txs[1]}.1`);
    expect(looked).toContain(c.tail);
  });

  test('a payment not mined yet stays pending and is claimed by a later run', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 2);
    let mined = false;
    const { deps, claimed } = walkDeps(kd, c);
    const inner = deps.claim;
    deps.claim = async (t, ch) => (mined ? inner(t, ch) : ch.map((x) => ({ vout: x.vout, state: 'pending' as const })));
    const r1 = await recoverSeedChange(deps);
    expect(r1.pendingSats).toBe(c.tailSats);
    expect(seedChangeSummary(r1)).toMatch(/waiting for a block/);
    mined = true;
    const r2 = await recoverSeedChange(deps);
    expect(r2.restoredSats).toBe(c.tailSats);
    expect(claimed.length).toBe(1);
  });

  test('nothing of this wallet’s on chain: honest answer, no claims', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(new KeyDeriver(PrivateKey.fromRandom()), 3); // someone else's payments
    const { deps, claimed } = walkDeps(kd, c);
    const r = await recoverSeedChange(deps);
    expect(r.done).toBe(true);
    expect(claimed).toEqual([]);
    expect(seedChangeSummary(r)).toMatch(/no missing change found\. Change from payments made before this update/);
  });

  test('saved progress holds only public data', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 3);
    const kv = memKV();
    const { deps } = walkDeps(kd, c, { kv });
    await recoverSeedChange(deps);
    const json = JSON.stringify(kv.peek());
    expect(json).not.toMatch(/derivation|prefix|suffix/i);
    const prefix = W.bwxChangePrefix(kd, [`${c.txs[1]}.1`])!;
    expect(json).not.toContain(prefix);
  });
});
