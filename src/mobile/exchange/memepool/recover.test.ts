/**
 * "Recover now" (trade.ts recoverNow / stuckFundings, wallet.ts spendBack): a user-tapped self-spend of a funding
 * coin the sweep can't return. Real keys and signatures (ProtoWallet); the wallet's createAction / signAction and
 * the network (WhatsOnChain: /spent, /tx/hash, /tx/<id>/hex, /address/../unspent/all) are stubbed, and so are the
 * wallet's services: BEEF with real merkle paths, checked against a stub ChainTracker. Nothing is broadcast.
 */
import { describe, expect, test } from 'bun:test';
import {
  Beef,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Spend,
  Transaction,
  UnlockingScript,
  type WalletInterface,
} from '@bsv/sdk';
import { FeaturePausedError } from '../../config/killSwitch';
import {
  NONCE_ONLY_DROP_MS,
  TOMBSTONE_KEEP_MS,
  idOf,
  liveRecords,
  type PendingRecord,
  type PendingStore,
} from './pending';
import { signSelfSpend } from './sign';
import { recoverMessage, recoverNow, stuckFundings, sweepFundings, type Deps } from './trade';
import { memepoolWallet } from './wallet';

const SATS = 1_056_000;
const POOL = 'aa'.repeat(32);
const HOUR = 60 * 60_000;
const MAX_RECOVERY_FEE = 2_000;
const HEIGHT = 900_000;

/** What the stub wallet does with the transaction it builds. */
type Build = 'ok' | 'foreign-output' | 'no-output';
/** 'double-ours': the broadcaster flags our recovery as a double spend, yet it is our recovery that gets mined. */
type Mode = 'ok' | 'double' | 'double-ours' | 'fail';

