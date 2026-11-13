/**
 * Independent review of ae664e79 (13 Nov 2026): the reviewer's proofs of concept, as repo tests. Each one minted
 * BitPlan-valid tokens (level-1 'bitcoin auth', counterparty 'anyone', keyID = a time) with no sheet on ae664e79:
 *  - a missing (or null) counterparty: the SDK signs with `counterparty ?? 'anyone'`, the manager checked 'self';
 *  - the 'anyone' public key written out (compressed, upper-case, uncompressed);
 *  - a standing level-1 grant from a manifest (grouped) sheet, or stored before the fix;
 *  - a level-1 'anyone' signature whose name has no sign-in word and whose keyID is a nonce.
 * Plus: a one-signature answer leaves a standing grant alone (review item 4), and the upgrade removes stored
 * shared-key grants once (item 1b).
 *
 * Real LocalWalletPermissionsManager over a ProtoWallet, wrapped as initWallet.ts wraps it; every token is checked
 * with ProtoWallet('anyone') against the identity key, exactly as a service such as BitPlan would.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import { oneUseGrant } from './oneShotGrant';
import { guardCrossSiteSigning } from './crossSiteSignGuard';
import { guardReservedProtocols } from './reservedProtocols';
import {
  ANYONE_PUBLIC_KEY,
  canonicalCounterparty,
  guardSharedKeySigning,
  isAnyoneCounterparty,
  isOneUseRequestID,
  isSharedKeyGrant,
  revokeSharedKeyGrants,
  revokeSharedKeyGrantsOnce,
} from './sharedKeySigning';

const ADMIN = 'admin.bwalletx.invalid';
const SITE = 'evil.example';
const enc = (t: string) => Array.from(new TextEncoder().encode(t));
const G = new PrivateKey(1).toPublicKey().toString();
const G_UNCOMPRESSED = new PrivateKey(1).toPublicKey().toDER('hex') as string;
const AUTH_KEY = {
  type: 'protocol',
  originator: SITE,
  privileged: false,
  protocolLevel: 1,
  protocolName: 'bitcoin auth',
  counterparty: '',
};

type Req = { requestID: string; protocolID: [number, string]; counterparty?: string };

const setup = (
  opts: { manifest?: boolean; answer?: (r: Req, n: number) => boolean; standingForOnce?: boolean } = {},
) => {
  const store = new InMemoryPermissionStore();
  const keys = new ProtoWallet(PrivateKey.fromRandom());
  const underlying = {
    createSignature: (a: never, o?: string) => keys.createSignature(a, o),
    verifySignature: (a: never, o?: string) => keys.verifySignature(a, o),
    getPublicKey: (a: never, o?: string) => keys.getPublicKey(a, o),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
  };
  const mgr = new LocalWalletPermissionsManager(underlying as never, ADMIN, {}, { store });
  if (opts.manifest)
    // A site's manifest asking for level-1 'bitcoin auth' (a calm "wants to sign you in" Connect sheet).
    (mgr as unknown as { manifestCache: Map<string, unknown> }).manifestCache.set(SITE, {
      groupPermissions: {
        description: 'Sign in',
        protocolPermissions: [{ protocolID: [1, 'bitcoin auth'], description: 'Sign in' }],
      },
      counterpartyPermissions: null,
      fetchedAt: Date.now(),
    });
  const sheets: Req[] = [];
  const grouped: string[] = [];
  const answer = opts.answer ?? (() => true);
  mgr.bindCallback('onProtocolPermissionRequested', (async (r: Req) => {
    sheets.push(r);
    if (!answer(r, sheets.length)) return void (await mgr.denyPermission(r.requestID));
    await mgr.grantPermission(
      isOneUseRequestID(r.requestID) && !opts.standingForOnce
        ? oneUseGrant(r.requestID)
        : { requestID: r.requestID, expiry: 0 },
    );
  }) as never);
  mgr.bindCallback('onGroupedPermissionRequested', (async (r: { requestID: string; permissions: unknown }) => {
    grouped.push(r.requestID);
    await mgr.grantGroupedPermission({ requestID: r.requestID, granted: r.permissions } as never);
  }) as never);
  const wallet = guardReservedProtocols(
    guardCrossSiteSigning(guardSharedKeySigning(mgr, { adminOriginator: ADMIN }), ADMIN),
    ADMIN,
  ) as unknown as { createSignature: (a: unknown, o?: string) => Promise<{ signature: number[] }> };
  /** A valid BitPlan-style token: checks with the identity key as 'anyone'. */
  const validToken = async (keyID: string, data: number[], signature: number[]) => {
    const { publicKey } = await keys.getPublicKey({ identityKey: true });
    return (
      await new ProtoWallet('anyone').verifySignature({
        protocolID: [1, 'bitcoin auth'],
        keyID,
        counterparty: publicKey,
        data,
        signature,
      })
    ).valid;
  };
  return { mgr, store, keys, wallet, sheets, grouped, validToken };
};

