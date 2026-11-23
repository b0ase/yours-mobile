import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client';
import { EXTERNAL_OK, RESERVED_PROTOCOLS } from './reservedProtocolList';
import {
  guardReservedProtocols,
  isReservedProtocol,
  protocolHash,
  HISTORY_REFUSAL,
  LEVEL0_SIGN_REFUSAL,
  listActionsNamesNoLabel,
  RAW_HASH_REFUSAL,
  refusalCode,
  RESERVED_PROTOCOL_CODE,
  reservedProtocolRefusal,
  revokeReservedProtocolGrants,
  withoutReservedProtocols,
} from './reservedProtocols';

const ADMIN = 'wallet-admin-id';
const METHODS = [
  'getPublicKey',
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
] as const;

/** A fake permissions manager that records what reached it. */
const fakeManager = () => {
  const calls: string[] = [];
  const m: Record<string, unknown> = { calls };
  for (const method of METHODS)
    m[method] = async (args: { protocolID?: [number, string] }, originator?: string) => {
      calls.push(`${method}:${originator}:${args.protocolID?.[1]}`);
      return { ok: true };
    };
  m.ensureProtocolPermission = async () => {
    calls.push('ensure');
    return true;
  };
  m.grantGroupedPermission = async (p: unknown) => {
    calls.push(`grouped:${JSON.stringify(p)}`);
  };
  m.grantCounterpartyPermission = async (p: unknown) => {
    calls.push(`pact:${JSON.stringify(p)}`);
  };
  return m;
};