async function rig(opts: { services?: boolean; mode?: Mode; build?: Build } = {}) {
  let now = Date.now();
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const log = {
    created: [] as Record<string, unknown>[],
    signed: [] as { reference: string; spends: Record<number, { unlockingScript: string }> }[],
    signatures: 0,
    aborted: 0,
    broadcast: [] as string[],
    internalized: [] as { outputs: { outputIndex: number; protocol: string }[] }[],
  };
  /** The network: outpoint → spender txid; txid → real transaction. */
  const spent = new Map<string, string>();
  const txs = new Map<string, { raw: string; confirmed: boolean }>();
  /** Address → unspent coins (WhatsOnChain /address/../unspent/all). */
  const utxos = new Map<string, { tx_hash: string; tx_pos: number; value: number }[]>();
  /** Addresses whose lookup always fails (HTTP 500). */
  const failing = new Set<string>();
  /** Transactions with a merkle path (services.getBeefForTxid), and the block roots the ChainTracker accepts. */
  const proofs = new Map<string, Transaction>();
  const roots = new Set<string>();
  /** Give `tx` a merkle path in block HEIGHT; `valid` = the ChainTracker knows that root. */
  const prove = (tx: Transaction, valid = true) => {
    const id = tx.id('hex');
    const path = new MerklePath(HEIGHT, [
      [
        { offset: 0, hash: 'bb'.repeat(32) },
        { offset: 1, hash: id, txid: true },
      ],
    ]);
    if (valid) roots.add(path.computeRoot(id));
    tx.merklePath = path;
    proofs.set(id, tx);
  };
  let mode: Mode = opts.mode ?? 'ok';
  let createError: Error | null = null;
  let fundTx: Transaction | null = null;
  let spendTx: Transaction | null = null;

  const wallet = {
    getPublicKey: (a: never) => proto.getPublicKey(a),
    createSignature: async (a: never) => {
      log.signatures++;
      return proto.createSignature(a);
    },
    createAction: async (a: { outputs: { lockingScript: string; satoshis: number }[] }) => {
      log.created.push(a as never);
      await new Promise((r) => setTimeout(r, 5)); // a real wallet takes a moment: lets a second call overlap
      if (createError) throw createError;
      const requested = (opts.build === 'no-output' ? [] : a.outputs).map((o) => ({
        lockingScript: LockingScript.fromHex(o.lockingScript),
        satoshis: o.satoshis,
      }));
      const asked = requested.reduce((s, o) => s + o.satoshis, 0);
      const change = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
      // A stranger's output beyond the fee allowance. (Inside the allowance it can't be told from the wallet's own
      // change, which is why the allowance is a small fixed cap: at most MAX_RECOVERY_FEE can go anywhere else.)
      const extra =
        opts.build === 'foreign-output'
          ? [{ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5_000 }]
          : [];
      const rest = SATS - asked - 120 - extra.reduce((s, o) => s + o.satoshis, 0);
      spendTx = new Transaction(
        1,
        [
          {
            sourceTransaction: fundTx!,
            sourceOutputIndex: 0,
            sequence: 0xffffffff,
            unlockingScript: new UnlockingScript(),
          },
        ],
        [...requested, ...extra, ...(rest > 0 ? [{ lockingScript: change, satoshis: rest }] : [])],
        0,
      );
      const b = new Beef();
      b.mergeTransaction(fundTx!);
      b.mergeTransaction(spendTx);
      return { signableTransaction: { tx: b.toBinaryAtomic(spendTx.id('hex')), reference: 'ref1' } };
    },
    signAction: async (a: { reference: string; spends: Record<number, { unlockingScript: string }> }) => {
      log.signed.push(a);
      const key = `${fundTx!.id('hex')}_0`;
      if (mode === 'double-ours') {
        spendTx!.inputs[0].unlockingScript = UnlockingScript.fromHex(a.spends[0].unlockingScript);
        const ours = spendTx!.id('hex');
        txs.set(ours, { raw: spendTx!.toHex(), confirmed: true });
        prove(spendTx!);
        spent.set(key, ours);
        throw Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
          reviewActionResults: [{ txid: ours, status: 'doubleSpend' }],
        });
      }
      if (mode === 'double') {
        const won = await memepoolSpend('valid'); // Memepool's trade got there first, proven in a block
        throw Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
          reviewActionResults: [{ txid: 'dd'.repeat(32), status: 'doubleSpend', competingTxs: [won] }],
        });
      }
      if (mode === 'fail') throw new Error('storage offline');
      spendTx!.inputs[0].unlockingScript = UnlockingScript.fromHex(a.spends[0].unlockingScript);
      const txid = spendTx!.id('hex');
      log.broadcast.push(txid);
      spent.set(key, txid);
      txs.set(txid, { raw: spendTx!.toHex(), confirmed: false });
      const b = new Beef();
      b.mergeTransaction(fundTx!);
      b.mergeTransaction(spendTx!);
      return { txid, tx: b.toBinaryAtomic(txid) };
    },
    abortAction: async () => {
      log.aborted++;
      return { aborted: true };
    },
    internalizeAction: async (a: { outputs: { outputIndex: number; protocol: string }[] }) => {
      log.internalized.push(a);
      return { accepted: true };
    },
  } as unknown as WalletInterface;

  const services =
    opts.services === false
      ? undefined
      : {
          getBeefForTxid: async (txid: string) => {
            const b = new Beef();
            const t = proofs.get(txid) ?? (txid === fundTx!.id('hex') ? fundTx! : null);
            if (!t) throw new Error('not found');
            b.mergeTransaction(t);
            return b;
          },
          getChainTracker: async () => ({
            isValidRootForHeight: async (root: string, h: number) => h === HEIGHT && roots.has(root),
            currentHeight: async () => HEIGHT + 10,
          }),
        };
  const w = memepoolWallet(wallet, services);
  const nonce = { prefix: 'cHJlZml4', suffix: 'c3VmZml4' };
  const pay = await w.newPayKey(nonce);
  const script = new P2PKH().lock(pay.address).toHex();
  fundTx = new Transaction(1, [], [{ lockingScript: LockingScript.fromHex(script), satoshis: SATS }], 0);

  /**
   * Memepool's trade: a real transaction spending our funding coin with OUR valid signature. The indexer always
   * calls it "confirmed"; `proof` decides whether a merkle proof exists ('valid'), is fake ('fake') or is missing.
   * Returns its txid.
   */
  const memepoolSpend = async (proof: 'valid' | 'fake' | 'none') => {
    const t = new Transaction(
      1,
      [
        { sourceTXID: POOL, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript() },
        { sourceTransaction: fundTx!, sourceOutputIndex: 0, sequence: 0xffffffff },
      ],
      [{ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: SATS - 300 }],
      0,
    );
    t.inputs[1].unlockingScript = UnlockingScript.fromHex(
      await signSelfSpend(wallet, t, 1, { satoshis: SATS, script, key: pay.key }),
    );
    const id = t.id('hex');
    txs.set(id, { raw: t.toHex(), confirmed: true });
    if (proof !== 'none') prove(t, proof === 'valid');
    spent.set(`${fundTx!.id('hex')}_0`, id);
    return id;
  };

  const rows = new Map<string, PendingRecord>();
  const store: PendingStore = {
    list: () => [...rows.values()],
    put: (r) => void rows.set(r.id, structuredClone(r)),
    remove: (id) => void rows.delete(id),
  };
  const record = (over: Partial<PendingRecord> = {}): PendingRecord => {
    const r: PendingRecord = {
      id: idOf(nonce.prefix, nonce.suffix),
      ...nonce,
      sats: SATS,
      state: 'unsure',
      createdAt: now - HOUR,
      funding: { txid: fundTx!.id('hex'), vout: 0, satoshis: SATS, script },
      signed: [{ others: [{ txid: POOL, vout: 0 }], notBefore: now - HOUR / 2 }],
      ...over,
    };
    store.put(r);
    return r;
  };
  const fetch = (async (url: string) => {
    let m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
    if (m) {
      const by = spent.get(`${m[1]}_${m[2]}`);
      return by ? new Response(JSON.stringify({ txid: by }), { status: 200 }) : new Response('', { status: 404 });
    }
    m = /\/tx\/hash\/([0-9a-f]{64})$/.exec(url);
    if (m) {
      const t = txs.get(m[1]);
      if (!t) return new Response('', { status: 404 });
      const body = { txid: m[1], ...(t.confirmed ? { blockhash: '00'.repeat(32), confirmations: 3 } : {}) };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    m = /\/tx\/([0-9a-f]{64})\/hex$/.exec(url);
    if (m) {
      const t = txs.get(m[1]);
      return t ? new Response(t.raw, { status: 200 }) : new Response('', { status: 404 });
    }
    m = /\/address\/(\w+)\/unspent\/all$/.exec(url);
    if (m && failing.has(m[1])) return new Response('', { status: 500 });
    if (m) return new Response(JSON.stringify({ result: utxos.get(m[1]) ?? [], error: '' }), { status: 200 });
    return new Response('', { status: 404 });
  }) as Deps['fetch'];
  let checks = 0;
  let pauseOn: ((n: number) => boolean) | null = null;
  const d: Deps = {
    fetch,
    wallet: w,
    pending: store,
    now: () => now,
    sleep: async () => undefined,
    spendingCheck: async () => {
      checks++;
      if (pauseOn?.(checks)) throw new FeaturePausedError('spending');
    },
  };
  return {
    d,
    log,
    store,
    record,
    spent,
    txs,
    memepoolSpend,
    utxos,
    failing,
    roots,
    later: (ms: number) => (now += ms),
    fundTx: () => fundTx!,
    spendTx: () => spendTx,
    setMode: (m: Mode) => (mode = m),
    failCreate: (e: Error) => (createError = e),
    pauseWhen: (f: (n: number) => boolean) => (pauseOn = f),
    checks: () => checks,
    nonce,
  };
}