const ts = (i: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, i)).toISOString();
const token = (keyID: string, counterparty?: unknown) => ({
  protocolID: [1, 'bitcoin auth'],
  keyID,
  ...(counterparty === undefined ? {} : { counterparty }),
  data: enc(`https://gateway.bitplan.dev/v1${keyID}`),
});

describe("every spelling of 'anyone' asks once per signature", () => {
  const spellings: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['the word', 'anyone'],
    ['the anyone key, compressed', G],
    ['the anyone key, upper case', G.toUpperCase()],
    ['the anyone key, uncompressed', G_UNCOMPRESSED],
  ];
  for (const [label, cp] of spellings)
    test(`${label}: a valid token, but each one needs its own approval`, async () => {
      const { wallet, sheets, validToken } = setup({ answer: (_r, n) => n === 1 });
      const first = await wallet.createSignature(token(ts(0), cp), SITE);
      expect(await validToken(ts(0), token(ts(0)).data, first.signature)).toBe(true);
      await expect(wallet.createSignature(token(ts(1), cp), SITE)).rejects.toThrow('Permission denied');
      expect(sheets.length).toBe(2);
      expect(sheets.every((s) => isOneUseRequestID(s.requestID))).toBe(true);
    });

  test('canonicalCounterparty / isAnyoneCounterparty', () => {
    expect(ANYONE_PUBLIC_KEY).toBe(G);
    expect(canonicalCounterparty('createSignature', undefined)).toBe('anyone');
    expect(canonicalCounterparty('createSignature', null)).toBe('anyone');
    expect(canonicalCounterparty('encrypt', undefined)).toBe(undefined); // the SDK defaults these to 'self'
    expect(canonicalCounterparty('encrypt', G_UNCOMPRESSED.toUpperCase())).toBe('anyone');
    expect(canonicalCounterparty('createSignature', 'self')).toBe('self');
    const other = new PrivateKey(2).toPublicKey().toString();
    expect(canonicalCounterparty('createSignature', other)).toBe(other);
    expect(isAnyoneCounterparty('03' + G.slice(2))).toBe(false); // the other y: a different point
    expect(isAnyoneCounterparty('zz')).toBe(false);
  });

  test("a level-2 signature with no counterparty is checked as 'anyone', not 'self'", async () => {
    const { wallet, sheets } = setup();
    await wallet.createSignature({ protocolID: [2, 'acme feed'], keyID: 'a1b2c3d4', data: [1] }, SITE);
    expect(sheets[0].counterparty).toBe('anyone');
  });
});

