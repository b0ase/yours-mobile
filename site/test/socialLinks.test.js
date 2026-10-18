const { describe, expect, test } = require('bun:test');
const { PrivateKey, ProtoWallet, Utils } = require('@bsv/sdk');
const social = require('../lib/social');
const socialLinks = require('../lib/socialLinks');
const { signedMessage } = require('../lib/paymail');

// Test-only values (not real credentials).
const ENV = { SOCIAL_SEAL_KEY: 'cd'.repeat(32) };
const secret = 'phone-secret-abc';
const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const ticketFor = (p, id, name) =>
  social.seal({ p, id, name, vh: social.sha256Hex(secret), e: Date.now() + 60_000 }, ENV);

const sign = async (fields) => {
  const w = new ProtoWallet(PrivateKey.fromRandom());
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true });
  const timestamp = Date.now();
  const { signature } = await w.createSignature({
    data: Utils.toArray(signedMessage('link', { ...fields, identityKey, timestamp: String(timestamp) }), 'utf8'),
    protocolID: [2, 'bwallet paymail'],
    keyID: '1',
    counterparty: 'anyone',
  });
  return { identityKey, timestamp, signature: Utils.toHex(signature), fields };
};

describe('Link your accounts: publish', () => {
  test('stores a proved + signed link; Google keeps no address', async () => {
    const rows = [];
    const store = { putSocialLink: async (r) => rows.push(r), listSocialLinks: async () => rows };
    const fields = { provider: 'google', account: sha('google:123'), handle: '' };
    const body = { ticket: ticketFor('google', '123', 'their.name@gmail.com'), secret, ...(await sign(fields)) };
    const [s] = await socialLinks.link(body, store, ENV);
    expect(s).toBe(200);
    expect(JSON.stringify(rows)).not.toContain('gmail');
    const [, out] = await socialLinks.links(body.identityKey, store);
    expect(out.links[0]).toMatchObject({ provider: 'google', handle: '' });
  });

  test('refuses a wrong handle, a wrong secret, and an unsigned link', async () => {
    const store = { putSocialLink: async () => undefined };
    const fields = { provider: 'x', account: sha('x:42'), handle: 'someoneelse' };
    const t = ticketFor('x', '42', 'b0asex');
    expect((await socialLinks.link({ ticket: t, secret, ...(await sign(fields)) }, store, ENV))[0]).toBe(400);
    const ok = { provider: 'x', account: sha('x:42'), handle: 'b0asex' };
    expect((await socialLinks.link({ ticket: t, secret: 'nope', ...(await sign(ok)) }, store, ENV))[0]).toBe(401);
    const signed = await sign(ok);
    expect((await socialLinks.link({ ticket: t, secret, ...signed, signature: '00'.repeat(36) }, store, ENV))[0]).toBe(
      401,
    );
    expect((await socialLinks.link({ ticket: t, secret, ...signed }, store, ENV))[0]).toBe(200);
  });
});