const live = (s: PendingStore) => liveRecords(s.list());
const byId = (s: PendingStore, id: string) => s.list().find((r) => r.id === id);

describe('Recover now', () => {
  test('a stuck signed record: one self-spend of the funding coin to a fresh key of ours, signed validly', async () => {
    const t = await rig({ services: true });
    const r = t.record();
    const rows = await stuckFundings(t.d);
    expect(rows).toEqual([{ id: r.id, sats: SATS, reason: 'live-signature', canRecover: true }]);
    const res = await recoverNow(t.d, r.id);
    expect(res.kind).toBe('recovered');
    expect(recoverMessage(res)).toMatch(/back in your wallet/);
    expect(t.log.created.length).toBe(1);
    const args = t.log.created[0] as {
      inputs: { outpoint: string }[];
      outputs: { lockingScript: string; satoshis: number }[];
      inputBEEF?: number[];
    };
    expect(args.inputs.map((i) => i.outpoint)).toEqual([`${t.fundTx().id('hex')}.0`]);
    expect(args.outputs.length).toBe(1); // an explicit output to a fresh BRC-29 key of ours
    expect(args.outputs[0].satoshis).toBe(SATS - MAX_RECOVERY_FEE);
    expect(args.outputs[0].lockingScript).not.toBe(r.funding!.script);
    expect(args.inputBEEF?.length).toBeGreaterThan(0);
    expect(t.log.signed.length).toBe(1);
    expect(t.log.broadcast.length).toBe(1);
    // The unlocking script really spends the funding coin (script interpreter).
    const tx = t.spendTx()!;
    const spend = new Spend({
      sourceTXID: t.fundTx().id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: SATS,
      lockingScript: t.fundTx().outputs[0].lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: UnlockingScript.fromHex(t.log.signed[0].spends[0].unlockingScript),
      inputSequence: 0xffffffff,
      lockTime: 0,
    });
    expect(spend.validate()).toBe(true);
    expect(t.checks()).toBe(2); // the kill switch, before signing and before broadcast
    // The recovered coin was taken in as a wallet payment, and both records are tombstones now (never deleted).
    expect(t.log.internalized.length).toBe(1);
    expect(t.log.internalized[0].outputs).toMatchObject([{ outputIndex: 0, protocol: 'wallet payment' }]);
    expect(live(t.store)).toEqual([]);
    expect(byId(t.store, r.id)).toMatchObject({ state: 'returned', returnedBy: t.log.broadcast[0], ...t.nonce });
    expect(t.store.list().filter((x) => x.state === 'returned').length).toBe(2);
  });

  test('spending paused before signing: refused, nothing signed, the record kept', async () => {
    const t = await rig();
    const r = t.record();
    t.pauseWhen(() => true);
    await expect(recoverNow(t.d, r.id)).rejects.toBeInstanceOf(FeaturePausedError);
    expect(t.log.signatures).toBe(0);
    expect(t.log.signed.length).toBe(0);
    expect(t.log.aborted).toBe(1);
    expect(live(t.store).length).toBe(1);
  });

  test('spending paused just before broadcast: never sent, the record kept', async () => {
    const t = await rig();
    const r = t.record();
    t.pauseWhen((n) => n === 2);
    await expect(recoverNow(t.d, r.id)).rejects.toBeInstanceOf(FeaturePausedError);
    expect(t.log.signed.length).toBe(0);
    expect(t.log.broadcast.length).toBe(0);
    expect(t.log.aborted).toBe(1);
    expect(t.store.list().map((x) => x.id)).toEqual([r.id]); // and no note of a coin that was never made
  });

  test('no tap, nothing: opening Memepool (sweep + list) never spends', async () => {
    const t = await rig();
    t.record();
    t.record({ state: 'sent', signed: undefined, id: 'x.y', prefix: 'x', suffix: 'y' });
    await sweepFundings(t.d);
    await stuckFundings(t.d);
    expect(t.log.created.length).toBe(0);
    expect(t.log.signatures).toBe(0);
    expect(live(t.store).length).toBe(2);
  });

  test("a double-spend refusal: Memepool's proven, confirmed trade won; tombstoned and the user told", async () => {
    const t = await rig({ mode: 'double' });
    const r = t.record();
    const res = await recoverNow(t.d, r.id);
    expect(res).toEqual({ kind: 'went-through' });
    expect(recoverMessage(res)).toMatch(/trade went through/);
    // Only the refused recovery's nonce stays live (nonce-only: see the round-5 tests).
    expect(live(t.store).map((x) => [x.state, x.funding])).toEqual([['pending', undefined]]);
    expect(byId(t.store, r.id)).toMatchObject({ state: 'spent', ...t.nonce });
  });

  test('any other failure keeps the record', async () => {
    const t = await rig({ mode: 'fail' });
    const r = t.record();
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/offline/);
    expect(byId(t.store, r.id)?.state).toBe('unsure');
  });

  test('a record from before signatures were noted (no signature info) gets Recover now', async () => {
    const t = await rig();
    const r = t.record({ state: 'unsure', signed: undefined });
    expect(await stuckFundings(t.d)).toEqual([{ id: r.id, sats: SATS, reason: 'old-record', canRecover: true }]);
    expect((await recoverNow(t.d, r.id)).kind).toBe('recovered');
    expect(t.log.broadcast.length).toBe(1);
  });

  test("Memepool's price still open: shown as waiting, no Recover now, and a forced call is refused", async () => {
    const t = await rig();
    const r = t.record({ signed: [{ others: [{ txid: POOL, vout: 0 }], notBefore: Date.now() + HOUR }] });
    const [row] = await stuckFundings(t.d);
    expect(row).toMatchObject({ reason: 'quote-running', canRecover: false });
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/still open/);
    expect(t.log.created.length).toBe(0);
  });

  test('no services: the sweep cannot return it, so it shows Recover now, which lets the wallet vouch for its own tx', async () => {
    const t = await rig({ services: false });
    const r = t.record({ state: 'pending', signed: undefined });
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 1 }); // no BEEF to internalize with
    expect(await stuckFundings(t.d)).toEqual([{ id: r.id, sats: SATS, reason: 'not-returned', canRecover: true }]);
    expect((await recoverNow(t.d, r.id)).kind).toBe('recovered');
    const args = t.log.created[0] as { inputBEEF?: unknown; options: { trustSelf?: string } };
    expect(args.inputBEEF).toBeUndefined();
    expect(args.options.trustSelf).toBe('known');
  });
});

