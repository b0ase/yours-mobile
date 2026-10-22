import { describe, expect, test } from 'bun:test';
import { dropOrphanPatches, isRealAccount, withoutGhostsUnder } from './ChromeStorage.service';

const full = (id: string) => ({ addresses: { identityAddress: id }, name: 'w' });

describe('ghost wallet entries', () => {
  test('a storageConfig patch for a removed wallet is dropped', () => {
    const out = dropOrphanPatches({ A: full('A') }, { B: { storageConfig: { localFirst: true } } });
    expect(out).toEqual({});
  });
  test('a patch for an existing wallet is kept', () => {
    const patch = { A: { storageConfig: { localFirst: true } } };
    expect(dropOrphanPatches({ A: full('A') }, patch)).toEqual(patch);
  });
  test('a brand-new full wallet is kept', () => {
    expect(dropOrphanPatches({}, { C: full('C') })).toEqual({ C: full('C') });
  });
  test('isRealAccount skips entries without addresses', () => {
    expect(isRealAccount(full('A'))).toBe(true);
    expect(isRealAccount({ storageConfig: {} })).toBe(false);
    expect(isRealAccount(undefined)).toBe(false);
  });
  test('restoring the same wallet over a ghost replaces it, never inherits its storage switches', () => {
    const ghost = { storageConfig: { localFirst: true } };
    expect(withoutGhostsUnder({ A: ghost }, { A: full('A') })).toEqual({});
  });
  test('a real wallet is still merged, not replaced', () => {
    expect(withoutGhostsUnder({ A: full('A') }, { A: full('A') })).toEqual({ A: full('A') });
  });
});
