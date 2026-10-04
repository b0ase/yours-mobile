import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
// The server module (CommonJS, site/lib) — the wallet's signatures must verify there.
import server from '../../../site/lib/paymail.js';
import { signRequest, signedMessage, toAlias, PAYMAIL_ALIAS_RE } from './paymail';
import { ownedFromOutputs, payableLabel, pickName } from './accountName';
import type { WalletOutput } from '@bsv/sdk';

describe('paymail client ↔ server', () => {
  test('canonical message is identical on both sides', () => {
    const f = { alias: 'a', identityKey: '02ab', timestamp: '1' };
    expect(signedMessage('register', f)).toBe(server.signedMessage('register', f));
  });

  test('a wallet-signed register request verifies on the server; tampering fails', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const body = await signRequest(wallet, 'register', {
      alias: 'satchmo',
      ordAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    });
    expect(await server.verifySigned(body, 'register')).toBeNull();
    expect(await server.verifySigned({ ...body, fields: { alias: 'other' } }, 'register')).toBe('Bad signature');
    expect(await server.verifySigned(body, 'inbox')).toBe('Bad signature');
  });

  test('aliases', () => {
    expect(toAlias(' Testy Tester! ')).toBe('testytester');
    expect(PAYMAIL_ALIAS_RE.test('testytester')).toBe(true);
    expect(PAYMAIL_ALIAS_RE.test('-x')).toBe(false);
  });
});

describe('account names', () => {
  const out = (tags: string[]): WalletOutput =>
    ({ outpoint: `${'a'.repeat(64)}.0`, satoshis: 1, spendable: true, tags }) as WalletOutput;

  test('owned names from the opns basket (bound wins over unbound duplicates)', () => {
    const owned = ownedFromOutputs([
      out(['opns', 'name:bob', 'id:x_2']),
      out(['opns', 'name:alice', 'id:y_0', 'opns:published']),
      out(['opns', 'name:bob', 'id:z_0', 'opns:published']),
    ]);
    expect(owned).toEqual([
      { name: 'alice', id: 'y_0', published: true },
      { name: 'bob', id: 'z_0', published: true },
    ]);
  });

  test('pickName: keep owned choice, else single bound, else single owned, else let the user pick', () => {
    const a = { name: 'a', id: '1', published: false };
    const b = { name: 'b', id: '2', published: true };
    const c = { name: 'c', id: '3', published: false };
    expect(pickName([a, b], 'a')).toBe('a');
    expect(pickName([a, b], '')).toBe('b');
    expect(pickName([a], 'stale')).toBe('a');
    expect(pickName([a, c], '')).toBe('');
    expect(pickName([], 'stale')).toBe('');
  });

  test('payable label', () => {
    expect(payableLabel('Testytester', '', 'testytester@bwallet-nine.vercel.app')).toBe(
      'Testytester · testytester@bwallet-nine.vercel.app',
    );
    expect(payableLabel('satchmo', 'satchmo', '')).toBe('satchmo');
    expect(payableLabel('Account 1', '', '')).toBe('Account 1');
  });
});

describe('verified social names', () => {
  test('only *.x and *.gmail', async () => {
    const { SOCIAL_ALIAS_RE } = await import('./paymail');
    expect(SOCIAL_ALIAS_RE.test('b0asex.x')).toBe(true);
    expect(SOCIAL_ALIAS_RE.test('theirname.gmail')).toBe(true);
    expect(SOCIAL_ALIAS_RE.test('evil.com')).toBe(false);
    expect(SOCIAL_ALIAS_RE.test('.x')).toBe(false);
  });
  test('the token keeps the plain ticker', async () => {
    const { personalTicker } = await import('./personalToken');
    expect(personalTicker('b0asex.x')).toBe('B0ASEX');
    expect(personalTicker('theirname.gmail@bwalletx.com')).toBe('THEIRNAME');
    expect(personalTicker('boase')).toBe('BOASE');
  });
});
