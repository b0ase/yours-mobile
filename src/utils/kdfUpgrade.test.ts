/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import CryptoJS from 'crypto-js';
import {
  KDF_ITERATIONS,
  LEGACY_KDF_ITERATIONS,
  decrypt,
  deriveKey,
  encrypt,
  generateWalletSalt,
  isLegacySalt,
  pbkdf2Hex,
  saltIterations,
} from './crypto';
import { consoleGate } from '../testing/captureConsole';

// upgradeKdf defers (returns false, changes nothing) on any error and warns once with the error's name only (never
// its message: no key material in logs). The tests that make it fail declare that line; anything else fails.
const gate = consoleGate(['error', 'warn']);

const PW = 'correct horse battery staple';
const LEGACY_SALT = '00112233445566778899aabbccddeeff';

/**
 * PBKDF2 at 600k rounds is CPU-heavy, and a test here runs several. On a busy machine one ran past bun's default 5 s
 * (full-suite loop, 5 Nov 2026: 5891 ms), and its abandoned work kept writing into the next test's store (that test
 * then failed too). So these tests get a time limit that load can't reach, and each test first waits for the one
 * before it to finish (kdfTest / beforeEach), so a store is never shared.
 */
const KDF_TEST_TIMEOUT_MS = 60_000;
let inFlight: Promise<unknown> | undefined;
const kdfTest = (name: string, fn: () => Promise<unknown>) => test(name, () => (inFlight = fn()), KDF_TEST_TIMEOUT_MS);

describe('password key derivation', () => {
  kdfTest('legacy 100k salt: unchanged golden value, and Web Crypto agrees with crypto-js', async () => {
    const k = await deriveKey(PW, LEGACY_SALT);
    expect(k).toBe('7f795f6b204d36c5d1749d64fd20167c1273cf892a6bb6969b2fd83700308801');
    expect(await pbkdf2Hex(PW, LEGACY_SALT, LEGACY_KDF_ITERATIONS)).toBe(k);
    const cj = CryptoJS.PBKDF2(PW, LEGACY_SALT, { keySize: 8, iterations: 1000, hasher: CryptoJS.algo.SHA256 });
    expect(await pbkdf2Hex(PW, LEGACY_SALT, 1000)).toBe(cj.toString(CryptoJS.enc.Hex));
  });

  kdfTest('new salts name 600k and round-trip a keystore entry', async () => {
    const salt = generateWalletSalt();
    expect(salt.startsWith(`pbkdf2:${KDF_ITERATIONS}:`)).toBe(true);
    expect(saltIterations(salt)).toBe(KDF_ITERATIONS);
    expect(isLegacySalt(salt)).toBe(false);
    const key = await deriveKey(PW, salt);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(await pbkdf2Hex(PW, salt.split(':')[2], KDF_ITERATIONS));
    expect(key).not.toBe(await deriveKey(PW, LEGACY_SALT));
    expect(await decrypt(await encrypt('{"k":1}', key), key)).toBe('{"k":1}');
    expect(await deriveKey('wrong password', salt)).not.toBe(key);
  });

  kdfTest('salt parsing: legacy, tagged, and refusals', async () => {
    expect(saltIterations(LEGACY_SALT)).toBe(LEGACY_KDF_ITERATIONS);
    expect(isLegacySalt(LEGACY_SALT)).toBe(true);
    expect(isLegacySalt(undefined)).toBe(false);
    expect(saltIterations('pbkdf2:600000:zz')).toBeNull();
    expect(saltIterations('pbkdf2:1000:00112233445566778899aabbccddeeff')).toBeNull();
    expect(saltIterations('pbkdf2:99999999:00112233445566778899aabbccddeeff')).toBeNull();
    expect(saltIterations('nope')).toBeNull();
    await expect(deriveKey(PW, 'pbkdf2:099999:00112233445566778899aabbccddeeff')).rejects.toThrow();
  });
});

// --- upgrade after unlock -----------------------------------------------------------------------------------------

type Store = Record<string, any>;
let local: Store;
let session: Store;
let failSet = false;
/**
 * The app killed in the middle of one multi-key write (phones: Capacitor writes each key as its own secure item):
 * only these keys of the next write that carries both `accounts` and `salt` land, then nothing else is written.
 */
let killMidWrite: 'salt-only' | 'accounts-only' | undefined;
/**
 * The app killed during the unlock's repair write, the worst way round: if one write carries both `salt` and
 * `kdfPending` (two secure items on phones), only the note's clearing lands, then nothing else is written.
 */
let killRepair = false;

