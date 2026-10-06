import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import type { Http } from '../chat/api';
import {
  CALL_SIGN_KEY_ID,
  CALL_SIGN_PROTOCOL,
  CallsClient,
  sessionProofMessage,
  type CallSession,
  type CallSigner,
} from './api';

const wallet = new ProtoWallet(PrivateKey.fromRandom());
const signer: CallSigner = {
  identityKey: async () => (await wallet.getPublicKey({ identityKey: true })).publicKey,
  sign: async (message) => {
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(message, 'utf8'),
      protocolID: CALL_SIGN_PROTOCOL,
      keyID: CALL_SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return Utils.toHex(signature);
  },
};

const memStore = () => {
  let s: CallSession | null = null;
  return { load: () => s, save: (v: CallSession | null) => void (s = v), peek: () => s };
};

describe('CallsClient session', () => {
  test('signs a proof the server can verify with the identity key as counterparty', async () => {
    type SessionBody = { identity_key: string; timestamp: number; nonce: string; signature: string };
    const seen: { url: string; body: SessionBody }[] = [];
    const http: Http = async ({ url, body }) => {
      seen.push({ url, body: body as SessionBody });
      return {
        status: 200,
        data: { token: 'wc1.a.b', identity_key: (body as SessionBody).identity_key, expires_at: '2099-01-01T00:00:00Z' },
      };
    };
    const store = memStore();
    const c = new CallsClient(http, signer, 'https://x.test', store, () => 1_790_000_000_000);
    const s = await c.signIn();
    expect(seen[0].url).toBe('https://x.test/api/bitsign/wallet-calls/session');
    const { identity_key, timestamp, nonce, signature } = seen[0].body;
    expect(identity_key).toBe(await signer.identityKey());
    expect(timestamp).toBe(1_790_000_000_000);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    // Exactly the server's verification (bit-sign wallet-call-auth.ts).
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(sessionProofMessage(identity_key, timestamp, nonce), 'utf8'),
      signature: Utils.toArray(signature, 'hex'),
      protocolID: CALL_SIGN_PROTOCOL,
      keyID: CALL_SIGN_KEY_ID,
      counterparty: identity_key,
    });
    expect(valid).toBe(true);
    expect(s.token).toBe('wc1.a.b');
    expect(store.peek()?.token).toBe('wc1.a.b');
  });

  test('sends the bearer and re-signs once on 401', async () => {
    let sessions = 0;
    const auths: string[] = [];
    const http: Http = async ({ url, headers, body }) => {
      if (url.endsWith('/session')) {
        sessions++;
        return {
          status: 200,
          data: { token: `wc1.t${sessions}.m`, identity_key: body.identity_key, expires_at: '2099-01-01T00:00:00Z' },
        };
      }
      auths.push(headers.Authorization);
      return auths.length === 1
        ? { status: 401, data: { error: 'Unauthorized' } }
        : { status: 200, data: { incoming: [], recent: [] } };
    };
    const c = new CallsClient(http, signer, 'https://x.test', memStore());
    await c.list();
    expect(sessions).toBe(2);
    expect(auths).toEqual(['Bearer wc1.t1.m', 'Bearer wc1.t2.m']);
  });

  test('surfaces server refusals (rate limit) as errors with the message', async () => {
    const http: Http = async ({ url, body }) =>
      url.endsWith('/session')
        ? {
            status: 200,
            data: { token: 'wc1.a.b', identity_key: body.identity_key, expires_at: '2099-01-01T00:00:00Z' },
          }
        : { status: 429, data: { error: 'Too many calls. Try again later.' } };
    const c = new CallsClient(http, signer, 'https://x.test', memStore());
    await expect(c.place('03' + 'b'.repeat(64), {})).rejects.toThrow('Too many calls');
  });
});
