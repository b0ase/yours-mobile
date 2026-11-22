/**
 * Review of fix/sev-envelopes (backlog 21 Nov 2026 rank 7, SAFE-WITH-FIXES):
 *  1. A payment through an asset module ("p 1sat …", an OrdLock buy) was taken from the envelope with no hold: when
 *     anything after the envelope said yes failed, the action was aborted but the envelope never given back.
 *  2. An envelope stored before the per-payment limit got it from the total ever put in, so one call could still take
 *     the whole balance.
 *  3. Holds lived only in memory: a background worker that stopped (the extension's, after 30 s idle) never gave back
 *     an action left unsigned.
 *
 * Real pieces as initWallet wires them: LocalWalletPermissionsManager, the asset modules' spend gate, guardEnvelopes,
 * the spend ledger, preserveOriginalErrors and the labels guard. The base wallet is a fake that funds the outputs from
 * one coin, and, like real storage, refuses to abort an action twice or after it was shared.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import { createAssetPermissionModules } from '@1sat/permission-module';
import {
  EnvelopeStore,
  guardEnvelopes,
  parseEnvelopeState,
  recoverEnvelopeHolds,
  type EnvelopeBackend,
  type EnvelopeState,
} from './envelopes';
import { guardPModuleSpends } from './pModuleSpendGate';
import { withLocalSpendLedger } from './spendLedger';
import { preserveOriginalErrors } from './permissionAbortGuard';
import { guardLabelsOnSpend } from './labelsOnSpend';

const ADMIN = 'admin.bwalletx.test';
const SITE = 'https://arcade.example';
const KEY = normalizeOriginator(SITE);
const FUNDS = 1_000_000;
const FEE = 2;
const FILL = 10_000; // per-payment limit 1,000
const payee = new P2PKH().lock(new PrivateKey(99).toAddress()).toHex();

const memBackend = (): EnvelopeBackend & { raw: () => unknown } => {
  let data: unknown;
  return {
    raw: () => data,
    load: async () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    save: async (s: EnvelopeState) => {
      data = JSON.parse(JSON.stringify(s));
    },
  };
};

type Mode = { signFails?: 'before-share' | 'after-share' };

/** One coin; aborts are refused twice over and after sharing, as storage refuses them. */
function fakeBase(mode: Mode = {}) {
  const calls: string[] = [];
  const src = new Transaction();
  src.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
  src.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(5).toAddress()), satoshis: FUNDS });
  src.merklePath = new MerklePath(900_000, [[{ offset: 0, hash: src.id('hex'), txid: true }]]);
  const signable = new Map<string, number[]>();
  const shared = new Set<string>();
  const aborted = new Set<string>();
  let n = 0;
  return {
    calls,
    createAction: async (args: { outputs?: { lockingScript: string; satoshis: number }[] }) => {
      calls.push('createAction');
      const tx = new Transaction();
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
      let out = 0;
      for (const o of args.outputs ?? []) {
        tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
        out += o.satoshis;
      }
      tx.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(6).toAddress()), satoshis: FUNDS - out - FEE });
      const beef = new Beef();
      beef.mergeTransaction(tx);
      const reference = `ref-${++n}`;
      const atomic = beef.toBinaryAtomic(tx.id('hex'));
      signable.set(reference, atomic);
      return { signableTransaction: { tx: atomic, reference } };
    },
    signAction: async (args: { reference: string }) => {
      calls.push('signAction');
      if (aborted.has(args.reference)) throw new Error('that action was aborted');
      if (mode.signFails === 'after-share') {
        shared.add(args.reference);
        throw new Error('broadcast answer lost');
      }
      if (mode.signFails === 'before-share') throw new Error('could not sign');
      shared.add(args.reference);
      const tx = signable.get(args.reference)!;
      return { txid: Transaction.fromAtomicBEEF(tx).id('hex'), tx };
    },
    abortAction: async (args: { reference: string }) => {
      calls.push('abortAction');
      if (shared.has(args.reference) || aborted.has(args.reference))
        throw new Error('an inprocess, outgoing action that has not been signed and shared to the network.');
      aborted.add(args.reference);
      return { aborted: true };
    },
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    listActions: async () => ({ totalActions: 0, actions: [] }),
    encrypt: async (a: { plaintext: number[] }) => ({ ciphertext: a.plaintext }),
    decrypt: async (a: { ciphertext: number[] }) => ({ plaintext: a.ciphertext }),
  };
}
type Base = ReturnType<typeof fakeBase>;

