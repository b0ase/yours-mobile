import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ChatApiError } from './api';
import { onChatAccountChange, setChatAccount } from './chatAccount';
import {
  CHAT_SESSION_FAILED,
  ERROR_RETRY_MS,
  LOOP_GUARD_MS,
  afterAuthLost,
  shouldSignIn,
  stateFromError,
} from './sessionRules';
import {
  HANDLES_TTL_MS,
  handlesStale,
  isInactiveAlias,
  loadServerHandles,
  saveServerHandles,
  usableAlias,
  usableNames,
} from './signInNames';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage');
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const NOW = 1_800_000_000_000;

describe('chat session states (no visible sign-in)', () => {
  test('idle signs in; pending, ready and off never start another', () => {
    expect(shouldSignIn({ kind: 'idle' }, { now: NOW })).toBe(true);
    expect(shouldSignIn({ kind: 'pending' }, { now: NOW, force: true })).toBe(false);
    expect(shouldSignIn({ kind: 'ready', handle: 'b0asex', at: NOW }, { now: NOW, force: true })).toBe(false);
    expect(shouldSignIn({ kind: 'off' }, { now: NOW, force: true })).toBe(false);
  });
  test('after a failure: quiet for a while, Retry goes at once', () => {
    const err = { kind: 'error' as const, message: CHAT_SESSION_FAILED, at: NOW };
    expect(shouldSignIn(err, { now: NOW + 1000 })).toBe(false);
    expect(shouldSignIn(err, { now: NOW + ERROR_RETRY_MS })).toBe(true);
    expect(shouldSignIn(err, { now: NOW + 1000, force: true })).toBe(true);
  });
  test('waiting on the person’s choice of name: only Retry, or opening Chat (a name may be chosen now)', () => {
    const need = { kind: 'needs-handle' as const, claimToken: 'c', address: 'a' };
    expect(shouldSignIn(need, { now: NOW })).toBe(false);
    expect(shouldSignIn(need, { now: NOW, force: true })).toBe(true);
    expect(shouldSignIn(need, { now: NOW, recheckHandle: true })).toBe(true);
  });
  test('a new wallet with no name becomes "Choose your handle"; anything else one line + Retry', () => {
    const need = new ChatApiError('Choose your handle first.', 409, {
      needs_handle: true,
      claim_token: 'ct',
      address: '1A',
    });
    expect(stateFromError(need, NOW)).toEqual({ kind: 'needs-handle', claimToken: 'ct', address: '1A' });
    expect(stateFromError(new ChatApiError('bChat error 500', 500), NOW)).toEqual({
      kind: 'error',
      message: CHAT_SESSION_FAILED,
      at: NOW,
    });
    expect(stateFromError(new Error('Network error'), NOW).kind).toBe('error');
  });
  test('a refused session signs in again quietly, but not in a loop', () => {
    expect(afterAuthLost({ kind: 'ready', handle: 'h', at: 0 }, NOW)).toEqual({ kind: 'idle' });
    expect(afterAuthLost({ kind: 'ready', handle: 'h', at: NOW - LOOP_GUARD_MS - 1 }, NOW)).toEqual({ kind: 'idle' });
    expect(afterAuthLost({ kind: 'ready', handle: 'h', at: NOW - 2000 }, NOW).kind).toBe('error');
    expect(afterAuthLost({ kind: 'pending' }, NOW)).toEqual({ kind: 'idle' });
  });
});

describe('sign-in names: inactive aliases are never offered (owner’s $b0ase / $b0asex)', () => {
  const owner = [
    { handle: 'b0asex', primary: true },
    { handle: 'b0ase', primary: false },
  ];
  test('b0ase@ (paymail main) is an inactive alias: the active handle is used instead', () => {
    expect(isInactiveAlias('b0ase', owner)).toBe(true);
    expect(isInactiveAlias('$B0ASE', owner)).toBe(true);
    expect(isInactiveAlias('b0ase@bwalletx.com', owner)).toBe(true);
    expect(isInactiveAlias('b0asex', owner)).toBe(false);
    expect(usableAlias('b0ase', owner)).toBe('b0asex');
    expect(usableAlias('b0asex', owner)).toBe('b0asex');
  });
  test('names the server doesn’t list (or no list yet) stay as they are', () => {
    expect(usableAlias('newname', owner)).toBe('newname');
    expect(usableAlias('b0ase', null)).toBe('b0ase');
    expect(usableAlias('', owner)).toBe('');
  });
  test('the paymail list loses inactive aliases', () => {
    const names = [
      { paymail: 'b0ase@bwalletx.com', kind: 'plain', main: true },
      { paymail: 'b0asex@bwalletx.com', kind: 'plain' },
    ];
    expect(usableNames(names, owner).map((n) => n.paymail)).toEqual(['b0asex@bwalletx.com']);
    expect(usableNames(names, undefined)).toHaveLength(2);
  });
  test('kept per account; stale after the TTL', () => {
    store.clear();
    saveServerHandles('1A', [{ handle: '$B0asex', primary: true }], NOW);
    expect(loadServerHandles('1A')).toEqual({ at: NOW, handles: [{ handle: 'b0asex', primary: true }] });
    expect(loadServerHandles('1B')).toBeNull();
    expect(loadServerHandles(null)).toBeNull();
    expect(handlesStale(loadServerHandles('1A'), NOW + 1000)).toBe(false);
    expect(handlesStale(loadServerHandles('1A'), NOW + HANDLES_TTL_MS)).toBe(true);
    expect(handlesStale(null, NOW)).toBe(true);
  });
});

describe('account switch is announced (the session follows it)', () => {
  beforeEach(() => setChatAccount(null));
  afterAll(() => setChatAccount(null));
  test('listeners hear each change once, not repeats', () => {
    const heard: (string | null)[] = [];
    const off = onChatAccountChange((a) => heard.push(a));
    setChatAccount('1A');
    setChatAccount('1A');
    setChatAccount('1B');
    off();
    setChatAccount('1C');
    expect(heard).toEqual(['1A', '1B']);
  });
});
