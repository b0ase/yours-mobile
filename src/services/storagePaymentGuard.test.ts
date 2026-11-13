/**
 * b-Aware 12 Nov 2026: a storage server answering HTTP 507 must not get a payment it names without a check.
 * Drives the real @1sat/wallet retry layers with a fake wallet, a fake storage client and a fake /account/status.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { StorageClient } from '@bsv/wallet-toolbox-client';
import { AuthFetch } from '@bsv/sdk/auth';
import { installStoragePaymentAutoRetry, type StoragePaymentRequiredInfo } from '@1sat/wallet';
import { installStorageClientPaymentAutoRetry } from '../../node_modules/@1sat/wallet/dist/storagePaymentAutoRetry.js';
import {
  BACKUP_FULL_NOTICE,
  STORAGE_PAY_COOLDOWN_MS,
  STORAGE_PAY_MAX_PER_DAY_SATS,
  STORAGE_PAY_MAX_PER_REQUEST_SATS,
  STORAGE_PAY_REFUSED_NOTICE,
  STORAGE_402_REFUSED,
  TOP_UP_REFUSED_KEY,
  backupFullNotice,
  createStoragePayLedger,
  readTopUpRefused,
  refuseBackupStorageAutoPay,
  refuseStorageAuthFetchPayments,
  refuseStorageClientPayments,
  statusAuthFetch,
  storagePaymentHook,
  type KnownStoragePrice,
  type StoragePayLedger,
  type StoragePayLedgerStore,
  type StoragePaymentHookDeps,
} from './storagePaymentGuard';
import { getErrorMessage } from '../utils/tools';
import { isPausedOrUnknown, resetKillSwitchCache } from '../mobile/config/killSwitch';

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
    store: undefined,
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
    expect(src.includes('refuseStorageClientPayments(StorageClient)')).toBe(true);
    expect(src.match(/refuseStorageAuthFetchPayments\((baseWallet|backupWallet), storageUrls\(/g)?.length).toBe(2);
    expect(src.indexOf('refuseBackupStorageAutoPay(StorageClient')).toBeLessThan(src.indexOf('createWebWallet('));
  });
});

// ── HTTP 402 (review of PR 545) ─────────────────────────────────────────────────────────────────────────────────

/** AuthFetch.fetch stand-in: the server answers 402 asking for `sats` to `key`, and 200 once a payment is attached. */
const fake402 = (sats: number, key: string) => {
  const spy = spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async function (
    this: AuthFetch,
    url: string,
    config: { method?: string; headers?: Record<string, string> } = {},
  ) {
    fetched.push({ url, method: config.method });
    if (config.headers?.['x-bsv-payment'])
      return new Response(JSON.stringify(statusBody()), { headers: { 'x-bsv-auth-identity-key': key } });
    const r402 = new Response('', {
      status: 402,
      headers: {
        'x-bsv-payment-version': '1.0',
        'x-bsv-payment-satoshis-required': String(sats),
        'x-bsv-auth-identity-key': key,
        'x-bsv-payment-derivation-prefix': 'cHJlZml4',
      },
    });
    return (this as unknown as { handlePaymentAndRetry: (...a: unknown[]) => Promise<Response> }).handlePaymentAndRetry(
      url,
      config,
      r402,
    );
  });
  restoreFetch = () => spy.mockRestore();
};

/** A wallet that can derive keys and HMACs (ProtoWallet) and records every createAction instead of paying. */
const recordingWallet = () => {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const actions: { description?: string; outputs?: { satoshis: number }[] }[] = [];
  const wallet = {
    getPublicKey: (a: never, o?: string) => proto.getPublicKey(a, o),
    createHmac: (a: never, o?: string) => proto.createHmac(a, o),
    verifyHmac: (a: never, o?: string) => proto.verifyHmac(a, o),
    createSignature: (a: never, o?: string) => proto.createSignature(a, o),
    verifySignature: (a: never, o?: string) => proto.verifySignature(a, o),
    createAction: async (args: { description?: string; outputs?: { satoshis: number }[] }) => {
      actions.push(args);
      if (args.description?.startsWith('storage payment')) return { txid: 'ab'.repeat(32) };
      if (args.description?.startsWith('Payment for request to')) return { tx: [1, 2, 3] };
      throw new Error('WalletStorageClient rpcCall: network error 507');
    },
    signAction: async () => ({}),
    internalizeAction: async () => ({}),
  };
  const paid = () => actions.filter((a) => !a.description?.startsWith('a send')).map((a) => a.outputs?.[0]?.satoshis);
  return { wallet, paid };
};

/** A StorageClient subclass with the toolbox's own authenticatedFetch (whatever another test file patched). */
const freshStorageClientClass = () => {
  class Fresh extends StorageClient {}
  let base: object | null = Object.getPrototypeOf(StorageClient.prototype);
  while (base && !Object.prototype.hasOwnProperty.call(base, 'authenticatedFetch')) base = Object.getPrototypeOf(base);
  (Fresh.prototype as unknown as Record<string, unknown>).authenticatedFetch = (
    base as Record<string, unknown>
  ).authenticatedFetch;
  return Fresh;
};
const rpc = (client: StorageClient) =>
  (client as unknown as { rpcCall: (m: string, p: unknown[]) => Promise<unknown> })
    .rpcCall('makeAvailable', [])
    .catch((e: unknown) => e as Error);