const pick = (s: Store, keys: string | string[] | null) => {
  if (keys === null) return structuredClone(s);
  const out: Store = {};
  for (const k of typeof keys === 'string' ? [keys] : keys) if (k in s) out[k] = structuredClone(s[k]);
  return out;
};

// Bun shares globals across test files: put the real (or absent) chrome back afterwards.
const prevChrome = (globalThis as any).chrome;
afterAll(() => {
  (globalThis as any).chrome = prevChrome;
});

(globalThis as any).chrome = {
  runtime: { lastError: undefined },
  storage: {
    onChanged: { addListener: () => undefined },
    local: {
      get: (keys: any, cb: (r: Store) => void) => {
        (globalThis as any).chrome.runtime.lastError = undefined;
        cb(pick(local, keys));
      },
      set: (obj: Store, cb?: () => void) => {
        if (!failSet && killRepair && 'salt' in obj && 'kdfPending' in obj && !('accounts' in obj)) {
          Object.assign(local, structuredClone({ kdfPending: obj.kdfPending }));
          killRepair = false;
          failSet = true;
        } else if (!failSet && killRepair && 'salt' in obj && !('accounts' in obj)) {
          // Salt written in its own write: the kill comes right after it, before the note is cleared.
          Object.assign(local, structuredClone(obj));
          killRepair = false;
          failSet = true;
        } else if (!failSet && killMidWrite && 'accounts' in obj && 'salt' in obj) {
          const part = killMidWrite === 'salt-only' ? { salt: obj.salt } : { accounts: obj.accounts };
          Object.assign(local, structuredClone(part));
          killMidWrite = undefined;
          failSet = true; // the process is gone: nothing after this lands
        } else if (!failSet) Object.assign(local, structuredClone(obj));
        (globalThis as any).chrome.runtime.lastError = failSet ? new Error('disk full') : undefined;
        cb?.();
      },
    },
    session: {
      get: async (keys: any) => pick(session, keys),
      set: async (obj: Store) => void Object.assign(session, obj),
      remove: async (keys: string[]) => keys.forEach((k) => delete session[k]),
    },
  },
};

const { ChromeStorageService } = await import('../services/ChromeStorage.service');

const plainA = JSON.stringify({ mnemonic: 'a b c', walletWif: 'wif-a' });
const plainB = JSON.stringify({ mnemonic: 'd e f', walletWif: 'wif-b' });

const service = async () => {
  const svc = new ChromeStorageService();
  (svc as any).getAndSetStorage = async () => undefined;
  await svc.setPassKey(await deriveKey(PW, LEGACY_SALT));
  return svc;
};

beforeEach(async () => {
  // A test that ran out of time is still running: let it finish before this test's store is set up.
  await inFlight?.catch(() => undefined);
  inFlight = undefined;
  failSet = false;
  killMidWrite = undefined;
  killRepair = false;
  session = {};
  const oldKey = await deriveKey(PW, LEGACY_SALT);
  local = {
    salt: LEGACY_SALT,
    accounts: {
      '1A': { addresses: { identityAddress: '1A' }, encryptedKeys: await encrypt(plainA, oldKey) },
      '1B': { addresses: { identityAddress: '1B' }, encryptedKeys: await encrypt(plainB, oldKey) },
      '1W': { addresses: { identityAddress: '1W' } },
    },
  };
}, KDF_TEST_TIMEOUT_MS);

