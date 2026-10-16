import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { answerAuthRequest } from './authApi';
// The server's verifier: the wallet's signature must pass it.
const server = require('../../../site/lib/auth.js');

describe('wallet signature matches the server', () => {
  test('approve signed by the wallet verifies on the server', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const req = {
      id: 'b'.repeat(32),
      client: { id: 'app', name: 'App', site: 'app.test' },
      redirect_uri: 'https://app.test/cb',
    };
    let sent: Record<string, unknown> = {};
    const f = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const now = Date.now();
    await answerAuthRequest(wallet, { id: req.id, server: 'https://auth.bwalletx.com' }, req, 'approve', f, now);
    const row = { id: req.id, client_id: 'app', redirect_uri: req.redirect_uri };
    expect(await server.verifyAuthSignature(sent, row, 'approve', now)).toBeNull();
    expect(await server.verifyAuthSignature(sent, row, 'deny', now)).toBe('Bad signature');
  });
});