describe('Recover now: review fixes (7aee65f2)', () => {
  test('1: a lying /spent (a txid with no transaction behind it) never closes the record', async () => {
    const t = await rig();
    const r = t.record();
    t.spent.set(`${r.funding!.txid}_0`, 'ee'.repeat(32));
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/can't confirm/);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(byId(t.store, r.id)?.state).toBe('unsure');
    expect(t.log.created.length).toBe(0);
  });

  test('1: a made-up "confirmed" spender that spends our coin without our signature is not believed', async () => {
    const t = await rig();
    const r = t.record();
    const fake = new Transaction(
      1,
      [
        {
          sourceTXID: r.funding!.txid,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript(),
        },
      ],
      [{ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5 }],
      0,
    );
    t.txs.set(fake.id('hex'), { raw: fake.toHex(), confirmed: true });
    t.spent.set(`${r.funding!.txid}_0`, fake.id('hex'));
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/can't confirm/);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(live(t.store).length).toBe(1);
  });

  test('1: a real, confirmed spender: tombstoned (not deleted), the nonce survives, hidden from the list', async () => {
    const t = await rig();
    const r = t.record();
    const won = await t.memepoolSpend('valid');
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 1, kept: 0 });
    const tomb = byId(t.store, r.id)!;
    expect(tomb).toMatchObject({ state: 'spent', spentBy: won, prefix: t.nonce.prefix, suffix: t.nonce.suffix });
    expect(tomb.funding?.txid).toBe(r.funding!.txid);
    expect(await stuckFundings(t.d)).toEqual([]);
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/nothing to recover/);
  });

  test('1: a real spender the indexer calls "confirmed" but with no merkle proof: the record waits', async () => {
    const t = await rig();
    const r = t.record();
    await t.memepoolSpend('none');
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/check back/i);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(byId(t.store, r.id)?.state).toBe('unsure');
  });

  test('2: two recoveries of the same record at once: one createAction, the second refused', async () => {
    const t = await rig();
    const r = t.record();
    const [a, b] = await Promise.allSettled([recoverNow(t.d, r.id), recoverNow(t.d, r.id)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(String((b as PromiseRejectedResult).reason?.why ?? (b as PromiseRejectedResult).reason)).toMatch(
      /Already recovering/,
    );
    expect(t.log.created.length).toBe(1);
    expect(t.log.broadcast.length).toBe(1);
  });

  test('3: the wallet adds a foreign output: refused before signing', async () => {
    const t = await rig({ build: 'foreign-output' });
    const r = t.record();
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/Refusing to sign/);
    expect(t.log.signatures).toBe(0);
    expect(t.log.aborted).toBe(1);
    expect(byId(t.store, r.id)?.state).toBe('unsure');
  });

  test('3: our explicit output missing (all as "change"): refused before signing', async () => {
    const t = await rig({ build: 'no-output' });
    const r = t.record();
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/Refusing to sign/);
    expect(t.log.signatures).toBe(0);
    expect(live(t.store).length).toBe(1);
  });

  test('4: the sweep already took the coin in (unmanaged input): tombstoned as returned and hidden', async () => {
    const t = await rig();
    const r = t.record();
    t.failCreate(
      new Error('The 1234.0 parameter must be an unmanaged input. Change outputs are managed by your wallet.'),
    );
    const res = await recoverNow(t.d, r.id);
    expect(res).toEqual({ kind: 'already-back' });
    expect(recoverMessage(res)).toMatch(/already back/);
    expect(byId(t.store, r.id)).toMatchObject({ state: 'returned', returnedBy: 'wallet' });
    expect(await stuckFundings(t.d)).toEqual([]);
  });
});

