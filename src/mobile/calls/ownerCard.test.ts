/**
 * Re-review of b-Aware row 114 (14 Nov 2026): bPhone settings compared the server's card with the profile cache, but
 * every loadMyProfile (CallsList on mount, bMail) overwrites that cache with the server's copy, so the comparison was
 * the server copy against itself and the quiet payout re-sign signed whatever the server served. The quiet re-sign
 * now compares with the card the owner last saved on this device (readOwnerCard), which nothing else writes.
 * Real bphone.ts over a fake paymail server (fetch) and an in-memory localStorage.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { keepGlobals } from '../../testing/stubGlobals';
import type { BPhoneProfile, RateCard } from './rateCard';

keepGlobals('localStorage', 'fetch');
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

const ls = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
};

const keys = new ProtoWallet(PrivateKey.fromRandom());
const wallet = {
  getPublicKey: () => keys.getPublicKey({ identityKey: true }),
  createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => keys.createSignature(a),
};
const OWN = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const TOKEN_A = `${'a'.repeat(64)}_0`;
const TOKEN_B = `${'b'.repeat(64)}_0`;
const card = (id: string, amount = 1): RateCard => ({
  amount,
  per: 'minute',
  asset: { kind: 'bsv21', id, sym: 'T', dec: 0, address: OWN },
});
const profile = (rate: RateCard | null): BPhoneProfile => ({
  v: 1,
  rate,
  listing: { listed: false, title: '', about: '', category: 'other', hours: [], timezone: 'UTC', booking: true },
  updatedAt: 1,
});

/** The paymail server: bphone-put echoes what was signed; bphone-get answers `served`. */
let served: BPhoneProfile = profile(null);
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u);
  if (url.includes('bphone-put')) {
    const body = JSON.parse(String(init?.body)) as { fields: { profile: string } };
    served = { ...(JSON.parse(body.fields.profile) as BPhoneProfile), updatedAt: 2 };
    return new Response(JSON.stringify({ profile: served }), { status: 200 });
  }
  if (url.includes('bphone-get')) return new Response(JSON.stringify({ key: 'k', profile: served }), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const f = (u: string, i?: RequestInit) => fetch(u, i);
const me = async () => (await wallet.getPublicKey()).publicKey.toLowerCase();

describe("bPhone settings: the quiet payout re-sign trusts only the owner's own saved card", () => {
  beforeEach(() => {
    ls.clear();
    served = profile(null);
  });

  test('the server swaps the token, a load runs (CallsList), settings open: the owner is asked, nothing signed', async () => {
    const key = await me();
    // The owner saved token A from settings (signed for their own address).
    const a = card(TOKEN_A);
    const proof = await signPayee(wallet, a.asset as never, OWN);
    await saveMyProfile(f, wallet, profile({ ...a, asset: { ...a.asset, proof } as RateCard['asset'] }), {
      ownerSaved: true,
    });
    expect(readOwnerCard(key)?.rate?.asset).toMatchObject({ kind: 'bsv21', id: TOKEN_A });
    // The server now serves token B, unsigned. CallsList's load overwrites the profile cache with it.
    served = profile(card(TOKEN_B));
    await loadMyProfile(f, key);
    // Settings open: load again, then plan the re-sign.
    const p = await loadMyProfile(f, key);
    expect(p.rate?.asset).toMatchObject({ id: TOKEN_B });
    expect(await planPayoutResign(key, p.rate, OWN)).toBe('ask');
    // The owner's card is still token A: loads never touch it.
    expect(readOwnerCard(key)?.rate?.asset).toMatchObject({ id: TOKEN_A });
  });

  test('a changed price is asked too; the same card, unsigned, is re-signed quietly', async () => {
    const key = await me();
    await saveMyProfile(f, wallet, profile(card(TOKEN_A, 1)), { ownerSaved: true });
    served = profile(card(TOKEN_A, 50));
    expect(await planPayoutResign(key, (await loadMyProfile(f, key)).rate, OWN)).toBe('ask');
    served = profile(card(TOKEN_A, 1));
    expect(await planPayoutResign(key, (await loadMyProfile(f, key)).rate, OWN)).toBe('quiet');
  });

  test('no card saved by the owner on this device: ask', async () => {
    const key = await me();
    served = profile(card(TOKEN_A));
    expect(readOwnerCard(key)).toBeUndefined();
    expect(await planPayoutResign(key, (await loadMyProfile(f, key)).rate, OWN)).toBe('ask');
  });

  test('a save without ownerSaved (bMail price, a quiet re-sign) never becomes the owner card', async () => {
    const key = await me();
    await saveMyProfile(f, wallet, profile(card(TOKEN_B)));
    expect(readOwnerCard(key)).toBeUndefined();
  });

  test("only settings Save and the prompt's Yes mark a save as the owner's", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const settings = read('./BPhoneSettings.tsx');
    expect(settings).toContain('await saveMyProfile(f, apiContext.wallet, next, { ownerSaved: true })');
    expect(settings).toContain('await signAndSave(ask.base, ask.own, true)');
    expect(settings.match(/ownerSaved: true/g)?.length).toBe(1);
    for (const p of ['../bmail/useBMail.ts', './CallsList.tsx']) expect(read(p)).not.toContain('ownerSaved');
  });
});