describe('reserved protocols (audit C1)', () => {
  test('bTrust owner key is refused to an outside app on every protocol method', () => {
    for (const method of METHODS)
      expect(
        reservedProtocolRefusal(method, { protocolID: [1, 'btrust'], keyID: 'owner', counterparty: 'self' }),
      ).toMatch(/reserved/);
  });

  test('the deterministic-change key is refused to apps: no site can compute change prefixes and link change', async () => {
    const m = guardReservedProtocols(fakeManager(), ADMIN) as Record<string, (...a: unknown[]) => Promise<unknown>> & {
      calls: string[];
    };
    const k = { protocolID: [2, 'bwx change recovery'], keyID: 'v1', counterparty: 'self', data: [1, 2, 3] };
    for (const method of ['createHmac', 'verifyHmac', 'encrypt', 'decrypt', 'getPublicKey'])
      await expect(m[method](k, 'evil.example')).rejects.toThrow(/reserved/);
    expect(m.calls).toEqual([]);
  });

  test('every reserved protocol is refused on every path, in any case/spacing of the name', () => {
    for (const p of RESERVED_PROTOCOLS) {
      for (const method of METHODS)
        expect(reservedProtocolRefusal(method, { protocolID: [p[0], p[1]], keyID: '1' })).not.toBeNull();
      expect(
        reservedProtocolRefusal('createSignature', { protocolID: [p[0], ` ${p[1].toUpperCase()} `] }),
      ).not.toBeNull();
    }
  });

  test('outside callers through the manager are refused before ensureProtocolPermission; the wallet still works', async () => {
    const m = guardReservedProtocols(fakeManager(), ADMIN) as Record<string, (...a: unknown[]) => Promise<unknown>> & {
      calls: string[];
    };
    for (const p of RESERVED_PROTOCOLS)
      for (const method of METHODS)
        await expect(m[method]({ protocolID: [p[0], p[1]], keyID: 'owner' }, 'evil.example')).rejects.toThrow(
          /reserved/,
        );
    await expect(
      m.ensureProtocolPermission({ originator: 'evil.example', protocolID: [1, 'btrust'], counterparty: '' }),
    ).rejects.toThrow(/reserved/);
    // No originator at all is not the wallet either.
    await expect(m.createSignature({ protocolID: [0, 'onesat'], keyID: '1sat 0' })).rejects.toThrow(/reserved/);
    expect(m.calls).toEqual([]);

    // Wallet-internal: bTrust signing, Locks (onesat), presign keep working.
    await m.createSignature({ protocolID: [1, 'btrust'], keyID: 'owner', hashToDirectlySign: [1] }, ADMIN);
    await m.getPublicKey({ protocolID: [0, 'onesat'], keyID: 'lock' }, ADMIN);
    await m.createSignature({ protocolID: [2, 'bwalletx presign'], keyID: 'x', hashToDirectlySign: [1] }, ADMIN);
    await m.ensureProtocolPermission({ originator: ADMIN, protocolID: [1, 'btrust'] });
    expect(m.calls).toHaveLength(4);
  });

  test('grouped and counterparty grants drop reserved protocols', async () => {
    const m = guardReservedProtocols(fakeManager(), ADMIN) as Record<string, (...a: unknown[]) => Promise<unknown>> & {
      calls: string[];
    };
    await m.grantGroupedPermission({
      requestID: 'r',
      granted: { protocolPermissions: [{ protocolID: [1, 'btrust'] }, { protocolID: [1, 'app posts'] }] },
    });
    await m.grantCounterpartyPermission({
      requestID: 'p',
      granted: { protocols: [{ protocolName: 'bwalletx presign' }, { protocolName: 'chat' }] },
    });
    expect(m.calls[0]).not.toContain('btrust');
    expect(m.calls[0]).toContain('app posts');
    expect(m.calls[1]).not.toContain('presign');
    expect(m.calls[1]).toContain('chat');
    expect(withoutReservedProtocols([{ protocolID: [0, 'onesat'] }, { protocolID: [0, 'p 1sat'] }])).toHaveLength(1);
  });

  test('apps keep their own protocols and Sign in with bWalletX', () => {
    expect(
      reservedProtocolRefusal('createSignature', {
        protocolID: [2, 'bwallet sign in'],
        keyID: 'n',
        counterparty: 'anyone',
      }),
    ).toBeNull();
    expect(reservedProtocolRefusal('createSignature', { protocolID: [1, 'my app'], keyID: '1' })).toBeNull();
    // PushDrop-style raw-hash signing on an app's own level 1/2 protocol still works.
    expect(
      reservedProtocolRefusal('createSignature', { protocolID: [2, 'my tokens'], hashToDirectlySign: [1] }),
    ).toBeNull();
    // 1Sat permission-module protocols ('p …') are mediated by their module, not reserved here.
    expect(isReservedProtocol([0, 'p 1sat'])).toBe(false);
    expect(reservedProtocolRefusal('getPublicKey', { identityKey: true })).toBeNull();
    expect(reservedProtocolRefusal('createAction', { protocolID: [1, 'btrust'] })).toBeNull();
  });

  test('raw-hash signing is refused for shared level-0 keys and BRC-29 payment keys', () => {
    expect(reservedProtocolRefusal('createSignature', { protocolID: [0, 'some app'], hashToDirectlySign: [1] })).toBe(
      LEVEL0_SIGN_REFUSAL,
    );
    // The data path too: sha256(data) with data = sha256(preimage) is a sighash.
    expect(reservedProtocolRefusal('createSignature', { protocolID: [0, 'some app'], data: [1] })).toBe(
      LEVEL0_SIGN_REFUSAL,
    );
    expect(reservedProtocolRefusal('createSignature', { protocolID: [0, 'fwetch identity'], data: [1] })).toBe(
      LEVEL0_SIGN_REFUSAL,
    );
    expect(reservedProtocolRefusal('verifySignature', { protocolID: [0, 'some app'], data: [1] })).toBeNull();
    expect(
      reservedProtocolRefusal('createSignature', {
        protocolID: [2, '3241645161d8'],
        keyID: 'a b',
        counterparty: '02ab',
        hashToDirectlySign: [1],
      }),
    ).toBe(RAW_HASH_REFUSAL);
    expect(reservedProtocolRefusal('createSignature', { protocolID: [2, '3241645161d8'], data: [1] })).toBe(
      RAW_HASH_REFUSAL,
    );
    expect(reservedProtocolRefusal('getPublicKey', { protocolID: [2, '3241645161d8'], keyID: 'a b' })).toBeNull();
  });

  test('the runtime hash set is exactly the readable list', () => {
    for (const p of RESERVED_PROTOCOLS) expect(isReservedProtocol([p[0], p[1]])).toBe(true);
    for (const p of EXTERNAL_OK) expect(isReservedProtocol([p[0], p[1]])).toBe(false);
    const src = readFileSync(join(import.meta.dir, 'reservedProtocols.ts'), 'utf8');
    const listed = [...src.matchAll(/0x([0-9a-f]{8}),/g)].map((m) => parseInt(m[1], 16));
    expect(listed.sort()).toEqual(RESERVED_PROTOCOLS.map((p) => protocolHash(p)).sort());
  });

  test('listActions from an app must name a label (time labels do not count)', async () => {
    const base = fakeManager() as Record<string, unknown> & { calls: string[] };
    base.listActions = async (a: unknown) => {
      base.calls.push('listActions');
      return a;
    };
    const m = guardReservedProtocols(base, ADMIN) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(m.listActions({ labels: [] }, 'evil.example')).rejects.toThrow(HISTORY_REFUSAL);
    await expect(m.listActions({}, 'evil.example')).rejects.toThrow(HISTORY_REFUSAL);
    await expect(m.listActions({ labels: ['action time from 2026-01-01T00:00:00Z'] }, 'evil.example')).rejects.toThrow(
      HISTORY_REFUSAL,
    );
    await m.listActions({ labels: ['my app'] }, 'good.example');
    await m.listActions({ labels: [] }, ADMIN);
    expect(base.calls.filter((c) => c === 'listActions')).toHaveLength(2);
    expect(listActionsNamesNoLabel({ labels: ['x'] })).toBe(false);
  });

  test('a malformed protocolID is refused', () => {
    expect(reservedProtocolRefusal('createSignature', { protocolID: 'btrust' })).toBe('Invalid protocolID');
  });

  test('upgrade migration removes stored outside grants for reserved protocols only', async () => {
    const grants = [
      {
        key: {
          type: 'protocol',
          originator: 'evil.example',
          protocolLevel: 1,
          protocolName: 'btrust',
          counterparty: '',
        },
      },
      { key: { type: 'protocol', originator: 'bchatx.com', protocolLevel: 2, protocolName: 'bwallet sign in' } },
      { key: { type: 'protocol', originator: ADMIN, protocolLevel: 1, protocolName: 'btrust' } },
      { key: { type: 'protocol', originator: 'x.com', protocolLevel: 0, protocolName: 'onesat' } },
    ];
    const deleted: unknown[] = [];
    const n = await revokeReservedProtocolGrants(
      { listGrants: async () => grants, deleteGrant: async (k: never) => void deleted.push(k) },
      ADMIN,
    );
    expect(n).toBe(2);
    expect(deleted).toEqual([grants[0].key, grants[3].key]);
  });
});

