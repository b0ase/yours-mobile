/**
 * Review of 85ef98d8: the server's reply to the owner's Save must not become the owner card. A server that answers
 * bphone-put with other terms (token B at 999/min) would otherwise make the next settings open re-sign those terms
 * quietly. The owner card is what the owner submitted, so the served card differs and the wallet asks.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';

const realConfig = { ...(await import('../names/config')) };
mock.module('../names/config', () => ({
  ...realConfig,
  BWALLET_PAYMAIL_DOMAIN: 'bwalletx.com',
  BWALLET_PAYMAIL_API: 'https://pay.test',
}));
afterAll(() => {
  mock.module('../names/config', () => realConfig);
});

const { loadMyProfile, readOwnerCard, saveMyProfile } = await import('./bphone');
const { planPayoutResign, signPayee } = await import('./payee');

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
} as Storage;

const keys = new ProtoWallet(PrivateKey.fromRandom());
const wallet = {
  getPublicKey: () => keys.getPublicKey({ identityKey: true }),
  createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => keys.createSignature(a),
};
const OWN = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const A = 'a'.repeat(64) + '_0';
const B = 'b'.repeat(64) + '_0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const card = (id: string, amount: number): any => ({
  amount,
  per: 'minute',
  asset: { kind: 'bsv21', id, sym: 'T', dec: 0, address: OWN },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const profile = (rate: unknown): any => ({
  v: 1,
  rate,
  listing: { listed: false, title: '', about: '', category: 'other', hours: [], timezone: 'UTC', booking: true },
  updatedAt: 1,
});

let served = profile(null);
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
// A server that stores other terms than the owner sent.
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = String(u);
  if (url.includes('bphone-put')) {
    served = profile(card(B, 999));
    return new Response(JSON.stringify({ profile: served }), { status: 200 });
  }
  if (url.includes('bphone-get')) return new Response(JSON.stringify({ key: 'k', profile: served }), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const f = (u: string, i?: RequestInit) => fetch(u, i);

test("the owner card is the card the owner sent, so the server's other terms are asked about, not signed quietly", async () => {
  const key = (await wallet.getPublicKey()).publicKey.toLowerCase();
  const a = card(A, 1);
  const proof = await signPayee(wallet, a.asset, OWN);
  await saveMyProfile(f, wallet, profile({ ...a, asset: { ...a.asset, proof } }), { ownerSaved: true });
  expect(readOwnerCard(key)?.rate?.asset).toMatchObject({ id: A });
  const p = await loadMyProfile(f, key);
  expect(p.rate?.asset).toMatchObject({ id: B });
  expect(await planPayoutResign(key, p.rate, OWN)).toBe('ask');
});
