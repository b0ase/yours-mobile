import { describe, expect, test } from 'bun:test';
import { handleState, pickHandleAlias, socialCloseTarget } from './handlePrompt';

describe('handleState', () => {
  test('waits for the lookup when nothing is cached', () => {
    expect(handleState('', undefined)).toBe('loading');
  });
  test('a cached paymail is enough', () => {
    expect(handleState('b0asex@pay.bwallet.space', undefined)).toBe('has');
  });
  test('the lookup decides once it answers', () => {
    expect(handleState('', [{ paymail: 'b0asex@pay.bwallet.space' }])).toBe('has');
    expect(handleState('', [])).toBe('none');
  });
});

describe('pickHandleAlias', () => {
  test('main plain name', () => {
    expect(
      pickHandleAlias([
        { paymail: 'aigf@pay.bwallet.space', kind: 'plain', main: false },
        { paymail: 'b0asex@pay.bwallet.space', kind: 'plain', main: true },
      ]),
    ).toBe('b0asex');
  });
  test('a main .x name still finds the plain one', () => {
    expect(
      pickHandleAlias([
        { paymail: 'b0asex.x@pay.bwallet.space', kind: 'x', main: true },
        { paymail: 'b0asex@pay.bwallet.space', kind: 'plain', main: false },
      ]),
    ).toBe('b0asex');
  });
  test('never a .gmail / .x name', () => {
    expect(pickHandleAlias([{ paymail: 'rich.gmail@pay.bwallet.space', kind: 'gmail', main: true }])).toBeNull();
  });
  test('failed lookup falls back to the cached paymail', () => {
    expect(pickHandleAlias([], 'b0asex@pay.bwallet.space')).toBe('b0asex');
    expect(pickHandleAlias([], '')).toBeNull();
  });
});

describe('socialCloseTarget', () => {
  test('opened by the return after unlock goes to the Wallet', () => {
    expect(socialCloseTarget(true)).toBe('wallet');
    expect(socialCloseTarget(false)).toBe('settings');
  });
});
