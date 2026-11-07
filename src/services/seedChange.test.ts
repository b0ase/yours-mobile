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
  registerWalletOriginator,
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
    expect(await look(`${txid(1)}.1`)).toEqual({ state: 'spent', by: txid(7), confirmed: true });
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
      storageOutpoints: async () => ({
        open: [c.tail],
        settled: [
          [`${c.txs[0]}.1`, c.txs[1]],
          [`${c.txs[1]}.1`, c.txs[2]],
        ],
      }),
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

/**
 * Review 07b, M2 (stuck scan), as the reviewer wrote it: a coin storage holds, its change lost and claimed in run 1; a
 * seed address whose history can never be read (over 4096 entries); later the recovered coin is spent in p2 and p2 is
 * lost too. Before the fix the scan never re-read storage, kept "unspent" cached and never finished, so p2's change was
 * never found.
 */
function stuckWorld(kd: KeyDeriver) {
  const someone = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
  const raw = new Map<string, number[]>();
  const spent = new Map<string, string>();
  const mk = (prev: string, sats: number) => {
    const tx = new Transaction();
    const [p, v] = prev.split('.');
    tx.addInput({ sourceTXID: p, sourceOutputIndex: Number(v), unlockingScript: someone });
    tx.addOutput({ lockingScript: someone, satoshis: 1000 });
    tx.addOutput({ lockingScript: changeScript(kd, [prev], 1), satoshis: sats });
    const id = tx.id('hex');
    raw.set(id, tx.toBinary());
    spent.set(prev, id);
    return id;
  };
  const coin = `${txid(5)}.0`;
  const p1 = mk(coin, 50_000);
  const kv = memKV();
  const claimed: string[] = [];
  const world = { storageOpen: [coin], clock: 1_000_000 };
  const deps: SeedChangeDeps = {
    keyDeriver: kd as never,
    storageOutpoints: async () => ({ open: world.storageOpen, settled: [] }),
    seedAddresses: async () => ['1BusyAddressWithOver4096Entries'],
    addressHistory: async () => undefined, // never readable
    spentBy: async (o) => {
      const by = spent.get(o);
      return by ? { state: 'spent', by } : { state: 'unspent' };
    },
    getRawTx: async (t) => raw.get(t),
    claim: async (t, ch) =>
      ch.map((c) => {
        claimed.push(`${t}.${c.vout}`);
        return { vout: c.vout, state: 'restored' as const };
      }),
    kv,
    now: () => world.clock,
  };
  return { deps, mk, p1, claimed, kv, world };
}

