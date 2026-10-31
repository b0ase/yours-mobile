import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import type { CreateActionArgs, WalletInterface } from '@bsv/sdk';
import { bapSigningKeyId, withNoteFee } from './mintUserNote';

const INSCRIPTION =
  '0063036f7264' +
  '51' +
  '0a' +
  '746578742f706c61696e' +
  '00' +
  '02' +
  '6869' +
  '68' +
  '76a914' +
  '00'.repeat(20) +
  '88ac';
const FEE_ADDR = '1BitcoinEaterAddressDontSendf59kuE';

const recorder = () => {
  const calls: CreateActionArgs[] = [];
  const wallet = {
    createAction: async (a: CreateActionArgs) => {
      calls.push(a);
      return { txid: 'x' };
    },
  } as unknown as WalletInterface;
  return { calls, ctx: { wallet } as unknown as OneSatContext };
};

describe('withNoteFee', () => {
  test('skips the anchor action and adds the fee to the inscription action once', async () => {
    const { calls, ctx } = recorder();
    const w = withNoteFee(ctx, 50, FEE_ADDR).wallet;
    await w.createAction({
      description: 'Sigma anchor output',
      outputs: [{ lockingScript: '76a9', satoshis: 2, outputDescription: 'a' }],
    });
    await w.createAction({
      description: 'ins',
      outputs: [{ lockingScript: INSCRIPTION, satoshis: 1, outputDescription: 'i' }],
    });
    await w.createAction({
      description: 'again',
      outputs: [{ lockingScript: INSCRIPTION, satoshis: 1, outputDescription: 'i' }],
    });
    expect(calls[0].outputs).toHaveLength(1);
    expect(calls[1].outputs).toHaveLength(2);
    expect(calls[1].outputs![1].satoshis).toBe(50);
    expect(calls[2].outputs).toHaveLength(1);
  });
  test('no fee or no address leaves the context alone', () => {
    const { ctx } = recorder();
    expect(withNoteFee(ctx, 0, FEE_ADDR)).toBe(ctx);
    expect(withNoteFee(ctx, 10, '')).toBe(ctx);
  });
});

describe('bapSigningKeyId', () => {
  const w = (tags: string[][]) =>
    ({ listOutputs: async () => ({ outputs: tags.map((t) => ({ tags: t })) }) }) as unknown as WalletInterface;
  test('highest seq wins; none published is null', async () => {
    expect(
      await bapSigningKeyId(
        w([
          ['type:id', 'seq:1'],
          ['type:id', 'seq:3'],
        ]),
      ),
    ).toBe('identity-3');
    expect(await bapSigningKeyId(w([]))).toBeNull();
    expect(await bapSigningKeyId(w([['type:id', 'seq:0']]))).toBeNull();
  });
});
