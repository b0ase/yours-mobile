import { describe, expect, test } from 'bun:test';
import { PURCHASE_UNLOCK_ROOM, purchaseContext, walletOutpoint, withUnlockRoom } from './walletOutpoint';

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
  const op = `${txid}.0`;
  test('raises only the listing input', () => {
    const out = withUnlockRoom(
      {
        inputs: [
          { outpoint: op, unlockingScriptLength: 1402 },
          { outpoint: `${txid}.1`, unlockingScriptLength: 108 },
        ],
      },
      op,
    );
    expect(out.inputs?.map((i) => i.unlockingScriptLength)).toEqual([PURCHASE_UNLOCK_ROOM, 108]);
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
    expect(await ctx.wallet.createAction({ inputs: [{ outpoint: op, unlockingScriptLength: 1 }] } as never)).toBe('ok');
    expect((seen as { inputs: { unlockingScriptLength: number }[] }).inputs[0].unlockingScriptLength).toBe(
      PURCHASE_UNLOCK_ROOM,
    );
    expect(ctx.wallet.getPublicKey()).toBe('w');
    expect(ctx.chain).toBe('main');
  });
});
