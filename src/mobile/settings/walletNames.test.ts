import { describe, expect, test } from 'bun:test';
import { actionText, confirmText, nameActions } from './nameActions';

describe('WalletNames actions', () => {
  test('main plain name has no actions; the server refuses removing it', () => {
    expect(nameActions({ paymail: 'a@x.com', kind: 'plain', main: true })).toEqual([]);
  });
  test('extra plain names: set as main or remove', () => {
    expect(nameActions({ paymail: 'b@x.com', kind: 'plain', main: false })).toEqual(['main', 'remove']);
  });
  test('linked names unlink, named by provider', () => {
    const n = { paymail: 'b0ase.x@x.com', kind: 'x' as const, main: true };
    expect(nameActions(n)).toEqual(['unlink']);
    expect(actionText('unlink', n).label).toBe('Unlink from X');
    expect(actionText('unlink', { ...n, kind: 'gmail' }).label).toBe('Unlink from Google');
    expect(confirmText('unlink', n, 1)).toContain('next name becomes the main one');
  });
  test('remove explains the 90-day forward', () => {
    expect(confirmText('remove', { paymail: 'b@x.com', kind: 'plain', main: false }, 1)).toContain('90 days');
  });
});
