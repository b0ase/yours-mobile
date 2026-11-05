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
import { Beef, MerklePath, P2PKH, PrivateKey, ProtoWallet, PublicKey, Script, Transaction } from '@bsv/sdk';
import { OrdLockV2 } from '@1sat/templates';
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

/**
 * Review 16, F1: the 1sat module lays out an OrdLock V2 purchase by REPLACING args.inputs on the request object the gate
 * also reads, with the wallet's own front-funding coins first. The gate then counted those as the site's money, and the
 * pay sheet, envelope and ledger saw about the fee instead of the price. A real listing, through the real module and
 * manager; the base wallet signs with a real key, so the module's own script checks run.
 */
describe('F1: an OrdLock V2 purchase is priced on the pay sheet at what it really takes from the wallet', () => {
  const PRICE = 250_000;
  /** The toolbox wants a bare domain once a basket is involved. */
  const BUYER_SITE = 'market.example';

  function keyedBase(root: PrivateKey, held: { outpoint: string; satoshis: number; tx: Transaction }[] = []) {
    const proto = new ProtoWallet(root);
    const calls: string[] = [];
    const known = new Map<string, Transaction>();
    const coin = (sats: number) => {
      const t = new Transaction();
      t.addInput({
        sourceTXID: '22'.repeat(32),
        sourceOutputIndex: 0,
        unlockingScript: new Script(),
        sequence: 0xffffffff,
      });
      t.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(5).toAddress()), satoshis: sats });
      t.merklePath = new MerklePath(900_000, [[{ offset: 0, hash: t.id('hex'), txid: true }]]);
      return t;
    };
    const signable = new Map<string, number[]>();
    let n = 0;
    const base = {
      calls,
      getPublicKey: (a: never) => proto.getPublicKey(a),
      createSignature: (a: never) => proto.createSignature(a),
      encrypt: async (a: { plaintext: number[] }) => ({ ciphertext: a.plaintext }),
      decrypt: async (a: { ciphertext: number[] }) => ({ plaintext: a.ciphertext }),
      listActions: async () => ({ totalActions: 0, actions: [] }),
      listOutputs: async (a: { basket?: string }) => {
        if (a.basket !== '1sat-deposit' || !held.length) return { totalOutputs: 0, outputs: [] };
        const beef = new Beef();
        for (const h of held) beef.mergeTransaction(h.tx);
        return {
          totalOutputs: held.length,
          BEEF: beef.toBinary(),
          outputs: held.map((h) => ({
            outpoint: h.outpoint,
            satoshis: h.satoshis,
            spendable: true,
            tags: [`hold:${Date.now() + 60_000}`, 'ordlock-funding'],
            customInstructions: JSON.stringify({ protocolID: [1, 'onesat'], keyID: 'held', counterparty: 'self' }),
          })),
        };
      },
      createAction: async (args: {
        inputs?: { outpoint: string }[];
        inputBEEF?: number[];
        outputs?: { lockingScript: string; satoshis: number }[];
        options?: { signAndProcess?: boolean };
      }) => {
        const tx = new Transaction();
        const beef = args.inputBEEF ? Beef.fromBinary(Array.from(args.inputBEEF)) : undefined;
        let into = 0;
        for (const i of args.inputs ?? []) {
          const [txid, vout] = i.outpoint.replace('_', '.').split('.');
          const src = known.get(txid) ?? beef?.findAtomicTransaction(txid);
          if (!src) throw new Error(`fake: no source for ${i.outpoint}`);
          tx.addInput({
            sourceTransaction: src,
            sourceOutputIndex: Number(vout),
            unlockingScript: new Script(),
            sequence: 0xffffffff,
          });
          into += src.outputs[Number(vout)].satoshis ?? 0;
        }
        const fund = coin(FUNDS);
        tx.addInput({
          sourceTransaction: fund,
          sourceOutputIndex: 0,
          unlockingScript: new Script(),
          sequence: 0xffffffff,
        });
        let out = 0;
        for (const o of args.outputs ?? []) {
          tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
          out += o.satoshis;
        }
        tx.addOutput({
          lockingScript: new P2PKH().lock(new PrivateKey(6).toAddress()),
          satoshis: into + FUNDS - out - FEE,
        });
        known.set(tx.id('hex'), tx);
        const atomic = (() => {
          const b = new Beef();
          b.mergeTransaction(tx);
          return b.toBinaryAtomic(tx.id('hex'));
        })();
        if (args.options?.signAndProcess === false) {
          calls.push('createAction');
          const reference = `ref-${++n}`;
          signable.set(reference, atomic);
          return { signableTransaction: { tx: atomic, reference } };
        }
        calls.push('prepare'); // the module's own front-funding step (wallet to wallet)
        return { txid: tx.id('hex'), tx: atomic };
      },
      signAction: async (a: { reference: string }) => {
        calls.push('signAction');
        const tx = signable.get(a.reference)!;
        return { txid: Transaction.fromAtomicBEEF(tx).id('hex'), tx };
      },
      abortAction: async () => {
        calls.push('abortAction');
        return { aborted: true };
      },
    };
    return base;
  }

  /** A seller's OrdLock V2 listing of a 1-sat ordinal at PRICE, as a site would hand it to the wallet. */
  const listing = () => {
    const seller = new PrivateKey(42).toAddress();
    const lock = OrdLockV2.lock(seller, seller, PRICE);
    const t = new Transaction();
    t.addInput({
      sourceTXID: '33'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    t.addOutput({ lockingScript: lock, satoshis: 1 });
    t.merklePath = new MerklePath(900_001, [[{ offset: 0, hash: t.id('hex'), txid: true }]]);
    const beef = new Beef();
    beef.mergeTransaction(t);
    const payout = OrdLockV2.payoutOutput(lock);
    return {
      description: 'Buy a listed ordinal',
      labels: ['p 1sat action'],
      inputBEEF: beef.toBinary(),
      inputs: [{ outpoint: `${t.id('hex')}.0`, inputDescription: 'the listing', unlockingScriptLength: 2000 }],
      outputs: [
        {
          lockingScript: payout.lockingScript.toHex(),
          satoshis: payout.satoshis!,
          outputDescription: 'pay the seller',
        },
        {
          lockingScript: new P2PKH().lock(new PrivateKey(7).toAddress()).toHex(),
          satoshis: 1,
          outputDescription: 'the ordinal',
          basket: 'bought ordinals',
        },
      ],
    };
  };

  function purchaseWallet(answer: boolean, held: Parameters<typeof keyedBase>[1] = []) {
    const root = new PrivateKey(1234);
    const base = keyedBase(root, held);
    const store = new InMemoryPermissionStore();
    const modules = createAssetPermissionModules({
      wallet: base as never,
      promptHandler: async () => true,
      adminOriginator: ADMIN,
      permissionStore: store as never,
    });
    const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, { permissionModules: modules }, {
      store,
    } as never);
    const sheets: number[] = [];
    (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: {
      type: string;
      spending?: { satoshis: number };
    }) => {
      if (r.type !== 'spending') return true; // the receive basket's own sheet: approved, not what is tested here
      sheets.push(r.spending?.satoshis ?? -1);
      if (!answer) throw new Error('User denied');
      return true;
    };
    const recorded: number[] = [];
    const ledger = { total: async () => 0, record: async (_o: string, _m: string, s: number) => void recorded.push(s) };
    const w = withLocalSpendLedger(
      guardEverySpendAsks(guardPModuleSpends(mgr, { adminOriginator: ADMIN }), {
        adminOriginator: ADMIN,
        normalize: normalizeOriginator,
      }),
      ledger as never,
      () => undefined,
    );
    return { w, base, sheets, recorded, root };
  }

  test('Deny: the pay sheet asks for the price (plus fee), and nothing is signed', async () => {
    const { w, base, sheets } = purchaseWallet(false);
    await expect(w.createAction(listing() as never, BUYER_SITE)).rejects.toThrow();
    expect(sheets).toEqual([PRICE + FEE]);
    expect(base.calls).not.toContain('signAction');
    expect(base.calls).toContain('abortAction');
  });

  test("Approve: signed with the module's real unlocks, and the ledger counts the price", async () => {
    const { w, base, sheets, recorded } = purchaseWallet(true);
    const r = (await w.createAction(listing() as never, BUYER_SITE)) as { txid?: string };
    expect(typeof r.txid).toBe('string');
    expect(sheets).toEqual([PRICE + FEE]);
    expect(recorded).toEqual([PRICE + FEE]);
    expect(base.calls.filter((c) => c === 'signAction').length).toBe(1);
  });

  test('a cushion the module sends back to the wallet is not counted as spent', async () => {
    const root = new PrivateKey(1234);
    const proto = new ProtoWallet(root);
    const { publicKey } = await proto.getPublicKey({
      protocolID: [1, 'onesat'],
      keyID: 'held',
      counterparty: 'self',
      forSelf: true,
    });
    const big = new Transaction();
    big.addInput({
      sourceTXID: '44'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    big.addOutput({
      lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()),
      satoshis: PRICE + 90_000,
    });
    big.merklePath = new MerklePath(900_002, [[{ offset: 0, hash: big.id('hex'), txid: true }]]);
    const { w, sheets } = purchaseWallet(false, [
      { outpoint: `${big.id('hex')}.0`, satoshis: PRICE + 90_000, tx: big },
    ]);
    await expect(w.createAction(listing() as never, BUYER_SITE)).rejects.toThrow();
    expect(sheets).toEqual([PRICE + FEE]);
  });

  test("the wallet's own OrdLock purchase (its Exchange) is unchanged: the module finishes it, no extra pay sheet", async () => {
    const { w, base, sheets } = purchaseWallet(false); // Deny would refuse a site; the wallet itself is not asked
    const r = (await w.createAction(listing() as never, ADMIN)) as { txid?: string };
    expect(typeof r.txid).toBe('string');
    expect(sheets).toEqual([]);
    expect(base.calls.filter((c) => c === 'signAction').length).toBe(1);
  });
});