// Every protocol the wallet's own code uses must be listed as reserved or as deliberately shared.
/**
 * The toolbox keeps protocol names starting "admin" for the wallet, but its isAdminProtocol compares them as typed while
 * KeyDeriver derives from the name trimmed and lower-cased: "Admin …", " admin …" and "ADMIN …" are the wallet's own
 * admin keys (5.2.62, admin-name case bypass).
 */
describe('admin protocol names, any case or spacing (5.2.62)', () => {
  const ADMIN_NAMES = [
    'Admin metadata encryption',
    ' admin metadata encryption',
    'ADMIN PERMISSION TOKEN ENCRYPTION',
    '\tAdmin protocol-permission ',
    'admin metadata encryption',
    'admin',
  ];

  test('refused on every protocol method, at every level, with the reserved code', () => {
    for (const name of ADMIN_NAMES)
      for (const level of [0, 1, 2]) {
        expect(isReservedProtocol([level, name])).toBe(true);
        for (const method of METHODS) {
          const r = reservedProtocolRefusal(method, { protocolID: [level, name], keyID: '1', counterparty: 'self' });
          expect(r).toMatch(/reserved/);
          expect(refusalCode(r ?? '')).toBe(RESERVED_PROTOCOL_CODE);
        }
      }
  });

  test('names that only contain the word are not caught', () => {
    for (const name of ['my admin notes', 'bwallet sign in', 'app posts', 'ad min'])
      expect(isReservedProtocol([2, name])).toBe(false);
  });

  test('grants: grouped and counterparty requests drop them; a stored one is revoked', async () => {
    expect(
      withoutReservedProtocols([{ protocolID: [2, 'Admin metadata encryption'] }, { protocolID: [2, 'app posts'] }]),
    ).toEqual([{ protocolID: [2, 'app posts'] }]);
    const m = guardReservedProtocols(fakeManager(), ADMIN) as Record<string, (...a: unknown[]) => Promise<unknown>> & {
      calls: string[];
    };
    await m.grantCounterpartyPermission({
      requestID: 'p',
      granted: { protocols: [{ protocolName: ' ADMIN permission token encryption' }, { protocolName: 'chat' }] },
    });
    expect(m.calls[0]).not.toContain('ADMIN');
    let grants = [
      {
        key: {
          type: 'protocol',
          originator: 'evil.example',
          protocolLevel: 2,
          protocolName: 'Admin metadata encryption',
        },
      },
      { key: { type: 'protocol', originator: 'evil.example', protocolLevel: 2, protocolName: 'app posts' } },
      { key: { type: 'protocol', originator: ADMIN, protocolLevel: 2, protocolName: 'admin metadata encryption' } },
    ];
    const removed = await revokeReservedProtocolGrants(
      {
        listGrants: async () => grants,
        deleteGrant: async (k: never) => void (grants = grants.filter((g) => g.key !== k)),
      },
      ADMIN,
    );
    expect(removed).toBe(1);
    expect(grants.map((g) => g.key.protocolName)).toEqual(['app posts', 'admin metadata encryption']);
  });

  test('with the real permissions manager: a site gets no admin key and no sheet; the wallet keeps its own', async () => {
    const proto = new ProtoWallet(PrivateKey.fromRandom());
    const underlying = new Proxy(proto, {
      get(t, p) {
        if (p === 'listOutputs') return async () => ({ totalOutputs: 0, outputs: [] });
        if (p === 'listActions') return async () => ({ totalActions: 0, actions: [] });
        if (p === 'getNetwork') return async () => ({ network: 'mainnet' });
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const pm = new WalletPermissionsManager(underlying as never, ADMIN, {});
    const asked: unknown[] = [];
    // A sheet, should one be raised, is denied at once: a regression fails here instead of waiting forever.
    pm.bindCallback('onProtocolPermissionRequested', async (r: { requestID: string }) => {
      asked.push(r);
      await pm.denyPermission(r.requestID);
    });
    const w = guardReservedProtocols(pm, ADMIN) as unknown as Record<
      string,
      (a: unknown, o?: string) => Promise<{ publicKey?: string; ciphertext?: number[] }>
    >;
    const name = 'admin metadata encryption';
    const own = await w.getPublicKey({ protocolID: [2, name], keyID: '1' }, ADMIN);
    expect(own.publicKey).toMatch(/^0[23]/);
    const { ciphertext } = await w.encrypt({ protocolID: [2, name], keyID: '1', plaintext: [1, 2, 3] }, ADMIN);
    for (const v of ['Admin metadata encryption', ' admin metadata encryption', 'ADMIN METADATA ENCRYPTION']) {
      await expect(w.getPublicKey({ protocolID: [2, v], keyID: '1' }, 'evil.example')).rejects.toThrow(/reserved/);
      await expect(w.decrypt({ protocolID: [2, v], keyID: '1', ciphertext }, 'evil.example')).rejects.toThrow(
        /reserved/,
      );
    }
    expect(asked).toEqual([]);
  });
});

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });

describe('registry covers every wallet protocol', () => {
  test('no protocol literal in src is missing from the registry', () => {
    const known = new Set([
      ...RESERVED_PROTOCOLS.map((p) => `${p[0]}:${p[1]}`),
      ...EXTERNAL_OK.map((p) => `${p[0]}:${p[1]}`),
    ]);
    const found = new Set<string>();
    const re = /\[\s*([0-2])\s*,\s*['"]([a-zA-Z0-9][a-zA-Z0-9 ]*)['"]\s*\]/g;
    for (const file of walk(join(import.meta.dir, '..'))) {
      if (file.endsWith('reservedProtocolList.ts')) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(re)) found.add(`${m[1]}:${m[2]}`);
    }
    const missing = [...found].filter((p) => !known.has(p));
    expect(missing).toEqual([]);
  });
});
