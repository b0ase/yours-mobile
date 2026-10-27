import { beforeEach, describe, expect, it } from 'bun:test';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage');
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;

const {
  SIGNUP_TTL_MS,
  DEFAULT_TTL_MS,
  pendingExpired,
  markUnfinished,
  unfinishedLinks,
  clearUnfinished,
  bindUnfinished,
} = await import('./pendingLink');
const { NEW_ACCOUNT, bindSocial, signupProof, signupPending, doneSignup, socialProof } = await import('./socialLogin');

const KEY = 'bwallet.social';
const A = '1AccountAaaaaaaaaaaaaaaaaaaaaaaaaa';
const profile = { provider: 'x', id: '42', name: 'someone', alias: null };
const pending = (extra: Record<string, unknown>) =>
  mem.set(KEY, JSON.stringify({ provider: 'x', secret: 's', at: Date.now(), owner: NEW_ACCOUNT, ...extra }));

beforeEach(() => mem.clear());

describe('pending sign-up link expiry', () => {
  it('a sign-up link waits 30 minutes; other sign-ins keep 10', () => {
    const now = 1_000_000_000;
    expect(pendingExpired({ at: now - 20 * 60_000, signup: true }, now)).toBe(false);
    expect(pendingExpired({ at: now - SIGNUP_TTL_MS, signup: true }, now)).toBe(true);
    expect(pendingExpired({ at: now - 20 * 60_000 }, now)).toBe(true);
    expect(pendingExpired({ at: now - DEFAULT_TTL_MS + 1 }, now)).toBe(false);
  });

  it('an expired sign-up link is dropped (ticket and secret gone) and offered as Finish linking', () => {
    pending({ signup: true, at: Date.now() - SIGNUP_TTL_MS - 1, ticket: 't', profile });
    expect(signupPending()).toBeNull();
    expect(mem.get(KEY)).toBeUndefined();
    expect(unfinishedLinks(NEW_ACCOUNT)).toEqual(['x']);
    // the reminder holds no ticket, secret or profile
    expect(mem.get('bwallet.links.unfinished')).not.toContain('someone');
    expect(mem.get('bwallet.links.unfinished')).not.toContain('"t"');
  });

  it('an expired ordinary sign-in leaves no reminder', () => {
    pending({ owner: A, at: Date.now() - DEFAULT_TTL_MS - 1, ticket: 't', profile });
    expect(socialProof(A)).toBeNull();
    expect(unfinishedLinks(A)).toEqual([]);
  });
});

describe('binding after the seed step', () => {
  it('nothing can be signed before the account exists', () => {
    pending({ signup: true, ticket: 't', profile });
    expect(signupPending()?.back).toBe(true);
    expect(signupProof(NEW_ACCOUNT)).toBeNull();
    expect(signupProof(A)).toBeNull();
  });

  it('bindSocial hands the held link to the new identity, once', () => {
    pending({ signup: true, ticket: 't', profile, returned: true });
    bindSocial(A);
    expect(signupProof(A)?.ticket).toBe('t');
    expect(JSON.parse(mem.get(KEY)!).returned).toBe(false); // Settings › Connect doesn't reopen for it
    doneSignup(A);
    expect(signupProof(A)).toBeNull();
    expect(socialProof(A)?.ticket).toBe('t'); // still usable by Choose your handle
  });

  it('reminders move to the new account and clear once linked', () => {
    markUnfinished(NEW_ACCOUNT, 'ebay');
    bindUnfinished(NEW_ACCOUNT, A);
    expect(unfinishedLinks(NEW_ACCOUNT)).toEqual([]);
    expect(unfinishedLinks(A)).toEqual(['ebay']);
    clearUnfinished(A, 'ebay');
    expect(unfinishedLinks(A)).toEqual([]);
    expect(mem.get('bwallet.links.unfinished')).toBeUndefined();
  });

  it('a reminder lapses after a week', () => {
    const t = 5_000_000_000;
    markUnfinished(A, 'google', t);
    expect(unfinishedLinks(A, t + 60_000)).toEqual(['google']);
    expect(unfinishedLinks(A, t + 8 * 24 * 60 * 60_000)).toEqual([]);
  });
});
