/**
 * b-Aware 12 Nov 2026: a storage server answering HTTP 507 must not get a payment it names without a check.
 * Drives the real @1sat/wallet retry layers with a fake wallet, a fake storage client and a fake /account/status.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PrivateKey } from '@bsv/sdk';
import { AuthFetch } from '@bsv/sdk/auth';
import { installStoragePaymentAutoRetry, type StoragePaymentRequiredInfo } from '@1sat/wallet';
import { installStorageClientPaymentAutoRetry } from '../../node_modules/@1sat/wallet/dist/storagePaymentAutoRetry.js';
import {
  BACKUP_FULL_NOTICE,
  STORAGE_PAY_COOLDOWN_MS,
  STORAGE_PAY_MAX_PER_DAY_SATS,
  STORAGE_PAY_MAX_PER_REQUEST_SATS,
  STORAGE_PAY_REFUSED_NOTICE,
  backupFullNotice,
  createStoragePayLedger,
  refuseBackupStorageAutoPay,
  storagePaymentHook,
  type KnownStoragePrice,
  type StoragePaymentHookDeps,
} from './storagePaymentGuard';
import { getErrorMessage } from '../utils/tools';

const REMOTE = 'https://storage.example';
const serverKey = PrivateKey.fromRandom().toPublicKey().toString();
const otherKey = PrivateKey.fromRandom().toPublicKey().toString();
const PINNED: KnownStoragePrice = {
  origin: REMOTE,
  serverIdentityKey: serverKey,
  purchaseUnitBytes: 1000,
  satsPerUnit: 100,
};

/** What the fake store's /account/status says. */
const statusBody = (o: { key?: string; deficitBytes?: number; satsPerUnit?: number; unit?: number } = {}) => ({
  accountsEnabled: true,
  serverIdentityKey: o.key ?? serverKey,
  deficitBytes: o.deficitBytes ?? 1000,
  pricing: { purchaseUnitBytes: o.unit ?? 1000, satsPerUnit: o.satsPerUnit ?? 100, durationBlocks: 1 },
  nextPayment: { derivationPrefix: 'p', derivationSuffix: 's' },
});

const fetched: { url: string; method?: string }[] = [];
let restoreFetch: (() => void) | undefined;
const fakeStatus = (body: unknown) => {
  const spy = spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async (url: string, init?: RequestInit) => {
    fetched.push({ url, method: init?.method });
    return new Response(JSON.stringify(body));
  });
  restoreFetch = () => spy.mockRestore();
};
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  fetched.length = 0;
});

/** A wallet whose store is always full: every ordinary createAction fails 507; the storage payment is recorded. */
const fullWallet = () => {
  const paid: number[] = [];
  const wallet = {
    createAction: async (args: { description?: string; outputs?: { satoshis: number }[] }) => {
      if (args.description?.startsWith('storage payment')) {
        paid.push(args.outputs?.[0]?.satoshis ?? 0);
        return { txid: 'ab'.repeat(32) };
      }
      throw new Error('WalletStorageClient rpcCall: network error 507');
    },
    signAction: async () => ({}),
    internalizeAction: async () => ({}),
    getPublicKey: async () => ({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() }),
  };
  return { wallet, paid };
};

/** One full-store wallet with our hook (or none), its clock and notices. */
const setup = (deps: Partial<StoragePaymentHookDeps> & { noHook?: boolean } = {}) => {
  const { wallet, paid } = fullWallet();
  const clock = { t: 1_000_000_000 };
  const notices: string[] = [];
  const hook = storagePaymentHook({
    known: [PINNED],
    paused: async () => false,
    notice: (t) => notices.push(t),
    now: () => clock.t,
    ledger: createStoragePayLedger(),
    log: () => undefined,
    ...deps,
  });
  installStoragePaymentAutoRetry({
    wallet: wallet as never,
    getActiveRemoteUrl: () => REMOTE,
    onStoragePaymentRequired: deps.noHook ? undefined : hook,
  });
  const write = () =>
    wallet.createAction({ description: 'a send', outputs: [{ satoshis: 1 }] }).catch((e: unknown) => e);
  return { wallet, paid, clock, notices, write };
};

