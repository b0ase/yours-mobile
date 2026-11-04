/**
 * b-Aware D-L (Dony Dwi Prastiyo, 25 Oct 2026): one "p <scheme> …" label let a site pick its own approval surface.
 *
 * The label sends the site's createAction to the asset permission module (@1sat/permission-module), which shows its
 * own sheet before anything is funded, then finishes the transaction itself on the raw base wallet (signAction, which
 * broadcasts). The permissions manager only reaches its spend check when it gets the signable transaction back, and
 * here it never does, so the wallet's pay sheet, envelopes, the month's spend ledger and the output check were all
 * skipped. "p <scheme> input id <key>" labels (and caller-supplied resolved spends) also made the module load and sign
 * the wallet's own assets.
 *
 * Real pieces, as initWallet wires them: createAssetPermissionModules on a base wallet, LocalWalletPermissionsManager
 * with those modules, the store build's every-spend-asks guard and the spend ledger. The base wallet is a fake that
 * builds a funded signable transaction and records what is signed. No network, no keys of anyone's.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import { createAssetPermissionModules } from '@1sat/permission-module';
import { guardEverySpendAsks } from './everySpendAsks';
import { withLocalSpendLedger } from './spendLedger';
import { guardPModuleSpends, HELD_ASSET_REFUSAL } from './pModuleSpendGate';

const ADMIN = 'admin.bwalletx.test';
const SITE = 'https://evil.example';
const FUNDS = 1_000_000;
const FEE = 200;
const PAY = 150_000;
const attacker = new P2PKH().lock(new PrivateKey(99).toAddress()).toHex();

/** A base wallet holding one 1,000,000-sat coin: createAction funds the outputs from it and leaves change. */
function fakeBase() {
  const calls: string[] = [];
  const src = new Transaction();
  src.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(5).toAddress()), satoshis: FUNDS });
  src.merklePath = new MerklePath(900_000, [[{ offset: 0, hash: src.id('hex'), txid: true }]]);
  const signable = new Map<string, number[]>();
  let n = 0;
  const w = {
    calls,
    createAction: async (args: { outputs?: { lockingScript: string; satoshis: number }[] }) => {
      calls.push('createAction');
      const tx = new Transaction();
      tx.addInput({
        sourceTransaction: src,
        sourceOutputIndex: 0,
        unlockingScript: new Script(),
        sequence: 0xffffffff,
      });
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
      const tx = signable.get(args.reference)!;
      return { txid: Transaction.fromAtomicBEEF(tx).id('hex'), tx };
    },
    abortAction: async () => {
      calls.push('abortAction');
      return { aborted: true };
    },
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    listActions: async () => ({ totalActions: 0, actions: [] }),
    encrypt: async (a: { plaintext: number[] }) => ({ ciphertext: a.plaintext }),
    decrypt: async (a: { ciphertext: number[] }) => ({ plaintext: a.ciphertext }),
  };
  return w;
}

/** The store build's chain: modules on the base wallet, the manager, every spend asks, the spend ledger. */
function wallet(answer: boolean) {
  const base = fakeBase();
  const store = new InMemoryPermissionStore();
  const modulePrompts: string[] = [];
  const modules = createAssetPermissionModules({
    wallet: base as never,
    promptHandler: async (r: { kind: string }) => {
      modulePrompts.push(r.kind);
      return true; // the module's own sheet is approved: the attack needs nothing more
    },
    adminOriginator: ADMIN,
    permissionStore: store as never,
  });
  const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, { permissionModules: modules }, {
    store,
  } as never);
  const sheets: { type: string; satoshis?: number }[] = [];
  (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: {
    type: string;
    spending?: { satoshis: number };
  }) => {
    sheets.push({ type: r.type, satoshis: r.spending?.satoshis });
    if (!answer) throw new Error('User denied');
    return true;
  };
  const recorded: number[] = [];
  const ledger = {
    total: async () => 0,
    record: async (_o: string, _m: string, sats: number) => void recorded.push(sats),
  };
  const w = withLocalSpendLedger(
    guardEverySpendAsks(guardPModuleSpends(mgr, { adminOriginator: ADMIN }), {
      adminOriginator: ADMIN,
      normalize: normalizeOriginator,
    }),
    ledger as never,
    () => undefined,
  );
  return { w, base, sheets, recorded, modulePrompts };
}

