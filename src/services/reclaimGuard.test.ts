import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { CREATION_GRACE_MS, foreignReclaim, guardReclaims, stopForeignReclaims, type ExpiryRow } from './reclaimGuard';

const spend = (txid: string, vout: number, sats = 900) => {
  const t = new Transaction();
  t.addInput({
    sourceTXID: txid,
    sourceOutputIndex: vout,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: sats });
  return t;
};
const ANCHOR_TX = Utils.toHex(Random(32));
const W = spend(Utils.toHex(Random(32)), 0, 20_000); // the payment (withheld)
const R = spend(ANCHOR_TX, 1); // its own reclaim: spends the anchor
const row = (o: Partial<ExpiryRow> = {}): ExpiryRow => ({
  transactionId: 7,
  txid: W.id('hex'),
  noSendExpiryState: 'revocation-requested',
  noSendExpiryAnchorTxid: ANCHOR_TX,
  noSendExpiryAnchorVout: 1,
  noSendExpiryReclaimTxid: R.id('hex'),
  noSendExpiryReclaimRawTx: R.toBinary(),
  ...o,
});
const armedW = (t: string) => t === W.id('hex');

describe('task 54 round 3 F2: a reclaim posts only what this device armed', () => {
  test("this device's own reclaim (armed here, another tx, spends only our anchor) passes", () => {
    expect(foreignReclaim(row(), { armed: armedW, anchorIsOurs: true })).toBeUndefined();
  });
  test('the page attack: the reclaim pointed at the payment itself', () => {
    const attack = row({
      noSendExpiryReclaimTxid: W.id('hex'),
      noSendExpiryReclaimRawTx: W.toBinary(),
      noSendExpiryAnchorTxid: W.inputs[0].sourceTXID,
      noSendExpiryAnchorVout: 0,
    });
    expect(foreignReclaim(attack, { armed: armedW, anchorIsOurs: true })).toBe('the reclaim is the payment itself');
  });
  test('not armed here, bytes not the txid, other inputs, or an anchor not ours: refused', () => {
    expect(foreignReclaim(row(), { armed: () => false, anchorIsOurs: true })).toBe('not armed on this device');
    expect(
      foreignReclaim(row({ noSendExpiryReclaimRawTx: spend(ANCHOR_TX, 1).toBinary() }), {
        armed: armedW,
        anchorIsOurs: true,
      }),
    ).toBe('the reclaim bytes are not the reclaim txid');
    const other = spend(Utils.toHex(Random(32)), 0);
    expect(
      foreignReclaim(row({ noSendExpiryReclaimTxid: other.id('hex'), noSendExpiryReclaimRawTx: other.toBinary() }), {
        armed: armedW,
        anchorIsOurs: true,
      }),
    ).toBe('the reclaim spends something other than the anchor');
    expect(foreignReclaim(row(), { armed: armedW, anchorIsOurs: false })).toBe(
      'the anchor is not an output of this device',
    );
  });

  const store = (rows: ExpiryRow[], anchors = true) => {
    const updates: [number, Record<string, unknown>][] = [];
    return {
      updates,
      sp: {
        findTransactions: async (a: { partial: Record<string, unknown> }) =>
          rows.filter((r) => r.noSendExpiryState === a.partial.noSendExpiryState),
        findOutputs: async () => (anchors ? [{}] : []),
        updateTransaction: async (id: number, u: Record<string, unknown>) => void updates.push([id, u]),
      },
    };
  };
  test("stopForeignReclaims: a foreign one is set 'cancelled' (the task ignores it); our own is left", async () => {
    const { sp, updates } = store([row(), row({ transactionId: 8, txid: Utils.toHex(Random(32)) })]);
    const stopped = await stopForeignReclaims(sp, armedW, () => undefined);
    expect(stopped).toHaveLength(1);
    expect(updates).toEqual([[8, { noSendExpiryState: 'cancelled' }]]);
  });
  test('a createAction of our own still in progress (fresh preparing/unsigned/signed row) is left alone', async () => {
    const now = Date.now();
    const fresh = row({ txid: Utils.toHex(Random(32)), noSendExpiryState: 'signed', updated_at: new Date(now) });
    const old = row({
      transactionId: 9,
      txid: Utils.toHex(Random(32)),
      noSendExpiryState: 'signed',
      updated_at: new Date(now - CREATION_GRACE_MS - 1),
    });
    const { sp, updates } = store([fresh, old]);
    await stopForeignReclaims(sp, armedW, () => undefined, now);
    expect(updates).toEqual([[9, { noSendExpiryState: 'cancelled' }]]);
  });
  test('guardReclaims: the check runs before every run of the NoSendExpiry task', async () => {
    const order: string[] = [];
    const task = {
      name: 'NoSendExpiry',
      runTask: async () => {
        order.push('task');
        return '';
      },
    };
    const monitor = { _tasks: [task] };
    const { sp } = store([row({ transactionId: 5, txid: Utils.toHex(Random(32)) })]);
    const storage = {
      runAsStorageProvider: async <T>(f: (s: never) => Promise<T>) => {
        order.push('check');
        return f(sp as never);
      },
    };
    expect(guardReclaims(monitor, storage, armedW)).toBe(true);
    await task.runTask();
    expect(order).toEqual(['check', 'task']);
    expect(guardReclaims({ _tasks: [] }, storage, armedW)).toBe(false);
  });
});