describe('402 from a storage server', () => {
  test('repro: a real StorageClient pays a 402 for whatever amount and key the server names', async () => {
    fake402(50_000_000, otherKey);
    const { wallet, paid } = recordingWallet();
    const Client = freshStorageClientClass();
    await rpc(new Client(wallet as never, REMOTE));
    expect(paid()).toEqual([50_000_000]);
  });

  test('a real StorageClient with the guard: refused, nothing paid', async () => {
    fake402(50_000_000, otherKey);
    const { wallet, paid } = recordingWallet();
    const Client = freshStorageClientClass();
    const undo = refuseStorageClientPayments(Client);
    try {
      const err = await rpc(new Client(wallet as never, REMOTE));
      expect(paid()).toEqual([]);
      expect(String((err as Error)?.message ?? err)).toContain(STORAGE_402_REFUSED);
    } finally {
      undo();
    }
  });

  test('the factory’s /account/status call: a 402 there is not paid (hook in the order initWallet uses)', async () => {
    fake402(50_000_000, otherKey);
    const { wallet, paid } = recordingWallet();
    installStoragePaymentAutoRetry({
      wallet: wallet as never,
      getActiveRemoteUrl: () => REMOTE,
      onStoragePaymentRequired: storagePaymentHook({
        known: [PINNED],
        paused: async () => false,
        store: undefined,
        ledger: createStoragePayLedger(),
        log: () => undefined,
      }),
    });
    expect(refuseStorageAuthFetchPayments(wallet, () => [REMOTE])).toBe(true);
    await wallet.createAction({ description: 'a send', outputs: [{ satoshis: 1 }] }).catch(() => undefined);
    expect(paid()).toEqual([]);
  });

  test('refuseStorageAuthFetchPayments leaves other payments alone', async () => {
    const { wallet, paid } = recordingWallet();
    refuseStorageAuthFetchPayments(wallet, () => [REMOTE]);
    const brc105 = (origin: string) => ({
      description: `Payment for request to ${origin}`,
      labels: ['brc105 00 11'],
      outputs: [{ satoshis: 5, outputDescription: 'HTTP request payment' }],
    });
    await expect(wallet.createAction(brc105(REMOTE))).rejects.toThrow(STORAGE_402_REFUSED);
    await expect(wallet.createAction({ ...brc105(REMOTE), description: 'something else' })).rejects.toThrow();
    await expect(wallet.createAction(brc105('https://paid-api.example'))).resolves.toBeDefined();
    expect(paid()).toEqual([5]);
  });

  test('status and liveness checks (Storage page, provider picker) never pay a 402', async () => {
    fake402(50_000_000, otherKey);
    const { wallet, paid } = recordingWallet();
    await expect(statusAuthFetch(wallet).fetch(`${REMOTE}/account/status`, { method: 'GET' })).rejects.toThrow(
      STORAGE_402_REFUSED,
    );
    expect(paid()).toEqual([]);
    for (const f of ['src/components/ProviderPicker.tsx', 'src/hooks/useRemoteStatus.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src.includes('new AuthFetch(')).toBe(false);
      expect(src.includes('statusAuthFetch(wallet)')).toBe(true);
    }
  });
});

describe('pause, persistence, the Storage page warning', () => {
  test('the pause check fails closed: unreadable status counts as paused', async () => {
    resetKillSwitchCache();
    expect(await isPausedOrUnknown('spending', async () => Promise.reject(new Error('offline')))).toBe(true);
    resetKillSwitchCache();
    expect(await isPausedOrUnknown('spending', async () => new Response(JSON.stringify({ paused: [] })))).toBe(false);
    resetKillSwitchCache();
    expect(
      await isPausedOrUnknown('spending', async () => new Response(JSON.stringify({ paused: ['spending'] }))),
    ).toBe(true);
    resetKillSwitchCache();
  });

  test('the caps survive a restart: a new ledger reads the saved one before deciding', async () => {
    fakeStatus(statusBody());
    let saved: StoragePayLedger | undefined;
    const store: StoragePayLedgerStore = {
      load: async () => (saved ? structuredClone(saved) : undefined),
      save: async (l) => {
        saved = structuredClone(l);
      },
    };
    const first = setup({ store });
    await first.write();
    expect(first.paid).toEqual([100]);
    await new Promise((r) => setTimeout(r, 0));
    // "Restart": a fresh ledger in memory, same clock, same saved state.
    const second = setup({ store, now: () => first.clock.t + 1 });
    await second.write();
    expect(second.paid).toEqual([]);
  });

  test('a refusal leaves the Storage page a warning that lasts', async () => {
    const area: Record<string, unknown> = {};
    const g = globalThis as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(g, 'chrome');
    Object.defineProperty(g, 'chrome', {
      configurable: true,
      writable: true,
      value: {
        storage: {
          local: {
            get: (k: string, cb: (r: Record<string, unknown>) => void) => cb({ [k]: area[k] }),
            set: (o: Record<string, unknown>, cb?: () => void) => {
              Object.assign(area, o);
              cb?.();
            },
          },
        },
      },
    });
    try {
      fakeStatus(statusBody());
      const { write, clock } = setup({ known: undefined });
      await write();
      await new Promise((r) => setTimeout(r, 0));
      expect((area[TOP_UP_REFUSED_KEY] as { kind?: string })?.kind).toBe('active');
      expect((await readTopUpRefused(clock.t + 3_600_000))?.kind).toBe('active');
      expect(await readTopUpRefused(clock.t + 4 * 24 * 3_600_000)).toBeUndefined();
    } finally {
      if (had) Object.defineProperty(g, 'chrome', had);
      else delete g.chrome;
    }
  });
});