/** A stand-in "1sat" module that, like @1sat/actions completeSignedAction, aborts on a local failure and throws. */
const selfAbortingModule = (base: Base) => ({
  onRequest: async (r: { args: unknown }) => ({ args: r.args }),
  onResponse: async (res: { signableTransaction?: { reference: string } }) => {
    const reference = res.signableTransaction?.reference;
    if (reference) await base.abortAction({ reference }).catch(() => undefined);
    throw new Error('1Sat permission module: finish failed: script-verification-failed-for-input-0');
  },
});

async function moduleWallet(opts: { mode?: Mode; selfAbort?: boolean; ledgerFails?: boolean } = {}) {
  const base = fakeBase(opts.mode);
  const store = new InMemoryPermissionStore();
  const modules = opts.selfAbort
    ? { '1sat': selfAbortingModule(base) }
    : createAssetPermissionModules({
        wallet: base as never,
        promptHandler: async () => true,
        adminOriginator: ADMIN,
        permissionStore: store as never,
      });
  const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, { permissionModules: modules } as never, {
    store,
  } as never);
  const sheets: { satoshis?: number }[] = [];
  (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: { spending?: { satoshis: number } }) => {
    sheets.push({ satoshis: r.spending?.satoshis });
    throw new Error('User denied');
  };
  const backend = memBackend();
  const envelopes = new EnvelopeStore(backend);
  await envelopes.fill(KEY, FILL);
  const ledger = {
    total: async () => 0,
    record: async () => {
      if (opts.ledgerFails) throw new Error('the spend ledger could not be written');
    },
  };
  const w = guardLabelsOnSpend(
    preserveOriginalErrors(
      withLocalSpendLedger(
        guardEnvelopes(guardPModuleSpends(mgr, { adminOriginator: ADMIN }), {
          envelopes,
          adminOriginator: ADMIN,
          normalize: normalizeOriginator,
        }),
        ledger as never,
        () => undefined,
      ),
      () => undefined,
    ),
    { adminOriginator: ADMIN },
  );
  const balance = async () => (await envelopes.get(KEY))?.balanceSats;
  return { w, base, sheets, envelopes, backend, balance };
}

const buy = (satoshis: number) => ({
  description: 'Buy a rare ordinal',
  labels: ['p 1sat action'],
  outputs: [{ lockingScript: payee, satoshis, outputDescription: 'payment to seller' }],
});

describe('review 1: a payment through an asset module is held like any other', () => {
  test('it signs: taken once from the envelope, no sheet', async () => {
    const { w, base, sheets, balance } = await moduleWallet();
    const r = (await w.createAction(buy(500) as never, SITE)) as { txid?: string };
    expect(typeof r.txid).toBe('string');
    expect(sheets).toHaveLength(0);
    expect(base.calls.filter((c) => c === 'signAction')).toHaveLength(1);
    expect(await balance()).toBe(FILL - 500 - FEE);
  });

  test('a check after the envelope said yes fails: the gate aborts the action and the envelope is given back', async () => {
    const { w, base, balance } = await moduleWallet({ ledgerFails: true });
    await expect(w.createAction(buy(500) as never, SITE)).rejects.toThrow('spend ledger');
    expect(base.calls).toContain('abortAction');
    expect(base.calls).not.toContain('signAction');
    expect(await balance()).toBe(FILL);
  });

  test('the module fails to sign before anything is shared: aborted, and the envelope is given back', async () => {
    const { w, base, balance } = await moduleWallet({ mode: { signFails: 'before-share' } });
    await expect(w.createAction(buy(500) as never, SITE)).rejects.toThrow();
    expect(base.calls).toContain('abortAction');
    expect(await balance()).toBe(FILL);
  });

  test('the module aborts the action itself and throws: the envelope is given back (a second abort is refused)', async () => {
    const { w, balance } = await moduleWallet({ selfAbort: true });
    await expect(w.createAction(buy(500) as never, SITE)).rejects.toThrow('finish failed');
    expect(await balance()).toBe(FILL);
  });

  test('signing failed after the network may have it: stays taken', async () => {
    const { w, balance } = await moduleWallet({ mode: { signFails: 'after-share' } });
    await expect(w.createAction(buy(500) as never, SITE)).rejects.toThrow();
    expect(await balance()).toBe(FILL - 500 - FEE);
  });

  test('over the per-payment limit: the pay sheet, and Deny leaves the envelope unchanged', async () => {
    const { w, sheets, balance } = await moduleWallet();
    await expect(w.createAction(buy(5_000) as never, SITE)).rejects.toThrow();
    expect(sheets).toHaveLength(1);
    expect(await balance()).toBe(FILL);
  });
});