// Round 5 (review of 1d80b95e).
describe('Recover now: block proofs and refused recoveries', () => {
  test('2: a "confirmed" spender with a fake merkle proof is not spent: record kept; a valid proof closes it', async () => {
    const t = await rig();
    const r = t.record();
    await t.memepoolSpend('fake');
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/check back/i);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(byId(t.store, r.id)?.state).toBe('unsure');
    const won = await t.memepoolSpend('valid');
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 1, kept: 0 });
    expect(byId(t.store, r.id)).toMatchObject({ state: 'spent', spentBy: won });
  });

  test("2: a 'spent' tombstone is compacted after 30 days only if the same spender is still proven", async () => {
    const t = await rig();
    const r = t.record();
    const won = await t.memepoolSpend('valid');
    await sweepFundings(t.d);
    expect(byId(t.store, r.id)?.state).toBe('spent');
    t.later(TOMBSTONE_KEEP_MS + HOUR);
    // The proof no longer checks out: the tombstone (and its nonce) stays.
    const kept = new Set(t.roots);
    t.roots.clear();
    await sweepFundings(t.d);
    expect(byId(t.store, r.id)?.state).toBe('spent');
    // A different spender on record than the network now proves: stays too.
    kept.forEach((x) => t.roots.add(x));
    t.store.put({ ...byId(t.store, r.id)!, spentBy: 'ee'.repeat(32) });
    await sweepFundings(t.d);
    expect(byId(t.store, r.id)).toBeDefined();
    expect(byId(t.store, r.id)?.compact).toBeUndefined();
    // The same spender, proven again: compacted (the nonce stays, the rest goes).
    t.store.put({ ...byId(t.store, r.id)!, spentBy: won });
    await sweepFundings(t.d);
    const c = byId(t.store, r.id)!;
    expect(c).toMatchObject({ state: 'spent', compact: true, prefix: t.nonce.prefix, suffix: t.nonce.suffix });
    expect(c.funding).toBeUndefined();
  });

  test("1: a double-spend refusal leaves the recovery coin's record as nonce-only; 'empty' only after the drop time", async () => {
    const t = await rig({ mode: 'double' });
    const r = t.record();
    expect((await recoverNow(t.d, r.id)).kind).toBe('went-through');
    const note = t.store.list().find((x) => x.id !== r.id)!;
    expect(note).toMatchObject({ state: 'pending' });
    expect(note.funding).toBeUndefined(); // nonce only: found by address if the flagged recovery is mined after all
    expect(await stuckFundings(t.d)).toEqual([]); // no "Recover now" for a coin that may never exist
    t.later(HOUR);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 1 }); // address empty, inside the drop time
    expect(byId(t.store, note.id)?.state).toBe('pending');
    t.later(NONCE_ONLY_DROP_MS);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 1, kept: 0 });
    expect(byId(t.store, note.id)).toMatchObject({ state: 'empty', prefix: note.prefix, suffix: note.suffix });
  });

  test('1: ...and if the flagged recovery was mined after all, the sweep finds the coin by address and takes it in', async () => {
    const t = await rig({ mode: 'double' });
    const r = t.record();
    await recoverNow(t.d, r.id);
    const note = t.store.list().find((x) => x.id !== r.id)!;
    const key = await t.d.wallet.newPayKey({ prefix: note.prefix, suffix: note.suffix });
    t.utxos.set(key.address, [{ tx_hash: t.fundTx().id('hex'), tx_pos: 0, value: SATS - MAX_RECOVERY_FEE }]);
    t.later(HOUR);
    expect(await sweepFundings(t.d)).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(byId(t.store, note.id)).toMatchObject({ state: 'returned' });
    expect(t.log.internalized.length).toBe(1);
  });
});

