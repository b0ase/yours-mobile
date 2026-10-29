import { describe, expect, test } from 'bun:test';
import { createExcludingUnprovable, unprovableParentTxid } from './unprovableCoinRetry';

const T = 'ab'.repeat(32);
const invalidParam = (msg: string) =>
  Object.assign(new Error(msg), { name: 'WERR_INVALID_PARAMETER', code: 'WERR_INVALID_PARAMETER' });

describe('unprovableParentTxid', () => {
  test('build-time unknown parent errors name the txid', () => {
    expect(unprovableParentTxid(invalidParam(`The txid ${T} parameter must be valid transaction on chain main`))).toBe(
      T,
    );
    expect(unprovableParentTxid(invalidParam(`The txid parameter must be known to storage. ${T} is not known.`))).toBe(
      T,
    );
  });
  test('anything else is not', () => {
    expect(unprovableParentTxid(new Error('An internal error has occurred.'))).toBeUndefined();
    expect(
      unprovableParentTxid(Object.assign(new Error(`txid ${T} is not known`), { code: 'WERR_INTERNAL' })),
    ).toBeUndefined();
    expect(
      unprovableParentTxid(Object.assign(invalidParam(`${T} is not known`), { reviewActionResults: [{ txid: T }] })),
    ).toBeUndefined();
    expect(unprovableParentTxid(invalidParam('outputs must be valid'))).toBeUndefined();
  });
});

describe('createExcludingUnprovable', () => {
  test('sets the coin aside, retries once, puts it back', async () => {
    const log: string[] = [];
    let n = 0;
    const r = await createExcludingUnprovable({
      create: async () => {
        log.push(`create${++n}`);
        if (n === 1) throw invalidParam(`txid ${T} valid transaction on chain main`);
        return 'ok';
      },
      setAside: async (txid) => {
        log.push(`aside ${txid === T}`);
        return { count: 1, restore: async () => void log.push('restore') };
      },
    });
    expect(r).toBe('ok');
    expect(log).toEqual(['create1', 'aside true', 'create2', 'restore']);
  });
  test('retry fails too: coin is still put back, second error thrown', async () => {
    let restored = false;
    let n = 0;
    const e = await createExcludingUnprovable({
      create: async () => {
        n++;
        throw n === 1 ? invalidParam(`txid ${T} valid transaction on chain main`) : new Error('Insufficient funds');
      },
      setAside: async () => ({ count: 2, restore: async () => void (restored = true) }),
    }).catch((x) => x);
    expect(e.message).toBe('Insufficient funds');
    expect(restored).toBe(true);
    expect(n).toBe(2);
  });
  test('nothing to set aside: no retry, first error', async () => {
    let n = 0;
    const first = invalidParam(`txid ${T} valid transaction on chain main`);
    const e = await createExcludingUnprovable({
      create: async () => {
        n++;
        throw first;
      },
      setAside: async () => ({ count: 0, restore: async () => {} }),
    }).catch((x) => x);
    expect(e).toBe(first);
    expect(n).toBe(1);
  });
  test('other errors are never retried', async () => {
    let n = 0;
    let asked = false;
    await createExcludingUnprovable({
      create: async () => {
        n++;
        throw new Error('broadcast failed');
      },
      setAside: async () => ((asked = true), { count: 1, restore: async () => {} }),
    }).catch(() => {});
    expect(n).toBe(1);
    expect(asked).toBe(false);
  });
});