describe('upgradeKdf: 100k wallet moves to 600k after a password unlock', () => {
  kdfTest('re-encrypts every account under the 600k key, swaps the session key, old key stops working', async () => {
    const svc = await service();
    const before = structuredClone(local.accounts);
    expect(await svc.upgradeKdf(PW)).toBe(true);
    expect(saltIterations(local.salt)).toBe(KDF_ITERATIONS);
    const newKey = await deriveKey(PW, local.salt);
    expect(await svc.getPassKey()).toBe(newKey);
    expect(session.passKey).toBe(newKey);
    expect(await decrypt(local.accounts['1A'].encryptedKeys, newKey)).toBe(plainA);
    expect(await decrypt(local.accounts['1B'].encryptedKeys, newKey)).toBe(plainB);
    expect(local.accounts['1W']).toEqual(before['1W']);
    await expect(decrypt(local.accounts['1A'].encryptedKeys, await deriveKey(PW, LEGACY_SALT))).rejects.toThrow();
    // Second unlock: nothing left to do.
    expect(await svc.upgradeKdf(PW)).toBe(false);
  });

  kdfTest('a wrong password changes nothing', async () => {
    const svc = await service();
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf('not the password')).toBe(false);
    expect(local).toEqual(snap);
    expect(session.passKey).toBe(await deriveKey(PW, LEGACY_SALT));
  });

  kdfTest('USB key security on: skipped, nothing changes', async () => {
    local.usbSecurity = { enabled: true };
    const svc = await service();
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf(PW)).toBe(false);
    expect(local).toEqual(snap);
  });

  kdfTest('a blob that will not open: nothing is written, the old wallet still opens', async () => {
    gate.expectLines('warn [ChromeStorageService] password key upgrade deferred: OperationError'); // AES-GCM refused it
    local.accounts['1B'].encryptedKeys = 'v2:' + '00'.repeat(40);
    const svc = await service();
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf(PW)).toBe(false);
    expect(local).toEqual(snap);
    expect(await decrypt(local.accounts['1A'].encryptedKeys, await deriveKey(PW, LEGACY_SALT))).toBe(plainA);
  });

  kdfTest('a failed write keeps the old key in the session (old data still opens)', async () => {
    gate.expectLines('warn [ChromeStorageService] password key upgrade deferred: Error'); // the 'disk full' write
    const svc = await service();
    failSet = true;
    const snap = structuredClone(local);
    expect(await svc.upgradeKdf(PW)).toBe(false);
    expect(local).toEqual(snap);
    expect(await svc.getPassKey()).toBe(await deriveKey(PW, LEGACY_SALT));
  });

  kdfTest('old AES-CBC keystore entries are carried over to the 600k key as AES-GCM', async () => {
    const oldKey = await deriveKey(PW, LEGACY_SALT);
    const salt = CryptoJS.lib.WordArray.random(16);
    const iv = CryptoJS.lib.WordArray.random(16);
    const k = CryptoJS.PBKDF2(oldKey, salt, { keySize: 8, iterations: 1000 });
    const ct = CryptoJS.AES.encrypt(plainB, k, { iv }).toString();
    local.accounts['1B'].encryptedKeys = salt.toString() + iv.toString() + ct;
    expect(await decrypt(local.accounts['1B'].encryptedKeys, oldKey)).toBe(plainB);
    const svc = await service();
    expect(await svc.upgradeKdf(PW)).toBe(true);
    expect(local.accounts['1B'].encryptedKeys.startsWith('v2:')).toBe(true);
    expect(await decrypt(local.accounts['1B'].encryptedKeys, await deriveKey(PW, local.salt))).toBe(plainB);
  });

  kdfTest(
    'killed between the two writes (phones store accounts and salt separately): unlock repairs the salt',
    async () => {
      local.selectedAccount = '1A';
      const svc = await service();
      expect(await svc.upgradeKdf(PW)).toBe(true);
      const newSalt = local.salt;
      // New blobs, old salt, recovery note still there.
      local.salt = LEGACY_SALT;
      local.kdfPending = { prevSalt: LEGACY_SALT, salt: newSalt };
      (svc as any).storage = local;
      expect(await svc.verifyPassword('wrong password')).toBe(false);
      expect(local.salt).toBe(LEGACY_SALT);
      expect(await svc.verifyPassword(PW)).toBe(true);
      expect(local.salt).toBe(newSalt);
      expect(local.kdfPending).toBeNull();
      expect(await svc.getPassKey()).toBe(await deriveKey(PW, newSalt));
    },
  );

  kdfTest(
    'killed the other way round (new salt, old blobs): unlock goes back to the old salt, upgrade retries',
    async () => {
      local.selectedAccount = '1A';
      const svc = await service();
      const pendingSalt = generateWalletSalt();
      local.salt = pendingSalt;
      local.kdfPending = { prevSalt: LEGACY_SALT, salt: pendingSalt };
      (svc as any).storage = local;
      expect(await svc.verifyPassword(PW)).toBe(true);
      expect(local.salt).toBe(LEGACY_SALT);
      expect(await svc.upgradeKdf(PW)).toBe(true);
      expect(await decrypt(local.accounts['1A'].encryptedKeys, await deriveKey(PW, local.salt))).toBe(plainA);
    },
  );

  test('the unlock screen runs it, only with the USB key off', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../components/UnlockWallet.tsx', import.meta.url), 'utf8');
    expect(src).toContain('if (!usbEnabled) await chromeStorageService.upgradeKdf(password)');
  });
});