describe('review 07b fixes: the scan never gets stuck (M2)', () => {
  test('reviewer’s scenario: a later lost payment is found on the next run, and the unreadable address is given up', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const { deps, mk, p1, claimed, kv, world } = stuckWorld(kd);
    const r1 = await recoverSeedChange(deps);
    expect(claimed).toEqual([`${p1}.1`]);
    expect(r1.done).toBe(false); // the busy address is retried next run
    expect(r1.retry).toBe(1);
    // An hour later: the recovered coin was spent in p2, and p2 was lost too.
    const p2 = mk(`${p1}.1`, 40_000);
    world.storageOpen = [`${p1}.1`];
    world.clock += 3600_000;
    const r2 = await recoverSeedChange(deps);
    expect(claimed).toContain(`${p2}.1`);
    expect(r2.restoredSats).toBe(50_000 + 40_000);
    // The address fails its third run and is given up on: the scan finishes and says so.
    world.clock += 60_000;
    const r3 = await recoverSeedChange(deps);
    expect(r3.done).toBe(true);
    expect(r3.gaveUp).toBe(1);
    expect(kv.peek()!.gaveUp.map((g) => g.id)).toEqual(['1BusyAddressWithOver4096Entries']);
    expect(seedChangeSummary(r3)).toMatch(
      /1 item couldn’t be checked after several tries and was skipped; Start fresh/,
    );
  });

  test('the reviewer’s file as written (no clock): p2’s change is found within the same six taps', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const { deps, mk, p1, claimed, kv, world } = stuckWorld(kd);
    deps.now = undefined;
    const r1 = await recoverSeedChange(deps);
    expect(claimed).toEqual([`${p1}.1`]);
    expect(r1.done).toBe(false);
    const p2 = mk(`${p1}.1`, 40_000);
    world.storageOpen = [`${p1}.1`];
    for (let i = 0; i < 5; i++) await recoverSeedChange(deps);
    expect(claimed.includes(`${p2}.1`)).toBe(true);
    expect(kv.peek()!.done).toBe(true);
  });

  test('start points are read on every run; an "unspent" answer older than recheckMs is asked again', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 2);
    let clock = 0;
    const asked: string[] = [];
    let open: string[] = [];
    const { deps } = walkDeps(kd, c, {
      now: () => clock,
      seedAddresses: async () => [],
      storageOutpoints: async () => ({ open, settled: [] }),
      spentBy: async (o) => {
        asked.push(o);
        const by = c.spent.get(o);
        return by ? { state: 'spent', by } : { state: 'unspent' };
      },
      addressHistory: async () => [],
      maxTries: 99,
    });
    // Keep the scan open with a lookup that stays unclear, so later runs resume rather than start fresh.
    const inner = deps.spentBy;
    deps.spentBy = async (o) => (o === `${txid(99)}.0` ? { state: 'unclear' } : inner(o));
    open = [`${txid(99)}.0`, c.tail];
    await recoverSeedChange(deps);
    expect(asked.filter((o) => o === c.tail).length).toBe(1);
    clock += 60_000; // a minute later: the answer stands
    await recoverSeedChange(deps);
    expect(asked.filter((o) => o === c.tail).length).toBe(1);
    clock += 15 * 60_000; // later: asked again
    open = [...open, `${c.txs[0]}.1`]; // and a new start point from storage is picked up
    await recoverSeedChange(deps);
    expect(asked.filter((o) => o === c.tail).length).toBe(2);
    expect(asked).toContain(`${c.txs[0]}.1`);
  });

  test('a scan expires after maxRuns runs or maxAgeMs, and Start fresh throws the saved scan away', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 1);
    let clock = 0;
    const { deps } = walkDeps(kd, c, {
      now: () => clock,
      seedAddresses: async () => ['1Busy'],
      addressHistory: async () => undefined,
      maxTries: 99,
      maxRuns: 3,
      maxAgeMs: 3600_000,
    });
    expect((await recoverSeedChange(deps)).runs).toBe(1);
    expect((await recoverSeedChange(deps)).runs).toBe(2);
    expect((await recoverSeedChange(deps)).runs).toBe(3);
    expect((await recoverSeedChange(deps)).runs).toBe(1); // expired by runs
    clock += 2 * 3600_000;
    expect((await recoverSeedChange(deps)).runs).toBe(1); // expired by age
    expect((await recoverSeedChange(deps)).runs).toBe(2);
    expect((await recoverSeedChange({ ...deps, fresh: true })).runs).toBe(1); // Start fresh
  });
});

