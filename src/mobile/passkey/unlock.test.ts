import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LOCAL_KEY,
  UNLOCK_KEY,
  b64url,
  keystorePasswordFromPrf,
  loadLocalBackups,
  loadPasskeyUnlock,
  removePasskey,
  saveLocalBackup,
  savePasskeyUnlock,
  sealPassword,
  sealSeed,
  unlockPasswordFromPrf,
} from './seedBackup';

const prfA = new Uint8Array(32).fill(3);
const prfB = new Uint8Array(32).fill(4);
const ids = { rpId: 'bwalletx.com', credentialId: b64url(new Uint8Array([9, 9, 9, 9])) };

const memStore = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

describe('passkey unlock for an existing password wallet', () => {
  test('sealed password opens with the same passkey only', async () => {
    const u = await sealPassword('my old password', prfA, ids);
    expect(JSON.stringify(u)).not.toContain('my old password');
    expect(await unlockPasswordFromPrf(u, prfA)).toBe('my old password');
    await expect(unlockPasswordFromPrf(u, prfB)).rejects.toThrow("doesn't unlock");
    await expect(unlockPasswordFromPrf({ ...u, credentialId: 'other' }, prfA)).rejects.toThrow();
  });

  test('a passkey-made wallet (no sealed password) derives its password', async () => {
    expect(await unlockPasswordFromPrf(ids, prfA)).toBe(await keystorePasswordFromPrf(prfA));
  });

  test('change password: re-sealing makes the new password come back, the old one is gone', async () => {
    const before = await sealPassword('old password 1', prfA, ids);
    const after = await sealPassword('new password 2', prfA, before);
    expect(await unlockPasswordFromPrf(after, prfA)).toBe('new password 2');
    expect(after.sealed!.ct).not.toBe(before.sealed!.ct);
  });

  test('remove passkey forgets the unlock record and only that passkey’s backups', async () => {
    const s = memStore();
    savePasskeyUnlock(await sealPassword('pw-12345678', prfA, ids), s);
    const mine = await sealSeed('one two three', prfA, { ...ids, account: '1abc' });
    const other = await sealSeed('four five six', prfB, { rpId: ids.rpId, credentialId: 'zzzz', account: '1def' });
    saveLocalBackup(mine, s);
    saveLocalBackup(other, s);
    expect(loadPasskeyUnlock(s)?.credentialId).toBe(ids.credentialId);
    removePasskey(s);
    expect(s.m.has(UNLOCK_KEY)).toBe(false);
    expect(loadLocalBackups(s).map((b) => b.account)).toEqual(['1def']);
    expect(JSON.parse(s.m.get(LOCAL_KEY)!)).toHaveLength(1);
  });

  test('blobs remember which account they belong to', async () => {
    const b = await sealSeed('one two three', prfA, { ...ids, account: '1abc' });
    expect(b.account).toBe('1abc');
  });
});

describe('HandCash web return (identity only)', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage, location: g.location };
  afterAll(() => Object.assign(globalThis, saved));
  beforeEach(() => {
    const ls = memStore();
    const ss = memStore();
    Object.assign(globalThis, {
      localStorage: ls,
      sessionStorage: ss,
      location: { origin: 'https://web.bwalletx.com', pathname: '/' },
    });
  });

  test('keeps the verified handle, drops the token, sends the verifier and web redirect', async () => {
    const { receiveHandCashWeb, handcashWebHandle } = await import('./handcashWeb');
    sessionStorage.setItem('bwx:handcash-web-verifier', 'v'.repeat(43));
    let sent: Record<string, string> = {};
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ handle: '$alice', auth_token: 'SECRET' }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = await receiveHandCashWeb('https://web.bwalletx.com/auth/handcash?grant=g1', fakeFetch);
    expect(h).toBe('alice');
    expect(handcashWebHandle()).toBe('alice');
    expect(sent).toEqual({
      grant: 'g1',
      code_verifier: 'v'.repeat(43),
      redirect_uri: 'https://web.bwalletx.com/auth/handcash',
    });
    expect(JSON.stringify([...(localStorage as unknown as { m: Map<string, string> }).m])).not.toContain('SECRET');
  });

  test('no verifier = expired, nothing stored', async () => {
    const { receiveHandCashWeb, handcashWebError } = await import('./handcashWeb');
    const h = await receiveHandCashWeb(
      'https://web.bwalletx.com/auth/handcash?grant=g1',
      (async () => new Response('{}')) as unknown as typeof fetch,
    );
    expect(h).toBe('');
    expect(handcashWebError()).toContain('expired');
  });
});
