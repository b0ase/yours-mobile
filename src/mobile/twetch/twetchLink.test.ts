import { describe, expect, test } from 'bun:test';
import { Mnemonic, PrivateKey } from '@bsv/sdk';
import { getKeys } from '../../utils/keys';
import { DEFAULT_TWETCH_WALLET_PATH } from '../../utils/constants';
import {
  TwetchKeyMismatch,
  lookupTwetchAccount,
  makeTwetchStore,
  twetchKeyFrom,
  verifyTwetchKey,
  type TwetchLink,
} from './twetchLink';

const words = () => new Mnemonic().fromRandom().toString();

/** Twetch API stand-in: a user whose publicKey is `pk` (GETs only; any other request fails the test). */
const twetchApi = (pk: string, id = 19, name = 'dagashi', userPk = pk) => {
  const seen: { url: string; method: string }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? 'GET' });
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('write call in a test');
    if (url === `https://api.twetch.com/v1/auth/user-by-pubkey/${pk.toLowerCase()}`)
      return new Response(JSON.stringify({ userId: id }));
    if (url.startsWith('https://api.twetch.com/v1/auth/user-by-pubkey/'))
      return new Response(JSON.stringify({ error: 'no account for that seed' }), { status: 404 });
    if (url === `https://api.twetch.com/v1/users/${id}`)
      return new Response(JSON.stringify({ id, name, publicKey: userPk }));
    return new Response('', { status: 404 });
  };
  return { f, seen };
};

describe('the Twetch key', () => {
  test('12 words → m/0/0, the same key a "Restore from Twetch" account uses as its wallet key', () => {
    const w = words();
    expect(DEFAULT_TWETCH_WALLET_PATH).toBe('m/0/0');
    expect(twetchKeyFrom(w).toWif()).toBe(getKeys(w, DEFAULT_TWETCH_WALLET_PATH).walletWif);
    expect(twetchKeyFrom(`  ${w.toUpperCase().replace(/ /g, '   ')} `).toWif()).toBe(
      getKeys(w, DEFAULT_TWETCH_WALLET_PATH).walletWif,
    );
  });
  test('a WIF is taken as is; junk is refused', () => {
    const k = PrivateKey.fromRandom();
    expect(twetchKeyFrom(k.toWif()).toWif()).toBe(k.toWif());
    expect(() => twetchKeyFrom('')).toThrow();
    expect(() => twetchKeyFrom('notakey')).toThrow();
  });
});

describe('checking against Twetch (mocked, GET only)', () => {
  test('links when user-by-pubkey names a user whose publicKey is the derived key', async () => {
    const key = twetchKeyFrom(words());
    const pk = key.toPublicKey().toString();
    const api = twetchApi(pk);
    const link = (await verifyTwetchKey(key, api.f)) as TwetchLink;
    expect(link).toMatchObject({
      publicKey: pk,
      address: key.toPublicKey().toAddress(),
      userId: '19',
      name: 'dagashi',
    });
    expect(api.seen.map((s) => s.method)).toEqual(['GET', 'GET']);
  });
  test('no Twetch account for the key', async () => {
    const key = PrivateKey.fromRandom();
    const api = twetchApi(PrivateKey.fromRandom().toPublicKey().toString());
    expect(await verifyTwetchKey(key, api.f)).toBe("These words aren't a Twetch account.");
  });
  test("the account's publicKey is a different key", async () => {
    const key = PrivateKey.fromRandom();
    const pk = key.toPublicKey().toString();
    const api = twetchApi(pk, 19, 'x', PrivateKey.fromRandom().toPublicKey().toString());
    expect(await lookupTwetchAccount(pk, api.f)).toBe("This key isn't the signing key of that Twetch account.");
  });
  test('Twetch down: thrown, not "no account"', async () => {
    const f = async () => new Response('', { status: 503 });
    await expect(lookupTwetchAccount('02' + 'a'.repeat(64), f)).rejects.toThrow(/Couldn't reach Twetch/);
  });
});

describe('storage', () => {
  // Fake crypto: reversible, tagged with the pass key, so a wrong key fails like the real one.
  const crypto = {
    encrypt: async (p: string, k: string) => `${k}:${Buffer.from(p).toString('base64')}`,
    decrypt: async (d: string, k: string) => {
      if (!d.startsWith(`${k}:`)) throw new Error('bad key');
      return Buffer.from(d.slice(k.length + 1), 'base64').toString();
    },
  };
  const setup = async () => {
    const own = { walletWif: 'own-wallet', mnemonic: 'own words' };
    let account: Record<string, unknown> = {
      addresses: { identityAddress: '1Me' },
      encryptedKeys: await crypto.encrypt(JSON.stringify(own), 'pk'),
      settings: { customFeeRate: 100 },
    };
    const storage = {
      getCurrentAccountObject: () => ({ account: account as never }),
      getPassKey: async () => 'pk',
      updateNested: async (_k: 'accounts', u: Record<string, unknown>) => {
        account = u['1Me'] as Record<string, unknown>;
      },
      get: async () => ({}),
    };
    return { store: makeTwetchStore(storage, crypto), acct: () => account };
  };

  test('the key goes into the encrypted key blob; settings hold public facts only', async () => {
    const { store, acct } = await setup();
    const key = PrivateKey.fromRandom();
    const link: TwetchLink = {
      publicKey: key.toPublicKey().toString(),
      address: key.toPublicKey().toAddress(),
      userId: '19',
      name: 'dagashi',
      linkedAt: 1,
    };
    await store.save(link, key);
    const a = acct();
    expect(JSON.stringify(a.settings)).not.toContain(key.toWif());
    expect((a.settings as Record<string, unknown>).customFeeRate).toBe(100);
    const keys = JSON.parse(await crypto.decrypt(a.encryptedKeys as string, 'pk'));
    expect(keys).toEqual({ walletWif: 'own-wallet', mnemonic: 'own words', twetchWif: key.toWif() });
    expect((await store.key()).toWif()).toBe(key.toWif());
    expect(await store.accountWords()).toBe('own words');
    await store.addLoginSite('https://bchatx.com');
    await store.addLoginSite('https://bchatx.com');
    expect(store.link()?.loginSites).toEqual(['https://bchatx.com']);
    await store.forget();
    expect(store.link()).toBeUndefined();
    expect(JSON.parse(await crypto.decrypt(acct().encryptedKeys as string, 'pk'))).toEqual({
      walletWif: 'own-wallet',
      mnemonic: 'own words',
    });
  });
  test('save refuses a key that is not the linked account key', async () => {
    const { store } = await setup();
    const key = PrivateKey.fromRandom();
    const other = PrivateKey.fromRandom();
    await expect(
      store.save({ publicKey: other.toPublicKey().toString(), address: '', userId: '1', name: '', linkedAt: 1 }, key),
    ).rejects.toThrow(TwetchKeyMismatch);
  });
});