describe('review 07b fixes: refusal, per-account runs, timeouts, claim budget (L1, L3)', () => {
  test('a refusal (remote store still active) stops the run before anything is read', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 2);
    let read = 0;
    const { deps, claimed } = walkDeps(kd, c, {
      refusal: () => 'this account’s main copy is still the remote backup',
      storageOutpoints: async () => {
        read++;
        return { open: [], settled: [] };
      },
    });
    const r = await recoverSeedChange(deps);
    expect(r.error).toMatch(/remote backup/);
    expect(read).toBe(0);
    expect(claimed).toEqual([]);
    expect(seedChangeSummary(r)).toMatch(/^Couldn’t run: this account’s main copy/);
  });

  test('runs are per account: a second account runs its own scan; the same account joins the run in flight', async () => {
    const kdA = new KeyDeriver(PrivateKey.fromRandom());
    const kdB = new KeyDeriver(PrivateKey.fromRandom());
    const a = walkDeps(kdA, fakeChain(kdA, 2));
    const b = walkDeps(kdB, fakeChain(kdB, 3));
    const [ra, rb, ra2] = await Promise.all([
      recoverSeedChange(a.deps),
      recoverSeedChange(b.deps),
      recoverSeedChange(a.deps),
    ]);
    expect(ra).toBe(ra2);
    expect(rb).not.toBe(ra);
    expect(a.claimed.length).toBe(1);
    expect(b.claimed.length).toBe(1);
    expect(rb.restoredSats).not.toBe(ra.restoredSats);
  });

  test('a WhatsOnChain call that never answers times out and is reported unclear', async () => {
    const look = wocSpentLookup({
      fetch: () => new Promise<Response>(() => undefined),
      minIntervalMs: 0,
      attempts: 2,
      timeoutMs: 20,
      sleep: async () => undefined,
    });
    const t0 = Date.now();
    expect(await look(`${txid(4)}.0`)).toEqual({ state: 'unclear' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('claims stay inside the run budget: what doesn’t fit is claimed next run', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const c = fakeChain(kd, 2);
    let clock = 0;
    const { deps, claimed } = walkDeps(kd, c, { now: () => clock, runMs: 1000 });
    // The walk itself is instant; the claim finds the budget already spent.
    const innerSpent = deps.spentBy;
    deps.spentBy = async (o) => {
      const r = await innerSpent(o);
      if (o === c.tail) clock += 5000; // the tail's lookup uses up the whole budget
      return r;
    };
    const r1 = await recoverSeedChange(deps);
    expect(claimed).toEqual([]);
    expect(r1.paused).toBe(true);
    expect(r1.done).toBe(false);
    const r2 = await recoverSeedChange(deps);
    expect(claimed.map((x) => `${x.txid}.${x.change.map((y) => y.vout).join(',')}`)).toEqual([c.tail]);
    expect(r2.restoredSats).toBe(c.tailSats);
  });

  test('registerWalletOriginator marks the wallet’s own originator for the toolbox', () => {
    const set = (Wallet as unknown as { bwxWalletOriginators: Set<string> }).bwxWalletOriginators;
    const before = set.has('wallet-own.test');
    registerWalletOriginator('wallet-own.test');
    expect(set.has('wallet-own.test')).toBe(true);
    if (!before) set.delete('wallet-own.test');
  });
});

/**
 * Re-review of 50a37356 (liveness): the reviewer's simulations (model/review/recheck.test.ts and starve.test.ts) with a
 * simulated clock: 350 ms per WhatsOnChain lookup, 150 ms per transaction fetch, 4-minute runs, taps back to back.
 * Before the fix: 3000 coins never finished, a seed address was never read, and walks needing more than 20 runs (or 2
 * days) lost their progress on expiry.
 */
function sim(o: {
  open: number;
  hops: number;
  seed?: 'deposit-only' | 'with-spend';
  maxRuns?: number;
  maxAgeMs?: number;
  tapGapMs?: number;
}) {
  let clock = 1_000_000;
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const someone = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
  const raw = new Map<string, number[]>();
  const spent = new Map<string, string>();
  const seedAddress = PrivateKey.fromRandom().toAddress();
  let prev = `${txid(999999)}.0`;
  const startCoin = prev;
  let firstHop = '';
  if (o.seed) {
    // A deposit to a seed address starts the chain: nothing in storage knows it.
    const dep = new Transaction();
    dep.addInput({ sourceTXID: txid(777777), sourceOutputIndex: 0, unlockingScript: someone });
    dep.addOutput({ lockingScript: new P2PKH().lock(seedAddress), satoshis: 100_000 });
    raw.set(dep.id('hex'), dep.toBinary());
    prev = `${dep.id('hex')}.0`;
  }
  const deposit = prev.slice(0, 64);
  let tail = '';
  for (let i = 0; i < o.hops; i++) {
    const tx = new Transaction();
    const [p, v] = prev.split('.');
    tx.addInput({ sourceTXID: p, sourceOutputIndex: Number(v), unlockingScript: someone });
    tx.addOutput({ lockingScript: changeScript(kd, [prev], 0), satoshis: 1000 });
    const id = tx.id('hex');
    if (!firstHop) firstHop = id;
    raw.set(id, tx.toBinary());
    spent.set(prev, id);
    prev = `${id}.0`;
    tail = prev;
  }
  const open = [...(o.seed ? [] : [startCoin]), ...Array.from({ length: o.open }, (_, i) => `${txid(i + 1)}.0`)];
  const kv = memKV();
  const claimed: string[] = [];
  let lookups = 0;
  let addressReads = 0;
  const deps: SeedChangeDeps = {
    keyDeriver: kd as never,
    now: () => clock,
    storageOutpoints: async () => ({ open, settled: [] }),
    seedAddresses: async () => (o.seed ? [seedAddress] : []),
    addressHistory: async () => {
      clock += 500;
      addressReads++;
      // WhatsOnChain lists the transactions that spend from the address too; the reviewer's mock listed only the deposit.
      return o.seed === 'with-spend' ? [deposit, firstHop] : [deposit];
    },
    spentBy: async (x) => {
      clock += 350;
      lookups++;
      const by = spent.get(x);
      return by ? { state: 'spent', by, confirmed: true } : { state: 'unspent' };
    },
    getRawTx: async (t) => {
      clock += 150;
      return raw.get(t);
    },
    claim: async (t, ch) =>
      ch.map((c) => {
        claimed.push(`${t}.${c.vout}`);
        return { vout: c.vout, state: 'restored' as const };
      }),
    kv,
    maxRuns: o.maxRuns,
    maxAgeMs: o.maxAgeMs,
  };
  const run = async () => {
    const r = await recoverSeedChange(deps);
    clock += o.tapGapMs ?? 5_000;
    return r;
  };
  return { deps, run, tail, claimed, kv, lookups: () => lookups, addressReads: () => addressReads };
}

describe('re-review fixes: liveness on big wallets and long walks', () => {
  test('3000 coins in storage, taps back to back: the scan finishes, each coin asked at most twice', async () => {
    const s = sim({ open: 3000, hops: 0 });
    let done = 0;
    for (let i = 1; i <= 45 && !done; i++) if ((await s.run()).done) done = i;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThanOrEqual(12);
    expect(s.lookups()).toBeLessThanOrEqual(2 * 3001);
  }, 120000);

  test('3000 coins, taps far apart (over recheckMs): still finishes', async () => {
    const s = sim({ open: 3000, hops: 0, tapGapMs: 3600_000 });
    let done = 0;
    for (let i = 1; i <= 45 && !done; i++) if ((await s.run()).done) done = i;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThanOrEqual(14);
  }, 120000);

  test('a walk longer than maxRuns runs keeps its progress through expiry and claims the tail', async () => {
    const s = sim({ open: 0, hops: 1500, maxRuns: 2 });
    let done = 0;
    let examinedBefore = 0;
    for (let i = 1; i <= 30 && !done; i++) {
      const r = await s.run();
      const ex = s.kv.peek()!.examined.length;
      expect(ex).toBeGreaterThanOrEqual(examinedBefore); // expiry never throws the walk away
      examinedBefore = ex;
      if (r.done) done = i;
    }
    expect(done).toBeGreaterThan(2); // took more runs than maxRuns
    expect(s.claimed).toEqual([s.tail]);
  }, 120000);

  test('a walk spread over more than maxAgeMs keeps its progress too', async () => {
    const s = sim({ open: 0, hops: 1500, maxAgeMs: 60_000, tapGapMs: 3600_000 });
    let done = 0;
    for (let i = 1; i <= 30 && !done; i++) if ((await s.run()).done) done = i;
    expect(done).toBeGreaterThan(1);
    expect(s.claimed).toEqual([s.tail]);
  }, 120000);

  test('3000 coins in storage + a lost chain reachable only from a seed address: found on the first tap', async () => {
    for (const seed of ['deposit-only', 'with-spend'] as const) {
      const s = sim({ open: 3000, hops: 20, seed });
      await s.run();
      expect(s.addressReads()).toBe(1); // read before any coin
      expect(s.claimed).toEqual([s.tail]);
    }
  }, 120000);

  test('a finished scan’s next tap keeps mined spends: the chain is walked again without asking for them', async () => {
    const s = sim({ open: 0, hops: 50 });
    let r = await s.run();
    while (!r.done) r = await s.run();
    const first = s.lookups();
    expect(first).toBe(51); // 50 spends + the unspent tail
    r = await s.run(); // a new scan
    expect(s.lookups() - first).toBe(1); // only the tail is asked again
    expect(r.alreadySats + r.restoredSats).toBeGreaterThan(0);
  }, 120000);
});

describe('re-review fix: a settled spender with only some of its change rows (L2 gap)', () => {
  test('the walk examines the spender storage knows and finds the change row that is missing', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const someone = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    const coin = `${txid(42)}.0`;
    const tx = new Transaction();
    tx.addInput({ sourceTXID: txid(42), sourceOutputIndex: 0, unlockingScript: someone });
    tx.addOutput({ lockingScript: someone, satoshis: 1000 });
    tx.addOutput({ lockingScript: changeScript(kd, [coin], 1), satoshis: 7000 });
    tx.addOutput({ lockingScript: changeScript(kd, [coin], 2), satoshis: 8000 });
    const T = tx.id('hex');
    const looked: string[] = [];
    const claimed: string[] = [];
    const deps: SeedChangeDeps = {
      keyDeriver: kd as never,
      // Storage: the coin is spent by T (completed), T's change at vout 1 is held, the row for vout 2 is missing.
      storageOutpoints: async () => ({ open: [`${T}.1`], settled: [[coin, T]] }),
      seedAddresses: async () => [],
      addressHistory: async () => [],
      spentBy: async (o) => {
        looked.push(o);
        return { state: 'unspent' };
      },
      getRawTx: async (t) => (t === T ? tx.toBinary() : undefined),
      claim: async (t, ch) =>
        ch.map((c) => {
          claimed.push(`${t}.${c.vout}`);
          return { vout: c.vout, state: c.vout === 1 ? ('already' as const) : ('restored' as const) };
        }),
      kv: memKV(),
    };
    const r = await recoverSeedChange(deps);
    expect(looked).not.toContain(coin); // storage's spender used, no network call
    expect(claimed).toContain(`${T}.2`);
    expect(r.restoredSats).toBe(8000);
    expect(r.alreadySats).toBe(7000);
  });
});

