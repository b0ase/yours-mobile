/**
 * "Recover now" (trade.ts recoverNow / stuckFundings, wallet.ts spendBack): a user-tapped self-spend of a funding
 * coin the sweep can't return. Real keys and signatures (ProtoWallet); the wallet's createAction / signAction and
 * the network are stubbed. Nothing is broadcast.
 */
import { describe, expect, test } from 'bun:test';
import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Spend,
  Transaction,
  UnlockingScript,
  type WalletInterface,
} from '@bsv/sdk';
import { FeaturePausedError } from '../../config/killSwitch';
import { idOf, type PendingRecord, type PendingStore } from './pending';
import { recoverMessage, recoverNow, stuckFundings, sweepFundings, type Deps } from './trade';
import { memepoolWallet } from './wallet';

const SATS = 1_056_000;
const POOL = 'aa'.repeat(32);
const MEMEPOOL_TX = 'cc'.repeat(32);
const HOUR = 60 * 60_000;

type Mode = 'ok' | 'double' | 'fail';

async function rig(opts: { services?: boolean; mode?: Mode } = {}) {
  const now = Date.now();
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const log = {
    created: [] as Record<string, unknown>[],
    signed: [] as { reference: string; spends: Record<number, { unlockingScript: string }> }[],
    signatures: 0,
    aborted: 0,
    broadcast: [] as string[],
  };
  /** The network: outpoint → spender txid. */
  const spent = new Map<string, string>();
  let mode: Mode = opts.mode ?? 'ok';
  let fundTx: Transaction | null = null;
  let spendTx: Transaction | null = null;

  const wallet = {
    getPublicKey: (a: never) => proto.getPublicKey(a),
    createSignature: async (a: never) => {
      log.signatures++;
      return proto.createSignature(a);
    },
    createAction: async (a: Record<string, unknown>) => {
      log.created.push(a);
      const change = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
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
        [{ lockingScript: change, satoshis: SATS - 120 }],
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
      if (mode === 'double') {
        spent.set(key, MEMEPOOL_TX); // Memepool's trade got there first
        throw Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
          reviewActionResults: [{ txid: 'dd'.repeat(32), status: 'doubleSpend', competingTxs: [MEMEPOOL_TX] }],
        });
      }
      if (mode === 'fail') throw new Error('storage offline');
      const txid = spendTx!.id('hex');
      log.broadcast.push(txid);
      spent.set(key, txid);
      return { txid };
    },
    abortAction: async () => {
      log.aborted++;
      return { aborted: true };
    },
    internalizeAction: async () => ({ accepted: true }),
  } as unknown as WalletInterface;

  const services = opts.services
    ? { getBeefForTxid: async () => ({ toBinaryAtomic: () => fundTx!.toBEEF() }) }
    : undefined;
  const w = memepoolWallet(wallet, services);
  const nonce = { prefix: 'cHJlZml4', suffix: 'c3VmZml4' };
  const pay = await w.newPayKey(nonce);
  const script = new P2PKH().lock(pay.address).toHex();
  fundTx = new Transaction(1, [], [{ lockingScript: LockingScript.fromHex(script), satoshis: SATS }], 0);

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
    const m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
    if (m) {
      const by = spent.get(`${m[1]}_${m[2]}`);
      return by ? new Response(JSON.stringify({ txid: by }), { status: 200 }) : new Response('', { status: 404 });
    }
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
    fundTx: () => fundTx!,
    spendTx: () => spendTx,
    setMode: (m: Mode) => (mode = m),
    pauseWhen: (f: (n: number) => boolean) => (pauseOn = f),
    checks: () => checks,
  };
}

describe('Recover now', () => {
  test('a stuck signed record: exactly one self-spend of the funding coin, signed validly, then the record goes', async () => {
    const t = await rig({ services: true });
    const r = t.record();
    const rows = await stuckFundings(t.d);
    expect(rows).toEqual([{ id: r.id, sats: SATS, reason: 'live-signature', canRecover: true }]);
    const res = await recoverNow(t.d, r.id);
    expect(res.kind).toBe('recovered');
    expect(recoverMessage(res)).toMatch(/back in your wallet/);
    expect(t.log.created.length).toBe(1);
    const args = t.log.created[0] as { inputs: { outpoint: string }[]; outputs: unknown[]; inputBEEF?: number[] };
    expect(args.inputs.map((i) => i.outpoint)).toEqual([`${t.fundTx().id('hex')}.0`]);
    expect(args.outputs).toEqual([]); // all of it comes back as the wallet's own change
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
    expect(t.store.list()).toEqual([]);
  });

  test('spending paused before signing: refused, nothing signed, the record kept', async () => {
    const t = await rig();
    const r = t.record();
    t.pauseWhen(() => true);
    await expect(recoverNow(t.d, r.id)).rejects.toBeInstanceOf(FeaturePausedError);
    expect(t.log.signatures).toBe(0);
    expect(t.log.signed.length).toBe(0);
    expect(t.log.aborted).toBe(1);
    expect(t.store.list().length).toBe(1);
  });

  test('spending paused just before broadcast: never sent, the record kept', async () => {
    const t = await rig();
    const r = t.record();
    t.pauseWhen((n) => n === 2);
    await expect(recoverNow(t.d, r.id)).rejects.toBeInstanceOf(FeaturePausedError);
    expect(t.log.signed.length).toBe(0);
    expect(t.log.broadcast.length).toBe(0);
    expect(t.log.aborted).toBe(1);
    expect(t.store.list().length).toBe(1);
  });

  test('no tap, nothing: opening Memepool (sweep + list) never spends', async () => {
    const t = await rig();
    t.record();
    t.record({ state: 'sent', signed: undefined, id: 'x.y', prefix: 'x', suffix: 'y' });
    await sweepFundings(t.d);
    await stuckFundings(t.d);
    expect(t.log.created.length).toBe(0);
    expect(t.log.signatures).toBe(0);
    expect(t.store.list().length).toBe(2);
  });

  test("a double-spend refusal: Memepool's trade won, the record goes, and the user is told the buy happened", async () => {
    const t = await rig({ mode: 'double' });
    const r = t.record();
    const res = await recoverNow(t.d, r.id);
    expect(res).toEqual({ kind: 'went-through' });
    expect(recoverMessage(res)).toMatch(/trade went through/);
    expect(t.store.list()).toEqual([]);
  });

  test('any other failure keeps the record', async () => {
    const t = await rig({ mode: 'fail' });
    const r = t.record();
    await expect(recoverNow(t.d, r.id)).rejects.toThrow(/offline/);
    expect(t.store.list().length).toBe(1);
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
