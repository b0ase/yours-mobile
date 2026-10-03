import { describe, expect, test } from 'bun:test';
import { Beef, LockingScript, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import { purchaseContext, purchaseUnlockBound, walletOutpoint, withUnlockRoom } from './walletOutpoint';

const txid = '68e08f30d60086b5f3c1bfcac36d9ba46718581f991fd0bb6dc55c2200d4e92a';

describe('walletOutpoint', () => {
  test('converts the 1Sat txid_vout form to the wallet txid.vout form', () => {
    expect(walletOutpoint(`${txid}_0`)).toBe(`${txid}.0`);
    expect(walletOutpoint(`${txid}_12`)).toBe(`${txid}.12`);
  });
  test('leaves txid.vout unchanged', () => {
    expect(walletOutpoint(`${txid}.3`)).toBe(`${txid}.3`);
  });
  test('leaves anything else untouched', () => {
    expect(walletOutpoint('not-an-outpoint')).toBe('not-an-outpoint');
  });
});

describe('purchase unlock room', () => {
  // Listing tx with a 1,100-byte locking script at vout 0.
  const lock = new LockingScript([{ op: 0x4d, data: new Array(1097).fill(7) }]);
  const listing = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1 }], 0);
  const beef = new Beef();
  beef.mergeTransaction(listing);
  const op = `${listing.id('hex')}.0`;
  const p2pkh = '76a914' + '11'.repeat(20) + '88ac';
  const outputs = [
    { lockingScript: '00' + 'ab'.repeat(150) + p2pkh },
    { lockingScript: p2pkh },
    { lockingScript: p2pkh },
  ];
  const args = {
    inputBEEF: beef.toBinary(),
    inputs: [
      { outpoint: op, unlockingScriptLength: 1402 },
      { outpoint: `${txid}.1`, unlockingScriptLength: 108 },
    ],
    outputs,
  };

  test('bound covers the real purchase unlock with 8 change outputs', () => {
    const ser = (hex: string) => {
      const w = new Utils.Writer();
      w.writeUInt64LE(1);
      w.writeVarIntNum(hex.length / 2);
      w.write(Utils.toArray(hex, 'hex'));
      return w.toArray();
    };
    const rest = [...outputs.slice(2), ...new Array(8).fill({ lockingScript: p2pkh })].flatMap((o) =>
      ser(o.lockingScript),
    );
    const preimage = new Array(4 + 32 + 32 + 36 + 3 + 1100 + 8 + 4 + 32 + 4 + 4).fill(1);
    const real = new UnlockingScript()
      .writeBin(ser(outputs[0].lockingScript))
      .writeBin(rest)
      .writeBin(preimage)
      .writeOpCode(0);
    const bound = purchaseUnlockBound(args, op)!;
    expect(bound).toBeGreaterThanOrEqual(real.toBinary().length);
    expect(bound).toBeLessThan(real.toBinary().length + 200);
  });
  test('raises only the listing input, never lowers', () => {
    const out = withUnlockRoom(args, op);
    expect(out.inputs.map((i) => i.unlockingScriptLength)).toEqual([purchaseUnlockBound(args, op), 108]);
    const big = withUnlockRoom({ ...args, inputs: [{ outpoint: op, unlockingScriptLength: 99999 }] }, op);
    expect(big.inputs[0].unlockingScriptLength).toBe(99999);
  });
  test('leaves args alone without a usable BEEF', () => {
    const noBeef = { inputs: args.inputs, outputs };
    expect(withUnlockRoom(noBeef, op)).toBe(noBeef);
  });
  test('purchaseContext wraps createAction and keeps other members', async () => {
    let seen: unknown;
    const wallet = {
      tag: 'w',
      createAction: async (a: unknown) => {
        seen = a;
        return 'ok';
      },
      getPublicKey() {
        return this.tag;
      },
    };
    const ctx = purchaseContext({ wallet, chain: 'main' }, op);
    expect(await ctx.wallet.createAction(args as never)).toBe('ok');
    expect((seen as typeof args).inputs[0].unlockingScriptLength).toBe(purchaseUnlockBound(args, op)!);
    expect(ctx.wallet.getPublicKey()).toBe('w');
    expect(ctx.chain).toBe('main');
  });
});