/**
 * Re-review 07c (model/review/capAndAddrs.test.ts and starveReal.test.ts), ported with assertions. Simulated clock:
 * 350 ms per WhatsOnChain lookup, 150 ms per transaction fetch, readMs per address history, 4-minute runs.
 */
function lostFrom(kd: KeyDeriver, coin: string) {
  const stranger = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
  const t = new Transaction();
  const [p, v] = coin.split('.');
  t.addInput({ sourceTXID: p, sourceOutputIndex: Number(v), unlockingScript: stranger });
  t.addOutput({ lockingScript: stranger, satoshis: 100 });
  t.addOutput({ lockingScript: changeScript(kd, [coin], 1), satoshis: 50_000 });
  return { id: t.id('hex'), raw: t.toBinary(), tail: `${t.id('hex')}.1` };
}

describe('re-review 07c F1: seed addresses can’t starve coin lookups', () => {
  test('200 (and 1000 throttled) seed addresses: a payment lost from a storage coin is still found on the first tap', async () => {
    for (const [n, readMs] of [
      [200, 1000],
      [1000, 2500],
    ] as const) {
      let clock = 1e6;
      const kd = new KeyDeriver(PrivateKey.fromRandom());
      const coin = `${txid(42)}.0`;
      const L = lostFrom(kd, coin);
      const addrs = Array.from({ length: n }, () => PrivateKey.fromRandom().toAddress());
      const claimed: string[] = [];
      const kv = memKV();
      let reads = 0;
      const deps: SeedChangeDeps = {
        keyDeriver: kd as never,
        now: () => clock,
        kv,
        storageOutpoints: async () => ({
          open: [coin, ...Array.from({ length: 300 }, (_, i) => `${txid(i + 100)}.0`)],
          settled: [],
        }),
        seedAddresses: async () => addrs,
        addressHistory: async () => {
          clock += readMs;
          reads++;
          return [];
        },
        spentBy: async (o) => {
          clock += 350;
          return o === coin ? { state: 'spent', by: L.id, confirmed: true } : { state: 'unspent' };
        },
        getRawTx: async (t) => {
          clock += 150;
          return t === L.id ? L.raw : undefined;
        },
        claim: async (t, ch) =>
          ch.map((c) => {
            claimed.push(`${t}.${c.vout}`);
            return { vout: c.vout, state: 'restored' as const };
          }),
      };
      const r1 = await recoverSeedChange(deps);
      clock += 5000;
      expect(claimed).toEqual([L.tail]);
      expect(kv.peek()!.stats.lookups).toBeGreaterThan(300);
      // The rest of the addresses are read on the following taps and the scan finishes. Each address is read once, and
      // at most once more in the scan's recheck pass (when it was read over recheckMs before the walk drained).
      let r = r1;
      for (let i = 0; i < 40 && !r.done; i++) {
        r = await recoverSeedChange(deps);
        clock += 5000;
      }
      expect(r.done).toBe(true);
      expect(reads).toBeGreaterThanOrEqual(n);
      expect(reads).toBeLessThanOrEqual(2 * n);
    }
  }, 300000);

  test('realistic: 3000 coins, 33 seed addresses (one busy), a lost chain from a deposit address: found on tap 1', async () => {
    for (const gap of [5_000, 3_600_000]) {
      let clock = 1_000_000;
      const kd = new KeyDeriver(PrivateKey.fromRandom());
      const stranger = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
      const raw = new Map<string, number[]>();
      const spent = new Map<string, string>();
      const history = new Map<string, string[]>();
      const add = (tx: Transaction) => {
        const id = tx.id('hex');
        raw.set(id, tx.toBinary());
        for (const i of tx.inputs) spent.set(`${i.sourceTXID}.${i.sourceOutputIndex}`, id);
        return id;
      };
      const seed = Array.from({ length: 33 }, () => PrivateKey.fromRandom().toAddress());
      for (const a of seed) history.set(a, []);
      for (let i = 0; i < 200; i++) {
        const t = new Transaction();
        t.addInput({ sourceTXID: txid(5_000_000 + i), sourceOutputIndex: 0, unlockingScript: stranger });
        t.addOutput({ lockingScript: new P2PKH().lock(seed[0]), satoshis: 500 });
        history.get(seed[0])!.push(add(t));
      }
      const D = seed[3];
      const dep = new Transaction();
      dep.addInput({ sourceTXID: txid(7_777_777), sourceOutputIndex: 0, unlockingScript: stranger });
      dep.addOutput({ lockingScript: new P2PKH().lock(D), satoshis: 100_000 });
      const depId = add(dep);
      history.get(D)!.push(depId);
      let prev = `${depId}.0`;
      let tail = '';
      for (let i = 0; i < 20; i++) {
        const t = new Transaction();
        const [p, v] = prev.split('.');
        t.addInput({ sourceTXID: p, sourceOutputIndex: Number(v), unlockingScript: stranger });
        t.addOutput({ lockingScript: stranger, satoshis: 100 });
        t.addOutput({ lockingScript: changeScript(kd, [prev], 1), satoshis: 90_000 - i * 200 });
        const id = add(t);
        if (i === 0) history.get(D)!.push(id);
        prev = `${id}.1`;
        tail = prev;
      }
      const open = Array.from({ length: 3000 }, (_, i) => `${txid(i + 1)}.0`);
      const claimed: string[] = [];
      const deps: SeedChangeDeps = {
        keyDeriver: kd as never,
        now: () => clock,
        storageOutpoints: async () => ({ open, settled: [] }),
        seedAddresses: async () => seed,
        addressHistory: async (a) => {
          clock += 1000;
          return history.get(a) ?? [];
        },
        spentBy: async (op) => {
          clock += 350;
          const by = spent.get(op);
          return by ? { state: 'spent', by, confirmed: true } : { state: 'unspent' };
        },
        getRawTx: async (t) => {
          clock += 150;
          return raw.get(t);
        },
        claim: async (t, ch) =>
          ch.map((c) => {
            claimed.push(`${t}.${c.vout}`);
            return { vout: c.vout, state: 'restored' as const };
          }),
        kv: memKV(),
      };
      await recoverSeedChange(deps);
      clock += gap;
      expect(claimed).toContain(tail);
    }
  }, 300000);
});