// Round 6: a tombstone's nonce is never dropped.
describe('tombstones keep their nonce', () => {
  const DAY = 24 * HOUR;
  const emptyTomb = (t: Awaited<ReturnType<typeof rig>>, ageMs: number) =>
    t.record({
      state: 'empty',
      funding: undefined,
      signed: undefined,
      createdAt: Date.now() - ageMs - DAY,
      doneAt: Date.now() - ageMs,
    });

  test("an 'empty' tombstone older than 30 days is compacted with its nonce, and a coin landing at its address later is taken in", async () => {
    const t = await rig();
    const r = emptyTomb(t, TOMBSTONE_KEEP_MS + DAY);
    expect(await sweepFundings(t.d)).toEqual({ returned: 0, spent: 0, kept: 0 });
    const c = byId(t.store, r.id)!;
    expect(c).toMatchObject({ state: 'empty', compact: true, prefix: t.nonce.prefix, suffix: t.nonce.suffix });
    // Months later a coin turns up at the nonce's address.
    const key = await t.d.wallet.newPayKey({ prefix: c.prefix, suffix: c.suffix });
    t.utxos.set(key.address, [{ tx_hash: t.fundTx().id('hex'), tx_pos: 0, value: SATS }]);
    t.later(90 * DAY);
    expect(await sweepFundings(t.d)).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(t.log.internalized.length).toBe(1);
    expect(byId(t.store, r.id)).toMatchObject({ state: 'returned', prefix: t.nonce.prefix });
  });

  test('compacted tombstones are capped at the most recent 5,000', async () => {
    const t = await rig();
    const old = Date.now() - TOMBSTONE_KEEP_MS - DAY;
    for (let i = 0; i < 5_003; i++)
      t.store.put({
        id: `p${i}.s${i}`,
        prefix: `p${i}`,
        suffix: `s${i}`,
        sats: 0,
        state: 'returned',
        createdAt: old - i,
        doneAt: old - i,
      });
    await sweepFundings(t.d);
    const left = t.store.list();
    expect(left.length).toBe(5_000);
    expect(left.every((x) => x.compact)).toBe(true);
    expect(left.some((x) => x.id === 'p5002.s5002')).toBe(false); // the oldest went
    expect(left.some((x) => x.id === 'p0.s0')).toBe(true);
  });
});