describe('active store 507: the library on its own', () => {
  test('repro: with no hook (as initWallet had it), an arbitrary amount the server names is paid with no prompt', async () => {
    fakeStatus(statusBody({ deficitBytes: 1, unit: 1, satsPerUnit: 50_000_000, key: otherKey }));
    const { paid, write } = setup({ noHook: true });
    await write();
    expect(paid).toEqual([50_000_000]);
  });
});

describe('active store 507: storagePaymentHook', () => {
  test('default (no price pinned in code): refused, nothing paid, the owner is told', async () => {
    fakeStatus(statusBody());
    const { paid, notices, write } = setup({ known: undefined });
    const err = (await write()) as { code?: string; message?: string };
    expect(paid).toEqual([]);
    expect(err.code).toBe('storage-payment-failed');
    expect(getErrorMessage(err)).toBe(STORAGE_PAY_REFUSED_NOTICE);
    expect(notices).toEqual([STORAGE_PAY_REFUSED_NOTICE]);
  });

  test('an amount over the per-request cap is refused, even from the known store at the known price', async () => {
    fakeStatus(statusBody({ deficitBytes: (STORAGE_PAY_MAX_PER_REQUEST_SATS / 100 + 1) * 1000 }));
    const { paid, write } = setup();
    await write();
    expect(paid).toEqual([]);
  });

  test('a raised price is refused', async () => {
    fakeStatus(statusBody({ satsPerUnit: 101 }));
    const { paid, write } = setup();
    await write();
    expect(paid).toEqual([]);
  });

  test('a payment to a key that is not the known store’s is refused', async () => {
    fakeStatus(statusBody({ key: otherKey }));
    const { paid, write } = setup();
    await write();
    expect(paid).toEqual([]);
  });

  test('an unknown store is refused', async () => {
    fakeStatus(statusBody());
    const { paid, write } = setup({ known: [{ ...PINNED, origin: 'https://other.example' }] });
    await write();
    expect(paid).toEqual([]);
  });

  test('a small payment to the known store at the known price goes through once', async () => {
    fakeStatus(statusBody());
    const { paid, write } = setup();
    await write();
    expect(paid).toEqual([100]);
  });

  test('spending paused (or the pause can not be read): refused', async () => {
    fakeStatus(statusBody());
    const a = setup({ paused: async () => true });
    await a.write();
    expect(a.paid).toEqual([]);
    const b = setup({
      paused: async () => {
        throw new Error('offline');
      },
    });
    await b.write();
    expect(b.paid).toEqual([]);
  });

  test('repeated 507s do not pay again: one payment per cool-down, and the day cap holds', async () => {
    fakeStatus(statusBody());
    const { paid, clock, notices, write } = setup();
    for (let i = 0; i < 10; i++) await write();
    expect(paid).toEqual([100]);
    expect(notices.length).toBe(1); // told once, not on every 507
    // Concurrent 507s: still one.
    clock.t += STORAGE_PAY_COOLDOWN_MS;
    await Promise.all(Array.from({ length: 5 }, write));
    expect(paid).toEqual([100, 100]);
  });

  test('the day cap holds: a 507 every cool-down for a day pays at most the cap', async () => {
    const units = STORAGE_PAY_MAX_PER_REQUEST_SATS / PINNED.satsPerUnit;
    fakeStatus(statusBody({ deficitBytes: units * PINNED.purchaseUnitBytes }));
    const { paid, clock, write } = setup();
    for (let i = 0; i < (24 * 3_600_000) / STORAGE_PAY_COOLDOWN_MS - 1; i++) {
      await write();
      clock.t += STORAGE_PAY_COOLDOWN_MS;
    }
    expect(paid.reduce((t, s) => t + s, 0)).toBe(STORAGE_PAY_MAX_PER_DAY_SATS);
    expect(paid.every((s) => s === STORAGE_PAY_MAX_PER_REQUEST_SATS)).toBe(true);
  });

  test('a price it can not read is refused', async () => {
    const hook = storagePaymentHook({
      known: [PINNED],
      paused: async () => false,
      ledger: createStoragePayLedger(),
      log: () => undefined,
    });
    const base = {
      remoteUrl: REMOTE,
      serverIdentityKey: serverKey,
      nextPayment: { derivationPrefix: 'p', derivationSuffix: 's' },
    };
    const bad = [
      {
        ...base,
        deficitBytes: 1000,
        satsRequired: 100.5,
        pricing: { purchaseUnitBytes: 1000, satsPerUnit: 100, durationBlocks: 1 },
      },
      {
        ...base,
        deficitBytes: 1000,
        satsRequired: 1,
        pricing: { purchaseUnitBytes: 1000, satsPerUnit: 100, durationBlocks: 1 },
      },
      {
        ...base,
        deficitBytes: -1,
        satsRequired: 100,
        pricing: { purchaseUnitBytes: 1000, satsPerUnit: 100, durationBlocks: 1 },
      },
      {
        ...base,
        remoteUrl: 'not a url',
        deficitBytes: 1000,
        satsRequired: 100,
        pricing: { purchaseUnitBytes: 1000, satsPerUnit: 100, durationBlocks: 1 },
      },
    ];
    for (const info of bad) expect(await hook(info as StoragePaymentRequiredInfo)).toBe(false);
  });
});

