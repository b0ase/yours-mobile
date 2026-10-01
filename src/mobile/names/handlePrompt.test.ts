import { describe, expect, test } from 'bun:test';
import { handleTitle, parsePending, shouldShowCard, shouldShowOnboarding, suggestHandle } from './handlePrompt';

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

  test('wallet card until named, unless dismissed or onboarding is open', () => {
    expect(shouldShowCard(false, false, false)).toBe(true);
    expect(shouldShowCard(true, false, false)).toBe(false);
    expect(shouldShowCard(false, true, false)).toBe(false);
    expect(shouldShowCard(false, false, true)).toBe(false);
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
