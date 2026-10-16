import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  HANDCASH_REDIRECT,
  authorizeUrl,
  challengeFor,
  friendsProblem,
  friendsProblemText,
  friendsToEntries,
  isHandCashReturn,
  makeVerifier,
  parseReturn,
} from './handcashCore';

describe('HandCash PKCE (bit-sign native contract)', () => {
  it('makes a 43-char base64url verifier, fresh each time', () => {
    const v = makeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(makeVerifier()).not.toBe(v);
  });

  it('challenge = base64url(sha256(verifier)), the format bit-sign checks', async () => {
    const v = makeVerifier();
    const c = await challengeFor(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c).toBe(createHash('sha256').update(v).digest('base64url'));
  });

  it('asks bChatX for native mode with the bwalletx redirect and only the challenge', () => {
    const u = new URL(authorizeUrl('c'.repeat(43)));
    expect(u.origin).toBe('https://www.bchatx.com');
    expect(u.pathname).toBe('/api/auth/handcash');
    expect(u.searchParams.get('mode')).toBe('native');
    expect(u.searchParams.get('redirect')).toBe('bwalletx://auth/handcash');
    expect(u.searchParams.get('code_challenge')).toBe('c'.repeat(43));
    expect(u.search).not.toContain('verifier');
  });

  it('reads the grant or the error from the deep link, and ignores other links', () => {
    expect(isHandCashReturn(`${HANDCASH_REDIRECT}?grant=abc`)).toBe(true);
    expect(isHandCashReturn('bwalletx://social#t=1')).toBe(false);
    expect(parseReturn(`${HANDCASH_REDIRECT}?grant=abc.def`)).toEqual({ grant: 'abc.def' });
    expect(parseReturn(`${HANDCASH_REDIRECT}?error=denied`)).toEqual({ error: 'denied' });
    expect('error' in parseReturn(HANDCASH_REDIRECT)).toBe(true);
  });
});

describe('HandCash friends', () => {
  it('maps statuses: 401 sign in again, 409 no_handcash, 403 no_permission', () => {
    expect(friendsProblem(401)).toBe('signin');
    expect(friendsProblem(409)).toBe('no_handcash');
    expect(friendsProblem(403)).toBe('no_permission');
    expect(friendsProblem(500)).toBe('failed');
    expect(friendsProblemText.signin).toContain('Sign in with HandCash again');
  });

  it('turns friends into handcash.io import entries, deduped, junk dropped', () => {
    const e = friendsToEntries([
      { handle: 'Alice', display_name: ' Alice A ' },
      { handle: '$alice' },
      { handle: 'bob.b', avatar_url: 'x' },
      { handle: '' },
      { handle: 'not a handle' },
      { handle: 'evil@x.com' },
    ]);
    expect(e.map((x) => x.paymail)).toEqual(['alice@handcash.io', 'bob.b@handcash.io']);
    expect(e[0]).toEqual({
      raw: 'alice@handcash.io',
      paymail: 'alice@handcash.io',
      handle: null,
      name: 'Alice A',
      notes: '',
    });
  });
});
