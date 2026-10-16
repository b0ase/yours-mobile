import { describe, expect, test } from 'bun:test';
import { parseAuthLink } from './authLink';

const ID = 'a'.repeat(32);

describe('parseAuthLink', () => {
  test('phone deep link', () => {
    expect(parseAuthLink(`bwalletx://auth?id=${ID}&server=https%3A%2F%2Fauth.bwalletx.com`, false)).toEqual({
      id: ID,
      server: 'https://auth.bwalletx.com',
    });
    expect(parseAuthLink(`bwalletx://auth?id=${ID}`, false)?.server).toBe('https://auth.bwalletx.com');
  });
  test('web wallet and extension hand-off', () => {
    expect(parseAuthLink(`https://web.bwalletx.com/m/settings?bwxauth=${ID}`, false)?.id).toBe(ID);
    expect(parseAuthLink(`https://auth.bwalletx.com/wallet?id=${ID}`, false)?.id).toBe(ID);
  });
  test('never trusts a server named by the link', () => {
    expect(parseAuthLink(`bwalletx://auth?id=${ID}&server=https%3A%2F%2Fevil.test`, false)).toBeNull();
    expect(parseAuthLink(`bwalletx://auth?id=${ID}&server=http%3A%2F%2Flocalhost%3A3000`, false)).toBeNull();
    expect(parseAuthLink(`bwalletx://auth?id=${ID}&server=http%3A%2F%2Flocalhost%3A3000`, true)?.server).toBe(
      'http://localhost:3000',
    );
  });
  test('rejects other links and bad ids', () => {
    expect(parseAuthLink(`bwalletx://subscribe?id=${ID}`, false)).toBeNull();
    expect(parseAuthLink('bwalletx://auth?id=xyz', false)).toBeNull();
    expect(parseAuthLink(`https://evil.test/wallet?id=${ID}`, false)).toBeNull();
    expect(parseAuthLink(null)).toBeNull();
  });
});
