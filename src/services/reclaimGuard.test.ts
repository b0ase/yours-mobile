import { describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { checkReclaim, guardReclaimActivation, reclaimLockFor, reclaimVerdict, type ExpiryRow } from './reclaimGuard';

const root = PrivateKey.fromRandom();
const wallet = {
  keyDeriver: new KeyDeriver(root),
  getClientChangeKeyPair: () => ({ privateKey: root.toString(), publicKey: root.toPublicKey().toString() }),
};
const lockFor = reclaimLockFor(wallet);
const anchorKey = PrivateKey.fromRandom();
const p2pkh = (k: PrivateKey) => new P2PKH().lock(k.toAddress());

/** funding (its output 0 is the anchor) → W (the payment, spends the anchor) and R (the reclaim, spends it too). */
const scene = async (o: { pay?: 'ours' | 'foreign'; extraInput?: boolean; signer?: PrivateKey } = {}) => {
  const funding = new Transaction();
  funding.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: p2pkh(anchorKey),
    sequence: 0xffffffff,
  });
  funding.addOutput({ lockingScript: p2pkh(anchorKey), satoshis: 1_000 });
  const W = new Transaction();
  W.addInput({
    sourceTransaction: funding,
    sourceOutputIndex: 0,
    unlockingScript: p2pkh(anchorKey),
    sequence: 0xffffffff,
  });
  W.addOutput({ lockingScript: p2pkh(PrivateKey.fromRandom()), satoshis: 900 });
  const R = new Transaction();
  R.addInput(
    o.extraInput
      ? { sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: p2pkh(anchorKey), sequence: 0xffffffff }
      : {
          sourceTransaction: funding,
          sourceOutputIndex: 0,
          unlockingScriptTemplate: new P2PKH().unlock(o.signer ?? anchorKey),
          sequence: 0xffffffff,
        },
  );
  if (o.extraInput)
    R.addInput({
      sourceTXID: Utils.toHex(Random(32)),
      sourceOutputIndex: 1,
      unlockingScript: p2pkh(anchorKey),
      sequence: 0xffffffff,
    });
  R.addOutput({
    lockingScript: o.pay === 'foreign' ? p2pkh(PrivateKey.fromRandom()) : Script.fromHex(lockFor('pre', 'suf')),
    satoshis: 990,
  });
  if (!o.extraInput) await R.sign();
  const row: ExpiryRow = {
    transactionId: 7,
    txid: W.id('hex'),
    rawTx: W.toBinary(),
    noSendExpiryState: 'revocation-requested',
    noSendExpiryAnchorTxid: funding.id('hex'),
    noSendExpiryAnchorVout: 0,
    noSendExpiryReclaimTxid: R.id('hex'),
    noSendExpiryReclaimRawTx: R.toBinary(),
    noSendExpiryReclaimDerivationPrefix: 'pre',
    noSendExpiryReclaimDerivationSuffix: 'suf',
    noSendExpiryReclaimSatoshis: 990,
  };
  /** This store: the payment's row (and `extra` rows), the funding transaction's own bytes, the anchor's output row. */
  const store = (anchorHere = true, o: { rowScript?: number[]; fundingBytes?: boolean; extra?: ExpiryRow[] } = {}) => ({
    findTransactions: async (a: { partial: Record<string, unknown> }) =>
      [
        ...(o.extra ?? []),
        row,
        ...(o.fundingBytes === false ? [] : [{ txid: funding.id('hex'), rawTx: funding.toBinary() } as ExpiryRow]),
      ].filter((r) => Object.entries(a.partial).every(([k, v]) => (r as Record<string, unknown>)[k] === v)),
    findOutputs: async () =>
      anchorHere
        ? [{ lockingScript: o.rowScript ?? funding.outputs[0].lockingScript.toBinary(), satoshis: 1_000 }]
        : [],
  });
  return { funding, W, R, row, store };
};

