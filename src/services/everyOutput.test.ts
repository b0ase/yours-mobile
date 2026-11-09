import { describe, expect, test } from 'bun:test';
import { validateListOutputsArgs } from '@bsv/sdk/wallet/validationHelpers';
import { everyOutput, OUTPUTS_UNREADABLE } from './everyOutput';

const ADMIN = 'admin.bwalletx';
type A = { basket: string; limit: number; offset: number };
const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
/** A listing that honours limit and offset, like the toolbox's. */
const lister = (all: number[], withTotal = true) => {
  const asked: A[] = [];
  const read = async (a: A) => {
    asked.push(a);
    const outputs = all.slice(a.offset, a.offset + a.limit);
    return withTotal ? { outputs, totalOutputs: all.length } : { outputs };
  };
  return { read: read as never, asked };
};

describe('everyOutput', () => {
  test('reads past one page, in order, with the right offsets', async () => {
    const all = rows(25_000);
    const { read, asked } = lister(all);
    expect(await everyOutput({}, read, { basket: 'lock' }, ADMIN)).toEqual(all);
    expect(asked.map((a) => a.offset)).toEqual([0, 10_000, 20_000]);
    expect(asked.every((a) => a.limit === 10_000 && a.basket === 'lock')).toBe(true);
  });

  test('stops on an exact multiple without another read', async () => {
    const { read, asked } = lister(rows(20_000));
    expect(await everyOutput({}, read, { basket: 'lock' }, ADMIN)).toHaveLength(20_000);
    expect(asked).toHaveLength(2);
  });

  test('with no total, a full page means read on and a short page means done', async () => {
    const full = lister(rows(10_000), false);
    expect(await everyOutput({}, full.read, { basket: 'lock' }, ADMIN)).toHaveLength(10_000);
    expect(full.asked).toHaveLength(2);
    const short = lister(rows(3), false);
    expect(await everyOutput({}, short.read, { basket: 'lock' }, ADMIN)).toHaveLength(3);
    expect(short.asked).toHaveLength(1);
  });

  test('throws when the total says there is more than can be read', async () => {
    const read = (async () => ({ outputs: [1, 2], totalOutputs: 3 })) as never;
    let n = 0;
    const thenEmpty = (async () =>
      n++ ? { outputs: [], totalOutputs: 3 } : { outputs: [1, 2], totalOutputs: 3 }) as never;
    await expect(everyOutput({}, thenEmpty, { basket: 'lock' }, ADMIN)).rejects.toThrow(OUTPUTS_UNREADABLE);
    // A listing that repeats its first page for ever still ends, refused.
    await expect(everyOutput({}, read, { basket: 'lock' }, ADMIN)).rejects.toThrow(OUTPUTS_UNREADABLE);
    const fullForEver = (async () => ({ outputs: rows(10_000) })) as never;
    await expect(everyOutput({}, fullForEver, { basket: 'lock' }, ADMIN)).rejects.toThrow(OUTPUTS_UNREADABLE);
  });

  test('a failed page throws, even after a good one', async () => {
    let n = 0;
    const read = (async () => {
      if (n++) throw new Error('down');
      return { outputs: rows(10_000), totalOutputs: 10_001 };
    }) as never;
    await expect(everyOutput({}, read, { basket: 'lock' }, ADMIN)).rejects.toThrow('down');
  });

  test("a 'p …' basket comes from the wallet under the manager, decrypted; others from the manager", async () => {
    const plain = lister([1]);
    const under = lister([2]);
    const manager = {
      underlying: { listOutputs: under.read },
      decryptListOutputsMetadata: async (p: { outputs: number[] }) => ({ ...p, outputs: p.outputs.map((x) => x * 10) }),
    };
    expect(await everyOutput(manager, plain.read, { basket: 'p 1sat ordinals' }, ADMIN)).toEqual([20]);
    expect(plain.asked).toHaveLength(0);
    expect(await everyOutput(manager, plain.read, { basket: 'ordinals' }, ADMIN)).toEqual([1]);
    expect(under.asked).toHaveLength(1);
  });

  test("with no wallet underneath, a 'p …' basket falls to the manager (which then decides)", async () => {
    const plain = lister([1]);
    expect(await everyOutput({}, plain.read, { basket: 'p 1sat lock' }, ADMIN)).toEqual([1]);
  });

  test('the args it sends are ones the wallet accepts', () => {
    expect(() => validateListOutputsArgs({ basket: 'p 1sat ordinals', limit: 10_000, offset: 20_000 })).not.toThrow();
  });
});
