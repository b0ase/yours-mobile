import { describe, expect, test } from 'bun:test';
import {
  LINKED_HANDLE_TTL_MS,
  bindLinkedHandles,
  canClaimSelection,
  claimOrder,
  forgetLinkedHandle,
  handleFromLinked,
  linkedSuggestions,
  rememberLinkedHandle,
  rememberedLinkedHandles,
  resolvePrimary,
} from './linkedHandles';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
};

describe('a $name per linked account', () => {
  test('X: the @name', () => expect(handleFromLinked('x', '@b0ase')).toBe('b0ase'));
  test('Google: the email local part, without @gmail.com and dots', () => {
    expect(handleFromLinked('google', 'rboase2020@gmail.com')).toBe('rboase2020');
    expect(handleFromLinked('google', 'R.Boase.2020@gmail.com')).toBe('rboase2020');
  });
  test('Google without an address gives nothing', () => expect(handleFromLinked('google', 'Richard')).toBe(''));
  test('GitHub login and LinkedIn name', () => {
    expect(handleFromLinked('github', 'B0ase')).toBe('b0ase');
    expect(handleFromLinked('linkedin', 'Richard Boase')).toBe('richardboase');
  });
  test('an email in a handle field is never used', () => expect(handleFromLinked('x', 'a@b.com')).toBe(''));
  test('nothing for empty or invalid input', () => {
    expect(handleFromLinked('x', '')).toBe('');
    expect(handleFromLinked('github', '___')).toBe('');
  });
});

describe('suggestions from all linked accounts', () => {
  test('one per account in X, Google, GitHub, LinkedIn order', () => {
    expect(linkedSuggestions({ google: 'rboase2020', x: 'b0ase', github: 'b0ase-dev' })).toEqual([
      { source: 'x', alias: 'b0ase' },
      { source: 'google', alias: 'rboase2020' },
      { source: 'github', alias: 'b0ase-dev' },
    ]);
  });
  test('a name two accounts share is offered once', () => {
    expect(linkedSuggestions({ x: 'b0ase', github: 'b0ase' })).toEqual([{ source: 'x', alias: 'b0ase' }]);
  });
  test('only linked accounts: none linked, no suggestions', () => expect(linkedSuggestions({})).toEqual([]));
});

describe('exactly one primary', () => {
  test('a single selected name is the primary', () => expect(resolvePrimary(['b0ase'], '')).toBe('b0ase'));
  test('the primary stays while selected', () => expect(resolvePrimary(['a', 'b'], 'b')).toBe('b'));
  test('unselecting the primary with several left asks again', () => expect(resolvePrimary(['a', 'b'], 'c')).toBe(''));
  test('cannot continue without a primary among the selected', () => {
    expect(canClaimSelection([], '')).toBe(false);
    expect(canClaimSelection(['a', 'b'], '')).toBe(false);
    expect(canClaimSelection(['a', 'b'], 'c')).toBe(false);
    expect(canClaimSelection(['a', 'b'], 'b')).toBe(true);
  });
  test('the primary is claimed first, then the others', () => {
    expect(claimOrder(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(claimOrder(['a', 'b'], '')).toEqual([]);
  });
});

describe('stash', () => {
  test('remembers per account, expires after 24 h', () => {
    const s = mem();
    rememberLinkedHandle('id1', 'google', 'rboase2020@gmail.com', 1000, s);
    rememberLinkedHandle('id1', 'x', '@b0ase', 1000, s);
    expect(rememberedLinkedHandles('id1', 2000, s)).toEqual({ x: 'b0ase', google: 'rboase2020' });
    expect(rememberedLinkedHandles('id2', 2000, s)).toEqual({});
    expect(rememberedLinkedHandles('id1', 1000 + LINKED_HANDLE_TTL_MS, s)).toEqual({});
    expect(s.size()).toBe(0);
  });
  test('Create links move to the new account', () => {
    const s = mem();
    rememberLinkedHandle('new', 'google', 'rboase2020@gmail.com', 1000, s);
    bindLinkedHandles('new', 'id1', s);
    expect(rememberedLinkedHandles('new', 2000, s)).toEqual({});
    expect(rememberedLinkedHandles('id1', 2000, s)).toEqual({ google: 'rboase2020' });
  });
  test('unlinking forgets that account only', () => {
    const s = mem();
    rememberLinkedHandle('id1', 'google', 'rboase2020@gmail.com', 1000, s);
    rememberLinkedHandle('id1', 'x', 'b0ase', 1000, s);
    forgetLinkedHandle('id1', 'google', s);
    expect(rememberedLinkedHandles('id1', 2000, s)).toEqual({ x: 'b0ase' });
  });
});