// Round 7: recheck fairness, which compacted entries go first, and our own recovery mined despite a flag.
describe('recheck fairness, eviction order, own recovery', () => {
  const DAY = 24 * HOUR;
  const tomb = (i: number, over: Partial<PendingRecord> = {}): PendingRecord => ({
    id: `p${i}.s${i}`,
    prefix: `p${i}`,
    suffix: `s${i}`,
    sats: 0,
    state: 'empty',
    createdAt: Date.now() - 40 * DAY,
    doneAt: Date.now() - 31 * DAY,
    ...over,
  });

  test("1: 20 'empty' entries that always fail don't starve the 21st: its coin is taken in within 2 sweeps", async () => {
    const t = await rig();
    for (let i = 0; i < 25; i++) {
      t.store.put(tomb(i));
      const key = await t.d.wallet.newPayKey({ prefix: `p${i}`, suffix: `s${i}` });
      if (i < 20) t.failing.add(key.address);
      if (i === 20) t.utxos.set(key.address, [{ tx_hash: t.fundTx().id('hex'), tx_pos: 0, value: SATS }]);
    }
    await sweepFundings(t.d);
    t.later(HOUR); // well inside a day: the 20 failing ones are not due again yet
    await sweepFundings(t.d);
    expect(byId(t.store, 'p20.s20')?.state).toBe('returned');
    expect(t.log.internalized.length).toBe(1);
  });

  test("2: over the cap, settled entries ('returned', proven 'spent') go before 'empty' nonces, oldest first", async () => {
    const t = await rig();
    const fresh = Date.now();
    // 5,000 'empty' nonces (older), then 3 settled ones (newest): 3 over the cap.
    for (let i = 0; i < 5_000; i++)
      t.store.put(tomb(i, { compact: true, doneAt: fresh - DAY - 10_000 + i, checkedAt: fresh }));
    t.store.put(tomb(9_001, { compact: true, state: 'returned', doneAt: fresh - DAY + 1 }));
    t.store.put(tomb(9_002, { compact: true, state: 'spent', doneAt: fresh - DAY + 2 }));
    t.store.put(tomb(9_003, { compact: true, state: 'returned', doneAt: fresh - DAY + 3 }));
    await sweepFundings(t.d);
    const left = t.store.list();
    expect(left.length).toBe(5_000);
    expect(left.every((x) => x.state === 'empty')).toBe(true); // every nonce kept
    // Still over with only 'empty' left: then the oldest 'empty' go.
    t.store.put(tomb(9_004, { compact: true, doneAt: fresh, checkedAt: fresh }));
    await sweepFundings(t.d);
    expect(t.store.list().length).toBe(5_000);
    expect(byId(t.store, 'p0.s0')).toBeUndefined();
    expect(byId(t.store, 'p9004.s9004')).toBeDefined();
  });

  test('3: the network proves our own recovery mined despite a double-spend flag: "recovered", not "went through"', async () => {
    const t = await rig({ mode: 'double-ours' });
    const r = t.record();
    const res = await recoverNow(t.d, r.id);
    expect(res.kind).toBe('recovered');
    expect(recoverMessage(res)).toMatch(/back in your wallet/);
    expect(byId(t.store, r.id)).toMatchObject({ state: 'returned' });
    // The recovered coin keeps its record (with funding) and is taken in.
    const note = t.store.list().find((x) => x.id !== r.id)!;
    expect(note.funding?.txid).toBe((res as { txid: string }).txid);
    expect(note.state).toBe('returned');
    expect(t.log.internalized.length).toBe(1);
  });
});
