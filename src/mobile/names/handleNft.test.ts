import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
const server = require('../../../site/lib/handleNft.js');
import { bindingMessage, handleContent, handleSendTarget, signedBindingMap, GENESIS } from './handleNft';
import type { Resolved } from './names';

describe('handle NFT client', () => {
  const b = {
    alias: 'neo',
    origin: `${'11'.repeat(32)}_0`,
    spent: `${'22'.repeat(32)}_1`,
    to: '02'.padEnd(66, 'a'),
    signer: '03'.padEnd(66, 'b'),
  };

  test('binding message and content match the server byte for byte', () => {
    expect(bindingMessage(b)).toBe(server.bindingMessage(b));
    expect(bindingMessage({ ...b, origin: '', spent: GENESIS })).toBe(
      server.bindingMessage({ ...b, origin: '', spent: GENESIS }),
    );
    expect(handleContent('neo', 'bwalletx.com')).toBe(server.handleContent('neo', 'bwalletx.com'));
  });

  test('a binding signed by the wallet verifies on the server', async () => {
    const key = new PrivateKey(21);
    const wallet = new ProtoWallet(key);
    const to = new PrivateKey(22).toPublicKey().toString();
    const m = await signedBindingMap(wallet, { alias: 'neo', origin: b.origin, spent: b.spent, to });
    const parsed = {
      alias: m['handle.alias'],
      origin: m['handle.origin'],
      spent: m['handle.spent'],
      to: m['handle.to'],
      signer: m['handle.signer'],
      sig: m['handle.sig'],
    };
    expect(parsed.signer).toBe(key.toPublicKey().toString());
    expect(await server.verifyBinding(parsed)).toBe(true);
  });

  test('send target needs both an identity key and an ordinals address', () => {
    const key = new PrivateKey(22).toPublicKey().toString();
    const r = (x: Partial<Resolved>) =>
      ({ input: '$bob', target: 'bob@x', targetKind: 'paymail', via: 'paymail', ...x }) as Resolved;
    expect(handleSendTarget(r({ pubkey: key, ordAddress: '1Abc' }))).toEqual({ ok: true, to: '1Abc', key });
    expect(handleSendTarget(r({ pubkey: key })).ok).toBe(false);
    expect(handleSendTarget(r({ ordAddress: '1Abc' })).ok).toBe(false);
  });
});