const pay = (labels: string[], extra: Record<string, unknown> = {}) => ({
  description: 'Buy a rare ordinal',
  labels,
  outputs: [{ lockingScript: attacker, satoshis: PAY, outputDescription: 'payment to seller' }],
  ...extra,
});

describe('D-L: a "p" label no longer skips the wallet spend gate', () => {
  test('Deny on the wallet pay sheet: nothing is signed or broadcast, the action is aborted', async () => {
    const { w, base, sheets } = wallet(false);
    await expect(w.createAction(pay(['p 1sat action']) as never, SITE)).rejects.toThrow();
    // The pay sheet shows what the transaction really spends: the outputs plus the fee.
    expect(sheets).toEqual([{ type: 'spending', satoshis: PAY + FEE }]);
    expect(base.calls).not.toContain('signAction');
    expect(base.calls).toContain('abortAction');
  });

  test('Approve: signed once, and counted in the month spend ledger like any other site payment', async () => {
    const { w, base, sheets, recorded, modulePrompts } = wallet(true);
    const r = (await w.createAction(pay(['p 1sat action']) as never, SITE)) as { txid?: string };
    expect(typeof r.txid).toBe('string');
    expect(modulePrompts).toEqual(['transaction']); // the module's own sheet still shows the asset details
    expect(sheets).toEqual([{ type: 'spending', satoshis: PAY + FEE }]);
    expect(recorded).toEqual([PAY + FEE]);
    expect(base.calls.filter((c) => c === 'signAction').length).toBe(1);
  });

  test('a "p" basket output takes the same gate (not only labels)', async () => {
    const { w, base, sheets } = wallet(false);
    const args = {
      description: 'Mint into my basket',
      outputs: [{ lockingScript: attacker, satoshis: PAY, outputDescription: 'payment to seller', basket: 'p 1sat x' }],
    };
    await expect(w.createAction(args as never, SITE)).rejects.toThrow();
    expect(sheets.length).toBe(1);
    expect(base.calls).not.toContain('signAction');
  });

  test('"p <scheme> input id <key>": a site cannot name the wallet\'s own assets for the module to load and sign', async () => {
    for (const label of [
      'p 1sat input id abc123',
      'p bsv21 input id tok1',
      'p lock input id l1',
      'p opns input id n1',
    ]) {
      const { w, base, modulePrompts } = wallet(true);
      await expect(w.createAction(pay([label]) as never, SITE)).rejects.toThrow(HELD_ASSET_REFUSAL);
      expect(base.calls).toEqual([]);
      expect(modulePrompts).toEqual([]);
    }
  });

  test('caller-supplied resolved spends (a record naming the key to sign with) are refused', async () => {
    const { w, base } = wallet(true);
    const args = pay(['p 1sat action'], {
      __pendingResolvedSpends: [
        { outpoint: `${'ab'.repeat(32)}.0`, customInstructions: '{"protocolID":[0,"onesat"],"keyID":"x"}' },
      ],
    });
    await expect(w.createAction(args as never, SITE)).rejects.toThrow(HELD_ASSET_REFUSAL);
    expect(base.calls).toEqual([]);
  });

  test("the wallet's own p-label actions (admin) are unchanged: no extra sheet", async () => {
    const { w, base, sheets } = wallet(false);
    const r = (await w.createAction(pay(['p 1sat action']) as never, ADMIN)) as { txid?: string };
    expect(typeof r.txid).toBe('string');
    expect(sheets).toEqual([]);
    expect(base.calls).toEqual(['createAction', 'signAction']);
  });

  test('initWallet puts the gate on the permissions manager every site call goes through', () => {
    const src = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/guardPModuleSpends\(\s*new LocalWalletPermissionsManager\(/);
    expect(src).not.toMatch(/\?\s*guardAllowance\(\s*new LocalWalletPermissionsManager\(/);
  });
});