describe('review 2: an envelope stored before the limit gets it from what is in it now', () => {
  test('ten $1 fills, $9 spent: the limit is a tenth of the $1 left, not the whole of it', () => {
    const s = parseEnvelopeState({
      envelopes: {
        [KEY]: { originator: KEY, balanceSats: 1_000, filledSats: 10_000, spentSats: 9_000, history: [] },
      },
    });
    expect(s.envelopes[KEY].perSpendSats).toBe(100);
  });

  test('a stored limit is kept', () => {
    const s = parseEnvelopeState({
      envelopes: { [KEY]: { originator: KEY, balanceSats: 1_000, perSpendSats: 250, filledSats: 10_000 } },
    });
    expect(s.envelopes[KEY].perSpendSats).toBe(250);
  });
});

/** The extension's chain without modules, for the hold-recovery checks. */
async function plainWallet(backend: EnvelopeBackend, base: Base, holdTimeoutMs?: number) {
  const store = new InMemoryPermissionStore();
  const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, {}, { store } as never);
  (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async () => {
    throw new Error('User denied');
  };
  const envelopes = new EnvelopeStore(backend);
  const ledger = { total: async () => 0, record: async () => undefined };
  const w = guardLabelsOnSpend(
    preserveOriginalErrors(
      withLocalSpendLedger(
        guardEnvelopes(mgr, { envelopes, adminOriginator: ADMIN, normalize: normalizeOriginator, holdTimeoutMs }),
        ledger as never,
        () => undefined,
      ),
      () => undefined,
    ),
    { adminOriginator: ADMIN },
  );
  return { w, envelopes };
}

const payOnly = (satoshis: number, options: Record<string, unknown> = {}) => ({
  description: 'Play one round',
  outputs: [{ lockingScript: payee, satoshis, outputDescription: 'one round' }],
  options,
});

const LATER = () => Date.now() + 60 * 60_000; // an hour on: past every hold deadline

