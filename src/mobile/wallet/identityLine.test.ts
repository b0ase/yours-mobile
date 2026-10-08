import { describe, expect, test } from 'bun:test';
import { chatIdentityMismatch, identityLine, shortKey } from './identityLine';

const KEY = '02cbe7aa11223344556677889900aabbccddeeff00112233445566778899006ed8';

describe('wallet card identity line', () => {
  test('short key is 6…4', () => {
    expect(shortKey(KEY)).toBe('02cbe7…6ed8');
    expect(shortKey('')).toBe('');
  });
  test('signed in: $handle · key', () => {
    expect(identityLine('bwallet0126', KEY).text).toBe('$bwallet0126 · 02cbe7…6ed8');
    expect(identityLine('$bwallet0126', KEY).handle).toBe('$bwallet0126');
  });
  test('not signed in: key · not signed in to chat', () => {
    const l = identityLine(null, KEY);
    expect(l.text).toBe('02cbe7…6ed8 · not signed in to chat');
    expect(l.handle).toBeNull();
  });
});

describe('chat identity mismatch', () => {
  const session = { handle: 'richardwboase', address: '1Gmail', account: 'acctA' };
  test('no session → no warning', () => {
    expect(chatIdentityMismatch({ account: 'acctA', session: null })).toBe(false);
  });
  test('all consistent → no warning', () => {
    expect(
      chatIdentityMismatch({
        account: 'acctA',
        session,
        expectedAddress: '1Gmail',
        serverHandle: 'RichardWBoase',
        addressLinked: true,
      }),
    ).toBe(false);
  });
  test('unknowns never warn', () => {
    expect(chatIdentityMismatch({ account: 'acctA', session, serverHandle: undefined, addressLinked: null })).toBe(
      false,
    );
  });
  test('session made for another account', () => {
    expect(chatIdentityMismatch({ account: 'acctB', session })).toBe(true);
  });
  test('session signed by another key (the 8 Oct bug: gmail account holding a b0asex token)', () => {
    expect(chatIdentityMismatch({ account: 'acctA', session, expectedAddress: '1Xaccount' })).toBe(true);
  });
  test('token resolves to a different handle on the server', () => {
    expect(chatIdentityMismatch({ account: 'acctA', session, serverHandle: 'b0asex' })).toBe(true);
  });
  test("this account's address is not a credential of the session's handle", () => {
    expect(chatIdentityMismatch({ account: 'acctA', session, addressLinked: false })).toBe(true);
  });
});