describe('task 54 round 4: a reclaim goes out only when it is structurally the wallet’s own', () => {
  test("the wallet's own reclaim (no marks of any kind needed: two-step, made before this release, restored) passes", async () => {
    const { row, store } = await scene();
    expect(await checkReclaim(store(), row, lockFor)).toBeUndefined();
  });
  test('forged: the reclaim is the payment itself', async () => {
    const { row, store, W } = await scene();
    const forged = { ...row, noSendExpiryReclaimTxid: W.id('hex'), noSendExpiryReclaimRawTx: W.toBinary() };
    expect(await checkReclaim(store(), forged, lockFor)).toBe('the reclaim is the payment itself');
  });
  test('forged: pays a foreign key', async () => {
    const { row, store } = await scene({ pay: 'foreign' });
    expect(await checkReclaim(store(), row, lockFor)).toBe("the reclaim doesn't pay this wallet's own key");
  });
  test('forged: an extra input', async () => {
    const { row, store } = await scene({ extraInput: true });
    expect(await checkReclaim(store(), row, lockFor)).toBe('the reclaim spends something other than the anchor');
  });
  test("forged: a signature that doesn't unlock the anchor", async () => {
    const { row, store } = await scene({ signer: PrivateKey.fromRandom() });
    expect(await checkReclaim(store(), row, lockFor)).toBe('the reclaim signature does not verify');
  });
  test("an anchor that isn't in this store, or that the payment doesn't spend", async () => {
    const { row, store } = await scene();
    expect(await checkReclaim(store(false), row, lockFor)).toBe('the anchor is not an output in this store');
    const other = await scene();
    expect(await checkReclaim(store(), { ...row, rawTx: other.W.toBinary(), txid: other.W.id('hex') }, lockFor)).toBe(
      'the payment does not spend the anchor',
    );
  });
  test('reclaimVerdict: a posted txid that is some payment’s reclaim is checked; any other txid passes', async () => {
    const { row, store, W } = await scene({ pay: 'foreign' });
    expect(await reclaimVerdict(store(), row.noSendExpiryReclaimTxid!, lockFor)).toBe(
      "the reclaim doesn't pay this wallet's own key",
    );
    expect(await reclaimVerdict(store(), W.id('hex'), lockFor)).toBeUndefined();
  });

  const activation = async (o: Parameters<typeof scene>[0]) => {
    const { row, store } = await scene(o);
    const moved: string[] = [];
    const s = {
      ...store(),
      compareAndSetNoSendExpiryState: async (_id: number, _e: string, next: string) => {
        moved.push(next);
        return true;
      },
    };
    const logs: string[] = [];
    expect(guardReclaimActivation(s, lockFor, (m) => logs.push(m))).toBe(true);
    const r = await s.compareAndSetNoSendExpiryState(7, 'revocation-requested', 'reclaiming');
    return { r, moved, logs, row };
  };
  test("activation of a forged reclaim: refused (not moved, nothing written, never 'cancelled'), logged", async () => {
    const { r, moved, logs, row } = await activation({ pay: 'foreign' });
    expect([r, moved, row.noSendExpiryState]).toEqual([false, [], 'revocation-requested']);
    expect(logs).toHaveLength(1);
  });
  test("activation of the wallet's own reclaim goes ahead", async () => {
    const { r, moved } = await activation({});
    expect([r, moved]).toEqual([true, ['reclaiming']]);
  });

  test("round 5 (1): a forged row naming the same reclaim doesn't block the real one (any passing row lets it out)", async () => {
    const { row, store } = await scene();
    const other = await scene();
    // A forged payment row that names this reclaim but whose payment doesn't spend the anchor; it sorts first.
    const forged: ExpiryRow = { ...row, transactionId: 1, txid: other.W.id('hex'), rawTx: other.W.toBinary() };
    expect(await checkReclaim(store(true, { extra: [forged] }), forged, lockFor)).toBe(
      'the payment does not spend the anchor',
    );
    expect(
      await reclaimVerdict(store(true, { extra: [forged] }), row.noSendExpiryReclaimTxid!, lockFor),
    ).toBeUndefined();
    // Only forged rows: refused, with the first one's reason.
    const bad = await scene({ pay: 'foreign' });
    expect(await reclaimVerdict(bad.store(), bad.row.noSendExpiryReclaimTxid!, lockFor)).toBe(
      "the reclaim doesn't pay this wallet's own key",
    );
  });

  test("round 5 (2): the anchor's script comes from the anchor transaction's own bytes, never the output row", async () => {
    // A reclaim that unlocks nothing (no signature), and an anchor row that says OP_TRUE (anyone can spend).
    const { row, store } = await scene({ signer: PrivateKey.fromRandom() });
    const R = Transaction.fromBinary(Array.from(row.noSendExpiryReclaimRawTx!));
    R.inputs[0].unlockingScript = new Script();
    const unsigned = { ...row, noSendExpiryReclaimTxid: R.id('hex'), noSendExpiryReclaimRawTx: R.toBinary() };
    const OP_TRUE = [0x51];
    expect(await checkReclaim(store(true, { rowScript: OP_TRUE }), unsigned, lockFor)).toBe(
      'the reclaim signature does not verify',
    );
    // No bytes of the anchor transaction here: refused.
    const good = await scene();
    expect(await checkReclaim(good.store(true, { fundingBytes: false }), good.row, lockFor)).toBe(
      "the anchor transaction's bytes are not here",
    );
  });
});