describe('re-review 07c F2: open coins before settled history; the limit is reported', () => {
  function capWorld(lossFromReceived: boolean) {
    let clock = 1e6;
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const stranger = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    const raw = new Map<string, number[]>();
    const settled: [string, string][] = [];
    let prev = `${txid(9)}.0`;
    for (let i = 0; i < 300; i++) {
      const t = new Transaction();
      const [p, v] = prev.split('.');
      t.addInput({ sourceTXID: p, sourceOutputIndex: Number(v), unlockingScript: stranger });
      t.addOutput({ lockingScript: stranger, satoshis: 1 });
      const id = t.id('hex');
      raw.set(id, t.toBinary());
      settled.push([prev, id]);
      prev = `${id}.0`;
    }
    const received = `${txid(77)}.3`; // a received coin storage thinks unspent (not change of a stored payment)
    const L = lostFrom(kd, received);
    raw.set(L.id, L.raw);
    const claimed: string[] = [];
    const deps: SeedChangeDeps = {
      keyDeriver: kd as never,
      now: () => clock,
      kv: memKV(),
      maxTxs: 200, // stands in for the default 20 000
      storageOutpoints: async () => ({ open: lossFromReceived ? [received] : [], settled }),
      seedAddresses: async () => [],
      addressHistory: async () => [],
      spentBy: async (o) => {
        clock += 350;
        return o === received ? { state: 'spent', by: L.id, confirmed: true } : { state: 'unspent' };
      },
      getRawTx: async (t) => {
        clock += 5;
        return raw.get(t);
      },
      claim: async (t, ch) =>
        ch.map((c) => {
          claimed.push(`${t}.${c.vout}`);
          return { vout: c.vout, state: 'restored' as const };
        }),
    };
    return { deps, claimed, L, tick: () => (clock += 5000) };
  }

  test('a payment lost from an open coin is found before the transaction cap is used up on settled history', async () => {
    const w = capWorld(true);
    let r = await recoverSeedChange(w.deps);
    for (let i = 0; i < 2; i++) {
      w.tick();
      r = await recoverSeedChange(w.deps);
    }
    expect(w.claimed).toContain(w.L.tail);
    expect(r.tooDeep).toBeGreaterThan(0);
    expect(seedChangeSummary(r)).toMatch(/Stopped at this scan’s limit: \d+ more payments were not checked/);
  }, 120000);

  test('when the cap is hit and nothing was found, the summary never says "no missing change found"', async () => {
    const w = capWorld(false);
    const r = await recoverSeedChange(w.deps);
    expect(r.done).toBe(true);
    expect(r.tooDeep).toBeGreaterThan(0);
    const text = seedChangeSummary(r);
    expect(text).not.toMatch(/no missing change found/);
    expect(text).toMatch(/some change may still be missing/);
  }, 120000);
});