/**
 * Review 16, F6: the toolbox registers its own BRC-177 'nosend' module, which leaves the signable transaction for the
 * manager's normal spend check. The gate wrapped it too, so a site's "p nosend expiry …" payment got an extra pay sheet
 * and was counted twice in envelopes and the month ledger. Only the asset modules (they finish transactions themselves)
 * take the gate.
 */
describe('F6: a BRC-177 "p nosend" site payment is charged exactly as the toolbox charges it', () => {
  function chain(gated: boolean) {
    const base = fakeBase();
    const store = new InMemoryPermissionStore();
    const modules = createAssetPermissionModules({
      wallet: base as never,
      promptHandler: async () => true,
      adminOriginator: ADMIN,
      permissionStore: store as never,
    });
    const mgr = new LocalWalletPermissionsManager(base as never, ADMIN, { permissionModules: modules }, {
      store,
    } as never);
    const sheets: number[] = [];
    (mgr as unknown as Record<string, unknown>).requestPermissionFlow = async (r: {
      type: string;
      spending?: { satoshis: number };
    }) => {
      if (r.type === 'spending') sheets.push(r.spending?.satoshis ?? -1);
      return true;
    };
    const recorded: number[] = [];
    const ledger = { total: async () => 0, record: async (_o: string, _m: string, s: number) => void recorded.push(s) };
    const inner = gated ? guardPModuleSpends(mgr, { adminOriginator: ADMIN }) : mgr;
    const w = withLocalSpendLedger(
      guardEverySpendAsks(inner, { adminOriginator: ADMIN, normalize: normalizeOriginator }),
      ledger as never,
      () => undefined,
    );
    return { w, sheets, recorded };
  }
  const nosendPayment = () => ({
    description: 'Pay later, or reclaim',
    labels: ['p nosend expiry seconds 3600'],
    outputs: [{ lockingScript: attacker, satoshis: PAY, outputDescription: 'payment to seller' }],
    options: { noSend: true },
  });

  test('mixed with an asset module: the same two charges as the toolbox gives a pure BRC-177 payment', async () => {
    // Review 16b R6: the toolbox's own BRC-177 flow asks twice (a prefunding check, then the payment). With a 1sat
    // module in the same action, the gate's charge replaces the payment one: still two, never three.
    const plain = chain(false);
    await plain.w.createAction(nosendPayment() as never, 'shop.example').catch(() => undefined);
    const mixed = chain(true);
    await mixed.w
      .createAction(
        { ...nosendPayment(), labels: ['p nosend expiry seconds 3600', 'p 1sat action'] } as never,
        'shop.example',
      )
      .catch(() => undefined);
    expect(plain.sheets).toEqual([PAY, PAY + FEE]);
    expect(mixed.sheets).toEqual(plain.sheets);
    expect(mixed.recorded).toEqual(plain.recorded);
  });

  test('same pay sheets and the same ledger entries with the gate as without it', async () => {
    const plain = chain(false);
    await plain.w.createAction(nosendPayment() as never, 'shop.example').catch(() => undefined);
    const gated = chain(true);
    await gated.w.createAction(nosendPayment() as never, 'shop.example').catch(() => undefined);
    expect(plain.sheets.length).toBeGreaterThan(0);
    expect(gated.sheets).toEqual(plain.sheets);
    expect(gated.recorded).toEqual(plain.recorded);
  });
});

describe("the wallet's own module actions still work after the review fixes (1sat, bsv21, OpNS, locks)", () => {
  for (const scheme of ['1sat', 'bsv21', 'opns', 'lock'])
    test(`"p ${scheme} action" from the wallet itself: finished by the module, no pay sheet, nothing refused`, async () => {
      const { w, base, sheets, recorded } = wallet(false);
      const r = (await w.createAction(pay([`p ${scheme} action`]) as never, ADMIN)) as { txid?: string };
      expect(typeof r.txid).toBe('string');
      expect(sheets).toEqual([]);
      expect(recorded).toEqual([]);
      expect(base.calls).toEqual(['createAction', 'signAction']);
    });
});