describe('stored grants never answer a token', () => {
  test('the manifest route: a Connect grant for level-1 bitcoin auth, then 5 tokens = 5 approvals', async () => {
    const { wallet, sheets, grouped, validToken } = setup({ manifest: true });
    for (let i = 0; i < 5; i++) {
      const t = token(ts(i));
      const { signature } = await wallet.createSignature(t, SITE);
      expect(await validToken(ts(i), t.data, signature)).toBe(true);
    }
    expect(sheets.filter((s) => isOneUseRequestID(s.requestID)).length).toBe(5);
    expect(grouped.length).toBe(0); // the one-signature request never goes through the manifest flow
  });

  test('a grant stored before the fix: tokens with or without a counterparty still ask', async () => {
    const { wallet, sheets, store } = setup();
    await store.putGrant({ key: AUTH_KEY, expiry: 0, grantedAt: Date.now() } as never);
    await wallet.createSignature(token(ts(0)), SITE);
    await wallet.createSignature(token(ts(1), 'anyone'), SITE);
    expect(sheets.length).toBe(2);
  });

  test('item 4: approving a one-signature request leaves the standing grant as it was', async () => {
    const { wallet, sheets, store } = setup();
    await store.putGrant({ key: AUTH_KEY, expiry: 0, grantedAt: 1 } as never);
    await wallet.createSignature(token(ts(0), 'anyone'), SITE);
    expect(sheets.length).toBe(1);
    const g = (await store.findGrant(AUTH_KEY as never)) as { expiry: number; grantedAt: number } | null;
    expect(g).toEqual(expect.objectContaining({ expiry: 0, grantedAt: 1 }));
    // A self-signature under it still needs no sheet.
    await wallet.createSignature({ ...token('my-key'), counterparty: 'self' }, SITE);
    expect(sheets.length).toBe(1);
  });

  test('a stray standing answer to a "once:" request (any caller, any expiry) stores nothing', async () => {
    // Answer the one-signature request with a never-expiring grant, as an old code path might.
    const { wallet, sheets, store } = setup({ standingForOnce: true });
    await wallet.createSignature(token(ts(0), 'anyone'), SITE);
    expect(await store.findGrant(AUTH_KEY as never)).toBeFalsy();
    await wallet.createSignature(token(ts(1), 'anyone'), SITE);
    expect(sheets.filter((s) => isOneUseRequestID(s.requestID)).length).toBe(2);
  });
});

describe('item 2: every level-1 anyone signature asks, whatever the name or keyID', () => {
  const keyIDs = ['a1b2c3d4e5f6', '20261113T100000Z', '176304000', '17630400001', 'ts-nonce'];
  for (const keyID of keyIDs)
    test(`level-1 'acme feed', keyID ${keyID}`, async () => {
      const { wallet, sheets } = setup();
      const sig = { protocolID: [1, 'acme feed'], keyID, counterparty: 'anyone', data: [1] };
      await wallet.createSignature(sig, SITE);
      await wallet.createSignature(sig, SITE);
      expect(sheets.length).toBe(2);
    });
  test("the known-safe level-1 name ('bcal record', bit-sign calendar records) keeps its grant", async () => {
    const { wallet, sheets } = setup();
    for (const id of ['evt-1', 'evt-2'])
      await wallet.createSignature(
        { protocolID: [1, 'bcal record'], keyID: id, counterparty: 'anyone', data: [1] },
        SITE,
      );
    expect(sheets.length).toBe(1);
  });
});

