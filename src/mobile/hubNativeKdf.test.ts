/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phones (Capacitor), the last known password lockout before 5.2.56 (independent review, 13 Nov 2026).
 *
 * A phone writes every storage.local key as its own Keychain / Keystore item, so a write can throw WITHOUT the app
 * dying (full disk, a Keychain error) with only some of its keys landed. The hub then settles its copy back to what
 * it last saved. Phones did not re-read the key material, so a password change retried in the same session worked
 * from that copy (old keys, old salt) and wrote a new note {S0, S2} over the one naming the salt the stored keys were
 * now under (S1). A second half-write (only its salt landing) left keys under S1, salt S2, note {S0, S2}: no password
 * opened the wallet, only the 12 words.
 *
 * Here the whole path runs as on a phone: ChromeStorageService → chrome shim → the real Hub → a fake native backend
 * that writes key by key and can fail some keys of a write while the others land.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createChromeShim } from './chromeShim';
import { Hub, type LocalBackend } from './hub';
import { WEB_FRESH_KEYS, isFreshWebKey } from './webTab';
import { derivePassKey } from '../services/passKey';
import { decrypt, encrypt } from '../utils/crypto';
import { CHROME_STORAGE_OBJECT_VERSION } from '../utils/constants';

const P = 'chrome.storage.local:';
const PW = 'correct horse battery staple';
const NEW_PW = 'a brand new password';
const S0 = '00112233445566778899aabbccddeeff'; // legacy salt, as most phones still have before a change
const plainA = JSON.stringify({ mnemonic: 'a b c', walletWif: 'test-a' });
const plainB = JSON.stringify({ mnemonic: 'd e f', walletWif: 'test-b' });
const TIMEOUT = 90_000; // PBKDF2 600k several times per test, on a loaded machine