describe('changePassword: a swap cut off halfway is repaired at the next unlock (kdfPending, as upgradeKdf)', () => {
  const NEW_PW = 'a brand new password';

  /** A fresh app start after the kill: storage as it was left, nothing in the session. */
  const restart = async () => {
    failSet = false;
    session = {};
    const svc = new ChromeStorageService();
    (svc as any).getAndSetStorage = async () => undefined;
    (svc as any).storage = local;
    return svc;
  };

  const unlocked = async (svc: any) => {
    const key = await svc.getPassKey();
    return decrypt(local.accounts['1A'].encryptedKeys, key);
  };

  kdfTest('a completed change: new password opens, old does not, the note is cleared', async () => {
    local.selectedAccount = '1A';
    const svc = await service();
    (svc as any).storage = local;
    await svc.changePassword(NEW_PW, { currentPassword: PW });
    expect(local.kdfPending).toBeNull();
    const again = await restart();
    expect(await again.verifyPassword(PW)).toBe(false);
    expect(await again.verifyPassword(NEW_PW)).toBe(true);
    expect(await unlocked(again)).toBe(plainA);
  });

  kdfTest('killed with the NEW salt beside the OLD keys: the old password opens and the salt goes back', async () => {
    local.selectedAccount = '1A';
    const svc = await service();
    (svc as any).storage = local;
    killMidWrite = 'salt-only';
    await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toThrow();
    expect(local.salt).not.toBe(LEGACY_SALT); // the half-write really happened
    expect(local.kdfPending).toEqual({ prevSalt: LEGACY_SALT, salt: local.salt });
    const again = await restart();
    expect(await again.verifyPassword(PW)).toBe(true);
    expect(local.salt).toBe(LEGACY_SALT);
    expect(local.kdfPending).toBeNull();
    expect(await unlocked(again)).toBe(plainA);
    expect(await decrypt(local.accounts['1B'].encryptedKeys, await deriveKey(PW, LEGACY_SALT))).toBe(plainB);
  });

  kdfTest('killed with the NEW keys beside the OLD salt: the new password opens and the new salt is kept', async () => {
    local.selectedAccount = '1A';
    const svc = await service();
    (svc as any).storage = local;
    killMidWrite = 'accounts-only';
    await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toThrow();
    expect(local.salt).toBe(LEGACY_SALT);
    const newSalt = local.kdfPending.salt as string;
    const again = await restart();
    expect(await again.verifyPassword(PW)).toBe(false);
    expect(await again.verifyPassword(NEW_PW)).toBe(true);
    expect(local.salt).toBe(newSalt);
    expect(local.kdfPending).toBeNull();
    expect(await unlocked(again)).toBe(plainA);
    expect(await decrypt(local.accounts['1B'].encryptedKeys, await deriveKey(NEW_PW, newSalt))).toBe(plainB);
  });

  kdfTest('the note cannot be written: nothing is changed and the old password still opens', async () => {
    local.selectedAccount = '1A';
    const svc = await service();
    (svc as any).storage = local;
    const snap = structuredClone(local);
    failSet = true;
    await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toThrow();
    expect(local).toEqual(snap);
    const again = await restart();
    expect(await again.verifyPassword(PW)).toBe(true);
  });
});

describe('the unlock repair itself cut off (reviewer probe): the note is cleared last, in its own write', () => {
  const NEW_PW = 'a brand new password';
  const restart = async () => {
    failSet = false;
    session = {};
    const svc = new ChromeStorageService();
    (svc as any).getAndSetStorage = async () => undefined;
    (svc as any).storage = local;
    return svc;
  };

  for (const half of ['salt-only', 'accounts-only'] as const)
    kdfTest(`${half} half-write, then the repairing unlock killed mid-write: the next unlock still opens`, async () => {
      local.selectedAccount = '1A';
      const svc = await service();
      (svc as any).storage = local;
      killMidWrite = half;
      await expect(svc.changePassword(NEW_PW, { currentPassword: PW })).rejects.toThrow();
      const password = half === 'salt-only' ? PW : NEW_PW; // the password the stored keys are under
      const r1 = await restart();
      killRepair = true;
      await r1.verifyPassword(password).catch(() => undefined); // the app dies inside the repair
      expect(local.kdfPending).toBeTruthy(); // the note survived the kill
      const r2 = await restart();
      expect(await r2.verifyPassword(password)).toBe(true);
      expect(await decrypt(local.accounts['1A'].encryptedKeys, await r2.getPassKey())).toBe(plainA);
      // Forward (new keys, new salt landed): the note is done with and cleared. Back to the old salt: the note is
      // kept (harmless: only a failed unlock reads it).
      if (half === 'accounts-only') expect(local.kdfPending).toBeNull();
      expect(await (await restart()).verifyPassword(password)).toBe(true);
    });

  test('every write that clears kdfPending clears nothing else', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../services/ChromeStorage.service.ts', import.meta.url), 'utf8');
    const clears = src.match(/this\.set\(\{[^}]*kdfPending: null[^}]*\}/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
    for (const c of clears) expect(c.replace(/\s+/g, ' ')).toBe('this.set({ kdfPending: null }');
  });
});