describe('review 3: holds are stored with the envelope and recovered when the worker starts again', () => {
  test('a held payment is written down with its action, and settling it (signed) clears the record', async () => {
    const backend = memBackend();
    const base = fakeBase();
    const { w, envelopes } = await plainWallet(backend, base);
    await envelopes.fill(KEY, FILL);
    const r = (await w.createAction(payOnly(500, { signAndProcess: false }) as never, SITE)) as {
      signableTransaction: { reference: string };
    };
    expect((await envelopes.holds()).map((h) => h.reference)).toEqual([r.signableTransaction.reference]);
    await w.signAction({ reference: r.signableTransaction.reference, spends: {} } as never, SITE);
    await new Promise((res) => setTimeout(res, 20));
    expect(await envelopes.holds()).toEqual([]);
    expect((await envelopes.get(KEY))?.balanceSats).toBe(FILL - 500 - FEE);
  });

  test('worker stopped with an action left unsigned: on start it is aborted and the envelope given back, once', async () => {
    const backend = memBackend();
    const base = fakeBase();
    const before = await plainWallet(backend, base);
    await before.envelopes.fill(KEY, FILL);
    const r = (await before.w.createAction(payOnly(500, { signAndProcess: false }) as never, SITE)) as {
      signableTransaction: { reference: string };
    };
    expect((await before.envelopes.get(KEY))?.balanceSats).toBe(FILL - 500 - FEE);
    // A new worker: a new store over the same storage, and none of the old worker's memory.
    const after = new EnvelopeStore(backend);
    const aborts: string[] = [];
    const abort = (reference: string) => (aborts.push(reference), base.abortAction({ reference }));
    const out = await recoverEnvelopeHolds(after, abort, { now: LATER(), isLive: () => false });
    expect(aborts).toEqual([r.signableTransaction.reference]);
    expect(out.refunded).toBe(500 + FEE);
    expect((await after.get(KEY))?.balanceSats).toBe(FILL);
    expect(await after.holds()).toEqual([]);
    // Run again: nothing more is given back.
    const again = await recoverEnvelopeHolds(after, abort, { now: LATER(), isLive: () => false });
    expect(again.refunded).toBe(0);
    expect((await after.get(KEY))?.balanceSats).toBe(FILL);
  });

  test('an action the old worker had already signed is not given back (the abort is refused): the record is dropped', async () => {
    const backend = memBackend();
    const base = fakeBase();
    const { w, envelopes } = await plainWallet(backend, base);
    await envelopes.fill(KEY, FILL);
    const r = (await w.createAction(payOnly(500, { signAndProcess: false }) as never, SITE)) as {
      signableTransaction: { reference: string };
    };
    // Signed on the base wallet, but the worker stopped before it wrote that down.
    await base.signAction({ reference: r.signableTransaction.reference });
    const after = new EnvelopeStore(backend);
    const out = await recoverEnvelopeHolds(after, (reference) => base.abortAction({ reference }), {
      now: LATER(),
      isLive: () => false,
    });
    expect(out.refunded).toBe(0);
    expect((await after.get(KEY))?.balanceSats).toBe(FILL - 500 - FEE);
    expect(await after.holds()).toEqual([]);
  });

  test('storage that does not answer: the record is kept for the next start, nothing given back yet', async () => {
    const backend = memBackend();
    const base = fakeBase();
    const { w, envelopes } = await plainWallet(backend, base);
    await envelopes.fill(KEY, FILL);
    await w.createAction(payOnly(500, { signAndProcess: false }) as never, SITE);
    const after = new EnvelopeStore(backend);
    const out = await recoverEnvelopeHolds(
      after,
      async () => {
        throw new Error('fetch failed');
      },
      { now: LATER(), isLive: () => false },
    );
    expect(out.refunded).toBe(0);
    expect(await after.holds()).toHaveLength(1);
    expect((await after.get(KEY))?.balanceSats).toBe(FILL - 500 - FEE);
  });

  test('a hold younger than the deadline (another tab may be using it) or live in this worker is left alone', async () => {
    const backend = memBackend();
    const base = fakeBase();
    const { w, envelopes } = await plainWallet(backend, base);
    await envelopes.fill(KEY, FILL);
    await w.createAction(payOnly(500, { signAndProcess: false }) as never, SITE);
    const aborts: string[] = [];
    const abort = async (reference: string) => (aborts.push(reference), { aborted: true });
    await recoverEnvelopeHolds(new EnvelopeStore(backend), abort, { now: Date.now(), isLive: () => false });
    await recoverEnvelopeHolds(new EnvelopeStore(backend), abort, { now: LATER() }); // still live here
    expect(aborts).toEqual([]);
    expect(await envelopes.holds()).toHaveLength(1);
  });

  test('Coin return drops the envelope with its holds: a later recovery gives nothing back', async () => {
    const backend = memBackend();
    const base = fakeBase();
    const { w, envelopes } = await plainWallet(backend, base);
    await envelopes.fill(KEY, FILL);
    await w.createAction(payOnly(500, { signAndProcess: false }) as never, SITE);
    await envelopes.close(KEY);
    const out = await recoverEnvelopeHolds(new EnvelopeStore(backend), (reference) => base.abortAction({ reference }), {
      now: LATER(),
      isLive: () => false,
    });
    expect(out.refunded).toBe(0);
    expect(await envelopes.get(KEY)).toBeUndefined();
  });

  test('a held payment survives a reload of the stored state (parse keeps the holds)', () => {
    const s = parseEnvelopeState({
      envelopes: {
        [KEY]: { originator: KEY, balanceSats: 1_000, holds: { 'ref-a': { sats: 50, at: 5 }, bad: { sats: 'x' } } },
      },
    });
    expect(s.envelopes[KEY].holds).toEqual({ 'ref-a': { sats: 50, at: 5 } });
  });

  test('initWallet recovers this account\'s holds on start, through the base wallet', () => {
    const src = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/scheduleEnvelopeHoldRecovery\(\s*envelopes,/);
  });
});
