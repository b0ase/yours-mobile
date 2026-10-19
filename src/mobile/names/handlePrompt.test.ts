import { describe, expect, test } from 'bun:test';
import {
  handleComplete,
  handleTitle,
  parsePending,
  shouldShowCard,
  shouldShowOnboarding,
  suggestHandle,
  isPlaceholderName,
} from './handlePrompt';

describe('handle prompt', () => {
  test('parsePending accepts only well-formed flags', () => {
    expect(parsePending(JSON.stringify({ id: 'abc', reason: 'create' }))).toEqual({ id: 'abc', reason: 'create' });
    expect(parsePending(JSON.stringify({ id: 'abc', reason: 'restore' }))?.reason).toBe('restore');
    expect(parsePending(null)).toBeNull();
    expect(parsePending('not json')).toBeNull();
    expect(parsePending(JSON.stringify({ id: '', reason: 'create' }))).toBeNull();
    expect(parsePending(JSON.stringify({ id: 'abc', reason: 'other' }))).toBeNull();
  });

  test('onboarding shows for the flagged account without a name', () => {
    const create = { id: 'a', reason: 'create' as const };
    const restore = { id: 'a', reason: 'restore' as const };
    expect(shouldShowOnboarding(create, 'a', false, false)).toBe(true);
    expect(shouldShowOnboarding(create, 'b', false, true)).toBe(false);
    expect(shouldShowOnboarding(create, 'a', true, true)).toBe(false);
    expect(shouldShowOnboarding(null, 'a', false, true)).toBe(false);
    expect(shouldShowOnboarding(create, undefined, false, true)).toBe(false);
    // A restore waits for the name sync so an existing paymail / OpNS name isn't asked for again.
    expect(shouldShowOnboarding(restore, 'a', false, false)).toBe(false);
    expect(shouldShowOnboarding(restore, 'a', false, true)).toBe(true);
    expect(shouldShowOnboarding(restore, 'a', true, true)).toBe(false);
  });

  test('complete needs both a handle and a room', () => {
    expect(handleComplete(true, true)).toBe(true);
    expect(handleComplete(true, false)).toBe(false);
    expect(handleComplete(false, true)).toBe(false);
  });

  test('wallet card until named, unless dismissed or onboarding is open', () => {
    expect(shouldShowCard(false, false, false)).toBe(true);
    expect(shouldShowCard(true, false, false)).toBe(false);
    expect(shouldShowCard(false, true, false)).toBe(false);
    expect(shouldShowCard(false, false, true)).toBe(false);
  });

  test('isPlaceholderName: defaults nobody chose are never shown as a name', () => {
    for (const n of ['Anonymous', 'anon', 'Account 1', 'account', '', '  ', 'bWalletX', 'Yours'])
      expect(isPlaceholderName(n)).toBe(true);
    for (const n of ['Richard', 'b0asex', 'Anon Ymous']) expect(isPlaceholderName(n)).toBe(false);
  });

  test('suggestHandle prefers the profile name and skips default account names', () => {
    expect(suggestHandle('Richard Boase', 'Account 1')).toBe('richardboase');
    expect(suggestHandle('', 'Satchmo')).toBe('satchmo');
    expect(suggestHandle('', 'Account 1')).toBe('');
    expect(suggestHandle('', 'account')).toBe('');
    expect(suggestHandle('!!!', 'bob')).toBe('bob');
  });

  test('handleTitle', () => {
    expect(handleTitle('alice')).toBe('$alice');
    expect(handleTitle('')).toBe('$name');
  });
});

describe('restore from a master backup file', () => {
  test('re-reads storage, then counts every restored account as backed up', async () => {
    const mem = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    try {
      const { markMasterRestored } = await import('./handlePrompt');
      const { importedAt } = await import('../backup/backupState');
      let fresh = false;
      const accounts = [{ addresses: { identityAddress: 'id-a' } }, { addresses: { identityAddress: 'id-b' } }];
      const cs = {
        getAndSetStorage: async () => void (fresh = true),
        // Before the re-read this page's copy has no accounts (the background wrote them).
        getAllAccounts: () => (fresh ? accounts : []),
        getCurrentAccountObject: () => ({ account: fresh ? accounts[0] : undefined }),
      } as unknown as Parameters<typeof markMasterRestored>[0];
      await markMasterRestored(cs);
      expect(importedAt('id-a')).toBeGreaterThan(0);
      expect(importedAt('id-b')).toBeGreaterThan(0);
      expect(JSON.parse(mem.get('bwallet.handlePrompt.pending') ?? '{}')).toEqual({ id: 'id-a', reason: 'restore' });
    } finally {
      g.localStorage = had;
    }
  });
});