describe('item 1b: stored shared-key grants are removed once on upgrade', () => {
  const grant = (key: Record<string, unknown>) => ({
    key: { type: 'protocol', originator: SITE, privileged: false, ...key },
  });
  const rows = [
    grant({ protocolLevel: 1, protocolName: 'bitcoin auth', counterparty: '' }), // removed
    grant({ protocolLevel: 1, protocolName: 'acme feed', counterparty: '' }), // removed: any level-1 key
    grant({ protocolLevel: 2, protocolName: 'message signing', counterparty: 'anyone' }), // removed
    grant({ protocolLevel: 2, protocolName: 'acme feed', counterparty: G.toUpperCase() }), // removed: anyone key
    grant({ protocolLevel: 2, protocolName: 'bwallet sign in', counterparty: 'anyone' }), // kept: our sign-in
    grant({ protocolLevel: 2, protocolName: 'bads session', counterparty: 'anyone' }), // kept
    grant({ protocolLevel: 2, protocolName: 'acme docs', counterparty: 'self' }), // kept
    grant({ protocolLevel: 1, protocolName: 'action label shop', counterparty: '' }), // kept: not a key
    grant({ protocolLevel: 1, protocolName: 'identity key retrieval', counterparty: '' }), // kept
    grant({ protocolLevel: 1, protocolName: 'sigma', counterparty: '' }), // kept: first-post signature
    grant({ protocolLevel: 1, protocolName: 'bcal record', counterparty: '' }), // kept: known safe
    { key: { type: 'protocol', originator: ADMIN, protocolLevel: 1, protocolName: 'bitcoin auth', counterparty: '' } },
    grant({ protocolLevel: undefined, protocolName: undefined }), // removed: when unsure, revoke
  ];
  const fakeStore = () => {
    const deleted: unknown[] = [];
    return {
      deleted,
      store: { listGrants: async () => rows, deleteGrant: async (k: never) => void deleted.push(k) },
    };
  };

  test('removes level-1 keys, level-2 anyone (any spelling) and unreadable rows; keeps the rest', async () => {
    const { store, deleted } = fakeStore();
    expect(await revokeSharedKeyGrants(store as never, ADMIN)).toBe(5);
    expect(deleted).toEqual([rows[0].key, rows[1].key, rows[2].key, rows[3].key, rows[12].key]);
  });

  test('once per account: the flag is written after it worked, and an unreadable flag means run it', async () => {
    const { store, deleted } = fakeStore();
    const kv = new Map<string, unknown>();
    const store1 = {
      get: async (k: string) => ({ [k]: kv.get(k) }),
      set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => kv.set(k, v)),
    };
    expect(await revokeSharedKeyGrantsOnce(store as never, ADMIN, store1, 'acct')).toBe(5);
    expect(await revokeSharedKeyGrantsOnce(store as never, ADMIN, store1, 'acct')).toBe(0);
    expect(await revokeSharedKeyGrantsOnce(store as never, ADMIN, store1, 'other')).toBe(5);
    const broken = { get: async () => Promise.reject(new Error('no storage')), set: async () => undefined };
    expect(await revokeSharedKeyGrantsOnce(store as never, ADMIN, broken, 'acct')).toBe(5);
    expect(deleted.length).toBe(15);
  });

  test('a failed revocation leaves the flag unset, so it runs again next unlock', async () => {
    const kv = new Map<string, unknown>();
    const flagStore = {
      get: async (k: string) => ({ [k]: kv.get(k) }),
      set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => kv.set(k, v)),
    };
    const failing = { listGrants: async () => Promise.reject(new Error('idb')), deleteGrant: async () => undefined };
    await expect(revokeSharedKeyGrantsOnce(failing as never, ADMIN, flagStore, 'acct')).rejects.toThrow('idb');
    expect(kv.size).toBe(0);
  });

  test('a real store: the old bitcoin auth grant is gone, and the next token asks', async () => {
    const { wallet, sheets, store } = setup();
    await store.putGrant({ key: AUTH_KEY, expiry: 0, grantedAt: Date.now() } as never);
    expect(await revokeSharedKeyGrants(store as never, ADMIN)).toBe(1);
    expect(await store.findGrant(AUTH_KEY as never)).toBeFalsy();
    await wallet.createSignature(token(ts(0)), SITE);
    expect(sheets.length).toBe(1);
  });

  test('isSharedKeyGrant', () => {
    expect(isSharedKeyGrant({ protocolLevel: 1, protocolName: 'Bitcoin Auth ' })).toBe(true);
    expect(isSharedKeyGrant({ protocolLevel: 2, protocolName: 'acme', counterparty: '02'.padEnd(66, 'a') })).toBe(
      false,
    );
  });
});

describe('wiring', () => {
  const root = join(import.meta.dir, '..');
  const bg = readFileSync(join(root, 'background.ts'), 'utf8');
  const init = readFileSync(join(root, 'initWallet.ts'), 'utf8');
  test('item 5: the single-request answer honours "once:" too', () => {
    const fn = bg.slice(bg.indexOf('const processPermissionResponse'));
    const branch = fn.slice(
      fn.indexOf('if (response.granted) {'),
      fn.indexOf('} else {', fn.indexOf('if (response.granted) {')),
    );
    expect(branch).toContain('isOneUseRequestID(response.requestID)');
    expect(branch).toContain('oneUseGrant(response.requestID)');
  });
  test('initWallet runs the one-time shared-key grant cleanup on unlock', () => {
    expect(init).toContain('await revokeSharedKeyGrantsOnce(');
  });
});
