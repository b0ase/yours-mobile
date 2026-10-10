import { describe, expect, test } from 'bun:test';
import { accountIdentityLine, keyFingerprint, chatIdentityMismatch, identityLine, shortKey } from './identityLine';

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

describe('one handle per account on the card', () => {
  test('chat handle matches the paymail alias: the paymail, no second handle', () => {
    const l = accountIdentityLine('testy', KEY, 'testy@bwalletx.com');
    expect(l.text).toBe('testy@bwalletx.com · 02cbe7…6ed8');
    expect(l.issue).toBeNull();
  });
  test('yours-* placeholder is never shown as the handle: a fix prompt instead', () => {
    const l = accountIdentityLine('$yours-jorv3rmo', KEY, 'testy@bwalletx.com');
    expect(l.text).not.toContain('yours-');
    expect(l.issue?.kind).toBe('placeholder');
    expect(l.issue?.text).toBe('bChatX still calls you @yours-jorv3rmo: use @testy');
  });
  test("another account's handle is never shown as this account's", () => {
    const l = accountIdentityLine('b0asex', KEY, 'b0asey@bwalletx.com');
    expect(l.text).toBe('b0asey@bwalletx.com · 02cbe7…6ed8');
    expect(l.issue?.kind).toBe('other');
    expect(l.issue?.text).toBe('Signed in to bChatX as @b0asex: sign in as @b0asey');
  });
  test('not signed in to bChatX', () => {
    expect(accountIdentityLine(null, KEY, 'testy@bwalletx.com').text).toBe('02cbe7…6ed8 · not signed in to bChatX');
  });
  test('no paymail yet: the old line stands', () => {
    expect(accountIdentityLine('bwallet0126', KEY, '').text).toBe('$bwallet0126 · 02cbe7…6ed8');
  });
});

describe('identity key fingerprint', () => {
  const k66 = '0236aa' + '0'.repeat(56) + '3ed4';
  test('first 6 … last 4 of a 66-hex key', () => {
    expect(keyFingerprint(k66)).toBe('0236aa…3ed4');
    expect(keyFingerprint(k66.toUpperCase())).toBe('0236aa…3ed4');
  });
  test('anything that is not a compressed public key gives nothing', () => {
    expect(keyFingerprint('')).toBe('');
    expect(keyFingerprint(null)).toBe('');
    expect(keyFingerprint('1AgSgM1dxKXYbWXvBaA5j3jno8YuVJzZh7')).toBe('');
  });
});