// Bun shares globals across test files (another file may leave sessionStorage defined but undefined): always install
// this file's own stubs, and put back whatever was there afterwards.
const g = globalThis as any;
const prevChrome = g.chrome;
const prevSession = Object.getOwnPropertyDescriptor(g, 'sessionStorage');
beforeAll(() => {
  Object.defineProperty(g, 'sessionStorage', {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  g.chrome = prevChrome;
  if (prevSession) Object.defineProperty(g, 'sessionStorage', prevSession);
  else delete g.sessionStorage;
});

const { ChromeStorageService, UNFINISHED_PASSWORD_CHANGE } = await import('../services/ChromeStorage.service');

/** The phone's secure store: one item per key; a write fails only the keys `failing` names, the rest land. */
const phoneDisk = async () => {
  const k0 = await derivePassKey(PW, S0, undefined);
  const items = new Map<string, string>();
  const put = (k: string, v: unknown) => items.set(P + k, JSON.stringify(v));
  put('version', CHROME_STORAGE_OBJECT_VERSION);
  put('deviceId', 'test-device');
  put('selectedAccount', '1A');
  put('salt', S0);
  put('accounts', {
    '1A': { addresses: { identityAddress: '1A' }, encryptedKeys: await encrypt(plainA, k0) },
    '1B': { addresses: { identityAddress: '1B' }, encryptedKeys: await encrypt(plainB, k0) },
  });
  let failing: ((key: string) => boolean) | undefined;
  const stats = { loads: 0, applies: 0 };
  const backend: LocalBackend = {
    load: async () => {
      stats.loads++;
      return Object.fromEntries(items);
    },
    // As nativeLocalBackend.apply on a phone: every key its own secure write, in parallel; one failing never stops
    // the others, and the batch still rejects.
    apply: async (sets, removes) => {
      stats.applies++;
      await Promise.all([
        ...Object.entries(sets).map(async ([k, v]) => {
          if (failing?.(k.slice(P.length))) throw new Error('Secure write failed (-34018)');
          items.set(k, v);
        }),
        ...removes.map(async (k) => void items.delete(k)),
      ]);
    },
    loadKeys: async (keys) => Object.fromEntries(keys.map((k) => [k, items.get(k) ?? null])),
  };
  const read = (k: string) => (items.has(P + k) ? JSON.parse(items.get(P + k)!) : undefined);
  return { items, backend, stats, read, failOnly: (f?: (key: string) => boolean) => (failing = f) };
};

/** One app start: a hub over the disk (fresh key reads as main.ts sets them on a phone, or as before), its page. */
const startApp = async (backend: LocalBackend, fresh: boolean) => {
  const hub = new Hub(async () => undefined, backend, {
    persistSession: true,
    freshLocalKeys: fresh ? isFreshWebKey : undefined,
    freshKeyNames: fresh ? [...WEB_FRESH_KEYS] : undefined,
  });
  const { chrome, receive } = createChromeShim({
    post: (json) => void hub.handle('page', JSON.parse(json)),
    parse: (json) => JSON.parse(json),
    rootUrl: 'capacitor://localhost/',
    version: 'test',
    timers: { setInterval: () => 0, setTimeout: () => 0, clearInterval: () => undefined },
  });
  hub.register('page', { sender: { id: 'x', url: 'capacitor://localhost/', origin: 'o' }, post: receive });
  g.chrome = chrome;
  const svc = new ChromeStorageService();
  await svc.clearPassKey(); // the module-level key cache: a new app start has none
  await svc.getAndSetStorage();
  return { hub, svc };
};

/** Any password opens the stored keys after a restart, and both accounts' keys come back intact. */
const opensAfterRestart = async (disk: Awaited<ReturnType<typeof phoneDisk>>, fresh: boolean) => {
  for (const password of [PW, NEW_PW]) {
    disk.failOnly(undefined);
    const { svc } = await startApp(disk.backend, fresh);
    if (!(await svc.verifyPassword(password))) continue;
    const key = (await svc.getPassKey())!;
    const accounts = disk.read('accounts');
    expect(await decrypt(accounts['1A'].encryptedKeys, key)).toBe(plainA);
    expect(await decrypt(accounts['1B'].encryptedKeys, key)).toBe(plainB);
    return password;
  }
  return undefined;
};

const snapshot = (items: Map<string, string>) => Object.fromEntries(items);

describe('phones: a password change that fails partway, retried in the same session', () => {
  test(
    "reviewer's case: keys landed, salt didn't; the retry is refused with nothing written; the new password opens",
    async () => {
      const disk = await phoneDisk();
      const { svc } = await startApp(disk.backend, true);
      expect(await svc.verifyPassword(PW)).toBe(true);

      // Attempt 1: the note lands, then the swap's salt write fails (no kill): new keys beside the old salt.
      disk.failOnly((k) => k === 'salt');
      await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toBeDefined();
      const s1 = disk.read('kdfPending').salt as string;
      expect(disk.read('salt')).toBe(S0);
      expect(disk.read('kdfPending')).toEqual({ prevSalt: S0, salt: s1 });
      const k1 = await derivePassKey(NEW_PW, s1, undefined);
      expect(await decrypt(disk.read('accounts')['1A'].encryptedKeys, k1)).toBe(plainA);

      // Attempt 2, same session, whatever the disk does: refused before any write, with a message the user can act on.
      disk.failOnly((k) => k === 'accounts');
      const before = snapshot(disk.items);
      const applies = disk.stats.applies;
      await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toThrow(UNFINISHED_PASSWORD_CHANGE);
      expect(disk.stats.applies).toBe(applies);
      expect(snapshot(disk.items)).toEqual(before);

      // Same session, Lock then unlock with the new password: the repair finishes the change.
      disk.failOnly(undefined);
      await svc.clearPassKey();
      expect(await svc.verifyPassword(NEW_PW)).toBe(true);
      expect(disk.read('salt')).toBe(s1);
      expect(disk.read('kdfPending')).toBeNull();

      // And after a restart: the new password opens, the old one doesn't.
      const { svc: again } = await startApp(disk.backend, true);
      expect(await again.verifyPassword(PW)).toBe(false);
      expect(await again.verifyPassword(NEW_PW)).toBe(true);
      expect(await decrypt(disk.read('accounts')['1B'].encryptedKeys, await again.getPassKey())).toBe(plainB);
    },
    TIMEOUT,
  );

  test(
    "reviewer's case, restart before the unlock: the next unlock repairs from the original note",
    async () => {
      const disk = await phoneDisk();
      const { svc } = await startApp(disk.backend, true);
      expect(await svc.verifyPassword(PW)).toBe(true);
      disk.failOnly((k) => k === 'salt');
      await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toBeDefined();
      const note = disk.read('kdfPending');
      disk.failOnly((k) => k === 'accounts');
      await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toThrow(UNFINISHED_PASSWORD_CHANGE);
      expect(disk.read('kdfPending')).toEqual(note); // the original note, untouched
      expect(await opensAfterRestart(disk, true)).toBe(NEW_PW);
      expect(disk.read('salt')).toBe(note.salt);
    },
    TIMEOUT,
  );

  // Every way round, with and without fresh reads: two half-writes in one session never leave keys no password opens.
  // Without fresh reads (phones before this fix) the carried-forward note (kdfNote) is what saves it; with fresh reads
  // but no carried-forward note, "salt landed, then salt landed again" lost the old salt instead.
  for (const fresh of [true, false])
    for (const first of ['salt', 'accounts'] as const)
      for (const second of ['salt', 'accounts'] as const)
        test(
          `fresh=${fresh}: first write lost its ${first}, the retry lost its ${second}: a password still opens`,
          async () => {
            const disk = await phoneDisk();
            const { svc } = await startApp(disk.backend, fresh);
            expect(await svc.verifyPassword(PW)).toBe(true);
            disk.failOnly((k) => k === first);
            await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toBeDefined();
            disk.failOnly((k) => k === second);
            await svc.changePassword(NEW_PW, { currentPassword: PW }).catch(() => undefined);
            expect(await opensAfterRestart(disk, fresh)).toBeDefined();
          },
          TIMEOUT,
        );
});

describe('hub: fresh key reads on a phone', () => {
  test('get(null) re-reads only the listed key material, never the whole secure store', async () => {
    const disk = await phoneDisk();
    const { hub, svc } = await startApp(disk.backend, true);
    const loads = disk.stats.loads;
    for (let i = 0; i < 5; i++) await svc.update({ lastActiveTime: i } as any); // each write ends in a get(null)
    await hub.flush();
    expect(disk.stats.loads).toBe(loads);
  });

  test('a key the hub copy lost (a write that failed but landed) is read back as stored', async () => {
    const disk = await phoneDisk();
    const { svc } = await startApp(disk.backend, true);
    disk.items.set(P + 'kdfPending', JSON.stringify({ prevSalt: S0, salt: 'landed' }));
    disk.items.set(P + 'salt', JSON.stringify('landed'));
    const all = await svc.getAndSetStorage();
    expect(all?.salt).toBe('landed');
    expect(all?.kdfPending).toEqual({ prevSalt: S0, salt: 'landed' });
  });

  test('main.ts: phones read the key material fresh, listed (no whole-store reads); Desktop has no loadKeys', () => {
    const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('const nativeApp = Capacitor.isNativePlatform();');
    expect(src).toContain(': nativeApp ? isFreshWebKey : undefined,');
    expect(src).toContain('freshKeyNames: !webTab && nativeApp ? [...WEB_FRESH_KEYS] : undefined,');
    const desktop = readFileSync(new URL('./desktop/storage.ts', import.meta.url), 'utf8');
    expect(desktop).not.toContain('loadKeys');
  });
});