describe('backup store 507 (sync push)', () => {
  const makeClientClass = () =>
    class FakeClient {
      endpointUrl = REMOTE;
      async processSyncChunk(): Promise<unknown> {
        throw new Error('WalletStorageClient rpcCall: network error 507');
      }
    };
  const push = async (client: { processSyncChunk: (a: unknown, c: unknown) => Promise<unknown> }) => {
    const err = await client.processSyncChunk({}, {}).catch((e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 20)); // the library pays out of band, on a timer
    return err as Error;
  };
  const payments = () => fetched.filter((f) => f.url.endsWith('/account/payment'));

  test('repro: without the guard, a 507 starts an unprompted payment request', async () => {
    fakeStatus({});
    const Client = makeClientClass();
    const client = new Client();
    installStorageClientPaymentAutoRetry({ client, wallet: fullWallet().wallet as never });
    await push(client);
    expect(payments().length).toBe(1);
  });

  test('with the guard: no payment, the push still fails as "storage full", the owner is told once', async () => {
    fakeStatus({});
    const Client = makeClientClass();
    const told: (string | undefined)[] = [];
    const undo = refuseBackupStorageAutoPay(Client, (url) => told.push(url));
    try {
      const client = new Client();
      installStorageClientPaymentAutoRetry({ client, wallet: fullWallet().wallet as never });
      for (let i = 0; i < 5; i++) {
        const err = await push(client);
        expect(err.message).toContain('storage full (HTTP 507)');
        expect(err.message).not.toMatch(/network error 507/);
      }
      expect(payments().length).toBe(0);
      expect(told).toEqual(Array(5).fill(REMOTE));
    } finally {
      undo();
    }
    // Undone: the class is as it was.
    expect(Object.prototype.hasOwnProperty.call(Client.prototype, 'processSyncChunk')).toBe(true);
  });

  test('other errors pass through untouched; the backup notice is rate-limited', async () => {
    class Other {
      async processSyncChunk(): Promise<unknown> {
        throw new Error('WalletStorageClient rpcCall: network error 503');
      }
    }
    const undo = refuseBackupStorageAutoPay(Other);
    try {
      const err = (await new Other().processSyncChunk().catch((e: unknown) => e)) as Error;
      expect(err.message).toBe('WalletStorageClient rpcCall: network error 503');
    } finally {
      undo();
    }
    const notes: string[] = [];
    const ledger = createStoragePayLedger();
    const clock = { t: 5 };
    for (let i = 0; i < 3; i++)
      backupFullNotice(
        (t) => notes.push(t),
        ledger,
        () => clock.t,
      )(REMOTE);
    expect(notes).toEqual([BACKUP_FULL_NOTICE]);
  });
});

describe('wiring', () => {
  test('initWallet passes the hook on every wallet it creates and guards backups before any client exists', () => {
    const src = readFileSync('src/initWallet.ts', 'utf8');
    const creates = src.match(/createWebWallet\(/g)?.length ?? 0;
    expect(creates).toBe(3); // the backup opener, initWallet, and initWallet's no-backups retry (spreads its config)
    expect(src.match(/onStoragePaymentRequired: storagePaymentHook\(/g)?.length).toBe(2);
    expect(src.includes('createWebWallet({ ...walletConfig, backups: [] })')).toBe(true);
    expect(src.includes('refuseBackupStorageAutoPay(StorageClient')).toBe(true);
    expect(src.indexOf('refuseBackupStorageAutoPay(StorageClient')).toBeLessThan(src.indexOf('createWebWallet('));
  });
});
