import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
// The server module (CommonJS, site/lib): the healed register request must verify there.
import server from '../../../site/lib/paymail.js';
import { checkOrdProof } from './names';
import { proveMyOrdAddress, signOrdProof } from './paymail';

/**
 * b-Aware 102/250: payers now refuse a host-served ord address with no owner signature. Names registered before
 * the proof existed (or from an older app) have none, so the owner's own wallet signs it on the next name sync,
 * the same self-heal as bindMyNames. It only ever signs the wallet's OWN ord address, never what the host serves.
 */
const AT = { api: 'https://pay.test', domain: 'bwalletx.test' };
const OWNER = PrivateKey.fromRandom();
const KEY = OWNER.toPublicKey().toString();
const MY_ORD = OWNER.toAddress();
const SOMEONE_ELSE = PrivateKey.fromRandom().toAddress();

const host = (ord: Record<string, Record<string, unknown> | null>) => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.startsWith(`${AT.api}/api/paymail/lookup?key=`))
      return json({
        paymail: `alice@${AT.domain}`,
        names: Object.keys(ord).map((a, i) => ({ paymail: `${a}@${AT.domain}`, kind: 'plain', main: i === 0 })),
      });
    const m = url.match(/\/api\/paymail\/ord\/([^@]+)@/);
    if (m) return ord[m[1]] ? json(ord[m[1]]) : json({ error: 'no-ord-address' }, 404);
    if (url === `${AT.api}/api/paymail/register` && init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ paymail: 'ok' });
    }
    return json({}, 404);
  };
  return { f, posts };
};

describe("b-Aware 102/250: the owner's wallet signs its own unsigned ord address", () => {
  test('an unsigned ord address that is ours: re-registered with a proof the payer accepts', async () => {
    const { f, posts } = host({ alice: { address: MY_ORD } });
    expect(await proveMyOrdAddress(f, new ProtoWallet(OWNER), MY_ORD, AT)).toBe(1);
    expect(posts).toHaveLength(1);
    const body = posts[0].body as { fields: Record<string, string>; ordProof: unknown };
    // A profile update of their own name: alias + ord address only (no name, no fee), signed by the owner.
    expect(body.fields).toEqual({ alias: 'alice', ordAddress: MY_ORD });
    expect(await server.verifySigned(body, 'register')).toBeNull();
    expect(await checkOrdProof(KEY, MY_ORD, body.ordProof)).toBe('ok');
  });

  test('never signs an address the host serves that is not ours, and leaves a valid proof alone', async () => {
    const ordProof = await signOrdProof(new ProtoWallet(OWNER), MY_ORD);
    const { f, posts } = host({
      alice: { address: SOMEONE_ELSE },
      bob: { address: MY_ORD, ordProof },
      carol: null,
    });
    expect(await proveMyOrdAddress(f, new ProtoWallet(OWNER), MY_ORD, AT)).toBe(0);
    expect(posts).toHaveLength(0);
  });

  test('a proof that does not verify for our key is replaced', async () => {
    const forged = await signOrdProof(new ProtoWallet(PrivateKey.fromRandom()), MY_ORD);
    const { f, posts } = host({ alice: { address: MY_ORD, ordProof: forged } });
    expect(await proveMyOrdAddress(f, new ProtoWallet(OWNER), MY_ORD, AT)).toBe(1);
    expect(await checkOrdProof(KEY, MY_ORD, posts[0].body.ordProof)).toBe('ok');
  });

  test('no ord address on the account, or paymail off: nothing is fetched', async () => {
    let calls = 0;
    const f = async () => (calls++, new Response('{}'));
    expect(await proveMyOrdAddress(f, new ProtoWallet(OWNER), '', AT)).toBe(0);
    expect(await proveMyOrdAddress(f, new ProtoWallet(OWNER), MY_ORD, { api: '', domain: '' })).toBe(0);
    expect(calls).toBe(0);
  });
});
