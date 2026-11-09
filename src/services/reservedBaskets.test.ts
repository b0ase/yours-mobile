import { describe, expect, test } from 'bun:test';
import {
  isAutoGrantable,
  TRUST_SITE_BASKET,
  trustCovers,
  trustedBasketsFrom,
  type BundleRequest,
} from './permissionBundle';
import { Wallet as ToolboxWallet, WalletPermissionsManager, sdk } from '@bsv/wallet-toolbox-client';
import { createAssetPermissionModules } from '@1sat/permission-module';
import { parseWalletOutpoint } from '@bsv/sdk/wallet/validationHelpers';
import { lineDetailForTest } from './permissionBundle';
import {
  basketDisplayName,
  guardReservedBaskets,
  isReservedBasket,
  isSpecOpBasket,
  OWN_COIN_REFUSAL,
  revokeBasketGrantsForOriginator,
  revokeReservedBasketGrants,
  withoutReservedBaskets,
} from './reservedBaskets';

const ADMIN = 'admin.bwalletx';
const base = { requestID: 'r1', originator: 'site.example' } as BundleRequest;
const basket = (name: string): BundleRequest => ({ ...base, type: 'basket', basket: name });

type Key = { type: string; originator: string; basket?: string };
const memStore = (keys: Key[]) => {
  let grants = keys.map((key) => ({ key }));
  return {
    listGrants: async (f?: { type?: string }) => grants.filter((g) => !f?.type || g.key.type === f.type),
    deleteGrant: async (k: never) => {
      grants = grants.filter((g) => g.key !== (k as unknown as Key));
    },
    all: () => grants.map((g) => g.key),
  };
};

describe('reserved baskets', () => {
  test("the wallet's own baskets are reserved", () => {
    for (const b of ['default', '1sat', 'bsv21', 'lock', 'opns', 'fund', 'funding', 'vesting', TRUST_SITE_BASKET])
      expect(isReservedBasket(b)).toBe(true);
    expect(isReservedBasket(' 1SAT ')).toBe(true);
    expect(isReservedBasket('admin stuff')).toBe(true);
    expect(isReservedBasket('bchat posts')).toBe(false);
    expect(isReservedBasket(undefined)).toBe(false);
  });

  test('reserved baskets are never auto-granted', () => {
    expect(isAutoGrantable(basket('1sat'))).toBe(false);
    expect(isAutoGrantable(basket('bsv21'))).toBe(false);
    expect(isAutoGrantable(basket('default'))).toBe(false);
    expect(isAutoGrantable(basket('bchat posts'))).toBe(true);
  });

  test("Don't ask again covers only the baskets on the approved sheet", () => {
    const baskets = trustedBasketsFrom([basket('bchat posts'), basket('1sat'), { ...base, type: 'protocol' }]);
    expect(baskets).toEqual(['bchat posts']);
    const trust = { expiry: 0, baskets };
    expect(trustCovers(trust, basket('bchat posts'))).toBe(true);
    expect(trustCovers(trust, basket('other app basket'))).toBe(false);
    expect(trustCovers(trust, basket('1sat'))).toBe(false);
    expect(trustCovers(trust, basket('bsv21'))).toBe(false);
  });

  test('an old trust record without a basket list covers no basket', () => {
    expect(trustCovers({ expiry: 0 }, basket('bchat posts'))).toBe(false);
    expect(trustCovers(null, basket('bchat posts'))).toBe(false);
  });

  test('an expired trust record covers nothing', () => {
    expect(trustCovers({ expiry: 10, baskets: ['bchat posts'] }, basket('bchat posts'), 20_000)).toBe(false);
  });

  test('ensureBasketAccess refuses reserved baskets to outside sites, even with a stored grant', async () => {
    const calls: unknown[] = [];
    const m = guardReservedBaskets(
      {
        ensureBasketAccess: async (a: unknown) => {
          calls.push(a);
          return true;
        },
        grantGroupedPermission: async (p: unknown) => {
          calls.push(p);
        },
      },
      ADMIN,
    );
    await expect(m.ensureBasketAccess({ originator: 'site.example', basket: '1sat' })).rejects.toThrow(/reserved/);
    await expect(m.ensureBasketAccess({ originator: 'site.example', basket: 'bsv21' })).rejects.toThrow(/reserved/);
    expect(calls.length).toBe(0);
    expect(await m.ensureBasketAccess({ originator: ADMIN, basket: '1sat' })).toBe(true);
    expect(await m.ensureBasketAccess({ originator: 'site.example', basket: 'bchat posts' })).toBe(true);
    await m.grantGroupedPermission({ granted: { basketAccess: [{ basket: '1sat' }, { basket: 'posts' }] } });
    expect((calls.at(-1) as { granted: { basketAccess: unknown[] } }).granted.basketAccess).toEqual([
      { basket: 'posts' },
    ]);
  });

  // TERRORNODE audit, 29 Oct 2026: tokenblaster /1satordnance mints deliver the inscription into '1sat'.
  test('a site may insert (receive) into the ordinals and deposit baskets, but never list, relinquish or use them', async () => {
    const calls: string[] = [];
    const m = guardReservedBaskets(
      {
        ensureBasketAccess: async () => (calls.push('ensure'), true),
        listOutputs: async () => (calls.push('list'), { outputs: [] }),
        relinquishOutput: async () => (calls.push('relinquish'), { relinquished: true }),
      },
      ADMIN,
    );
    for (const basket of ['1sat', '1sat-deposit']) {
      expect(await m.ensureBasketAccess({ originator: 'site.example', basket, usageType: 'insertion' })).toBe(true);
      await expect(m.ensureBasketAccess({ originator: 'site.example', basket, usageType: 'listing' })).rejects.toThrow(
        /reserved/,
      );
      await expect(m.ensureBasketAccess({ originator: 'site.example', basket, usageType: 'removal' })).rejects.toThrow(
        /reserved/,
      );
      await expect(m.ensureBasketAccess({ originator: 'site.example', basket })).rejects.toThrow(/reserved/);
      await expect(m.listOutputs({ basket }, 'site.example')).rejects.toThrow(/reserved/);
      await expect(m.relinquishOutput({ basket }, 'site.example')).rejects.toThrow(/reserved/);
    }
    // Other wallet baskets stay closed to insertion too.
    for (const basket of ['default', 'bsv21', 'lock', 'opns'])
      await expect(
        m.ensureBasketAccess({ originator: 'site.example', basket, usageType: 'insertion' }),
      ).rejects.toThrow(/reserved/);
    expect(calls).toEqual([]);
  });

  test('withoutReservedBaskets drops wallet baskets', () => {
    expect(withoutReservedBaskets([{ basket: 'default' }, { basket: 'x' }])).toEqual([{ basket: 'x' }]);
  });

  test('upgrade migration removes stored outside grants for reserved baskets', async () => {
    const s = memStore([
      { type: 'basket', originator: 'site.example', basket: '1sat' },
      { type: 'basket', originator: 'site.example', basket: 'posts' },
      { type: 'basket', originator: 'site.example', basket: TRUST_SITE_BASKET },
      { type: 'basket', originator: ADMIN, basket: '1sat' },
    ]);
    expect(await revokeReservedBasketGrants(s, ADMIN)).toBe(1);
    expect(s.all().map((k) => k.basket)).toEqual(['posts', TRUST_SITE_BASKET, '1sat']);
  });

  test('Forget site removes basket grants and the trust record for that site only', async () => {
    const s = memStore([
      { type: 'basket', originator: 'site.example', basket: '1sat' },
      { type: 'basket', originator: 'https://site.example:8080', basket: 'posts' },
      { type: 'basket', originator: 'site.example', basket: TRUST_SITE_BASKET },
      { type: 'basket', originator: 'other.example', basket: 'posts' },
      { type: 'protocol', originator: 'site.example' },
    ]);
    const norm = (o: string) => o.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    expect(await revokeBasketGrantsForOriginator(s, 'https://site.example', norm)).toBe(3);
    expect(s.all()).toEqual([
      { type: 'basket', originator: 'other.example', basket: 'posts' },
      { type: 'protocol', originator: 'site.example' },
    ]);
  });
});

describe("b-Aware 25 Oct: a site can't name the wallet's own coins as inputs", () => {
  const T = 'ab'.repeat(32);
  const make = () => {
    const created: unknown[] = [];
    const m = {
      listOutputs: async (a: { basket: string }) => ({
        outputs:
          a.basket === '1sat'
            ? [{ outpoint: `${T}.0` }]
            : a.basket === 'default'
              ? [{ outpoint: `${T}.1` }]
              : a.basket === 'bsv21'
                ? [{ outpoint: `${T}.2` }]
                : a.basket === '1sat-deposit'
                  ? [{ outpoint: `${T}.3` }]
                  : [],
      }),
      createAction: async (a: unknown) => (created.push(a), { txid: 'x' }),
    };
    return { m: guardReservedBaskets(m, ADMIN), created };
  };
  test('an ordinal or BSV coin of the wallet named by a site is refused before createAction', async () => {
    for (const op of [`${T}.0`, `${T}_1`]) {
      const { m, created } = make();
      await expect(m.createAction({ inputs: [{ outpoint: op }] }, 'site.example')).rejects.toThrow(OWN_COIN_REFUSAL);
      expect(created).toHaveLength(0);
    }
  });
  // b-Aware 28 Oct 2026 (fdbayu5, High): '1sat-deposit' was not reserved, so a deposit coin passed this guard.
  test('a deposit coin (1sat-deposit) named by a site is refused, and the basket is reserved', async () => {
    for (const op of [`${T}.3`, `${T}_3`]) {
      const { m, created } = make();
      await expect(m.createAction({ inputs: [{ outpoint: op }] }, 'site.example')).rejects.toThrow(OWN_COIN_REFUSAL);
      expect(created).toHaveLength(0);
    }
    expect(isReservedBasket('1sat-deposit')).toBe(true);
  });
  test("the site's own inputs, token coins (sell sheet) and the wallet itself still work", async () => {
    const { m, created } = make();
    await m.createAction({ inputs: [{ outpoint: `${'cd'.repeat(32)}.0` }] }, 'site.example');
    await m.createAction({ inputs: [{ outpoint: `${T}.2` }] }, 'site.example');
    await m.createAction({ inputs: [{ outpoint: `${T}.0` }] }, ADMIN);
    expect(created).toHaveLength(3);
  });
  test('when the wallet cannot list its coins, named inputs are refused', async () => {
    const m = guardReservedBaskets(
      {
        listOutputs: async () => Promise.reject(new Error('down')),
        createAction: async () => ({ txid: 'x' }),
      },
      ADMIN,
    );
    await expect(m.createAction({ inputs: [{ outpoint: `${T}.9` }] }, 'site.example')).rejects.toThrow(
      OWN_COIN_REFUSAL,
    );
  });
});

describe('coins a site names are compared in one canonical form', () => {
  const T = 'ab'.repeat(32);
  const SITE = 'site.example';
  const OWN = `${T}.0`;
  const make = (listed: unknown[] = [{ outpoint: OWN }]) => {
    const created: { inputs?: Record<string, unknown>[] }[] = [];
    const m = {
      listOutputs: async (a: { basket: string }) => ({ outputs: a.basket === '1sat' ? listed : [] }),
      createAction: async (a: (typeof created)[number]) => (created.push(a), { txid: 'x' }),
    };
    return { m: guardReservedBaskets(m, ADMIN), created };
  };
  const spellings = [
    `${T.toUpperCase()}.0`,
    `${T.slice(0, 10).toUpperCase()}${T.slice(10)}.0`,
    `${T.toUpperCase()}_0`,
    `${T}_0`,
  ];

  test('the SDK reads each spelling as the same coin', () => {
    for (const op of spellings.filter((o) => o.includes('.'))) expect(parseWalletOutpoint(op).txid).toBe(T);
  });

  test("every spelling of the wallet's own coin is refused before createAction", async () => {
    for (const op of spellings) {
      const { m, created } = make();
      await expect(m.createAction({ inputs: [{ outpoint: op }] }, SITE)).rejects.toThrow(OWN_COIN_REFUSAL);
      expect(created).toHaveLength(0);
    }
  });

  test('however the wallet lists its coin, the comparison still matches', async () => {
    for (const listed of [`${T.toUpperCase()}.0`, `${T}_0`]) {
      const { m, created } = make([{ outpoint: listed }]);
      await expect(m.createAction({ inputs: [{ outpoint: OWN }] }, SITE)).rejects.toThrow(OWN_COIN_REFUSAL);
      expect(created).toHaveLength(0);
    }
  });

  test('an outpoint the wallet cannot read is refused, never passed on', async () => {
    const cd = 'cd'.repeat(32);
    const bad: unknown[] = [
      ` ${cd}.0`,
      `${cd}.0 `,
      `${cd}.0\n`,
      `${cd}.00`,
      `${cd}.01`,
      `${cd}.+1`,
      `${cd}.1e0`,
      `${cd}.0x1`,
      `${cd}.-1`,
      `${cd}.4294967296`,
      `${cd}:0`,
      `${cd}._0`,
      `${cd}.`,
      cd,
      `0x${cd}.0`,
      `${cd.slice(1)}.0`,
      `${cd}c.0`,
      `${'zz'.repeat(32)}.0`,
      '',
      0,
      null,
      undefined,
      {},
      [`${cd}.0`],
    ];
    for (const outpoint of bad) {
      const { m, created } = make();
      await expect(m.createAction({ inputs: [{ outpoint }] }, SITE)).rejects.toThrow(/can't read/);
      expect(created).toHaveLength(0);
    }
    for (const inputs of ['x', 1, {}, { length: 1, 0: { outpoint: `${cd}.0` } }, [null], ['x']]) {
      const { m, created } = make();
      await expect(m.createAction({ inputs } as never, SITE)).rejects.toThrow(/can't read/);
      expect(created).toHaveLength(0);
    }
  });

  test("an unreadable row in the wallet's own listing refuses named inputs", async () => {
    for (const outpoint of ['not-an-outpoint', `${T}.00`, undefined]) {
      const { m, created } = make([{ outpoint }]);
      await expect(m.createAction({ inputs: [{ outpoint: `${'cd'.repeat(32)}.0` }] }, SITE)).rejects.toThrow(
        OWN_COIN_REFUSAL,
      );
      expect(created).toHaveLength(0);
    }
  });

  test('a row with no txid yet is skipped: no site can name it, and it must not block the rest', async () => {
    for (const outpoint of ['null.3', 'undefined.3', 'null_3']) {
      const { m, created } = make([{ outpoint }, { outpoint: OWN }]);
      await m.createAction({ inputs: [{ outpoint: `${'cd'.repeat(32)}.0` }] }, SITE);
      expect(created).toHaveLength(1);
      await expect(m.createAction({ inputs: [{ outpoint: OWN }] }, SITE)).rejects.toThrow(OWN_COIN_REFUSAL);
    }
  });

  test("coins still in the old basket names can't be named", async () => {
    for (const basket of ['ordinals', 'p 1sat ordinals', 'p 1sat opns', 'p 1sat lock', 'bsv20']) {
      const created: unknown[] = [];
      const m = guardReservedBaskets(
        {
          listOutputs: async (a: { basket: string }) => ({ outputs: a.basket === basket ? [{ outpoint: OWN }] : [] }),
          createAction: async (a: unknown) => (created.push(a), { txid: 'x' }),
        },
        ADMIN,
      );
      await expect(m.createAction({ inputs: [{ outpoint: OWN }] }, SITE)).rejects.toThrow(OWN_COIN_REFUSAL);
      expect(created).toHaveLength(0);
    }
  });

  test('with the real manager: old "p 1sat" coins are found, and other inputs are not refused', async () => {
    const baskets: Record<string, { outpoint: string }[]> = {
      'p 1sat ordinals': [{ outpoint: OWN }],
      'p 1sat opns': [{ outpoint: `${T}.1` }],
      'p 1sat lock': [{ outpoint: `${T}.2` }],
    };
    const modules = createAssetPermissionModules({
      wallet: {} as never,
      promptHandler: async () => false,
      adminOriginator: ADMIN,
    });
    const pm = new WalletPermissionsManager(
      {
        listOutputs: async (a: { basket: string }) => ({
          outputs: baskets[a.basket] ?? [],
          totalOutputs: (baskets[a.basket] ?? []).length,
        }),
      } as never,
      ADMIN,
      { permissionModules: modules as never, encryptWalletMetadata: false },
    );
    try {
      // Why these are not read through the manager: its module refuses the old names, even for the wallet.
      await expect(pm.listOutputs({ basket: 'p 1sat ordinals' }, ADMIN)).rejects.toThrow();
      const created: unknown[] = [];
      (pm as unknown as Record<string, unknown>).createAction = async (a: unknown) => (created.push(a), { txid: 'x' });
      const m = guardReservedBaskets(pm, ADMIN) as unknown as {
        createAction: (a: unknown, o?: string) => Promise<unknown>;
      };
      for (const vout of [0, 1, 2])
        await expect(m.createAction({ inputs: [{ outpoint: `${T}.${vout}` }] }, SITE)).rejects.toThrow(
          OWN_COIN_REFUSAL,
        );
      expect(created).toHaveLength(0);
      await m.createAction({ inputs: [{ outpoint: `${'cd'.repeat(32)}.0` }] }, SITE);
      expect(created).toHaveLength(1);
    } finally {
      for (const mod of Object.values(modules) as { dispose?: () => void }[]) mod.dispose?.();
    }
  });

  test('a coin beyond the first page of a basket is still found', async () => {
    const all = Array.from({ length: 15_000 }, (_, i) => ({ outpoint: `${T}.${i}` }));
    const created: unknown[] = [];
    const m = guardReservedBaskets(
      {
        listOutputs: async (a: { basket: string; limit: number; offset?: number }) =>
          a.basket === '1sat'
            ? { outputs: all.slice(a.offset ?? 0, (a.offset ?? 0) + a.limit), totalOutputs: all.length }
            : { outputs: [], totalOutputs: 0 },
        createAction: async (a: unknown) => (created.push(a), { txid: 'x' }),
      },
      ADMIN,
    );
    await expect(m.createAction({ inputs: [{ outpoint: `${T}.14999` }] }, SITE)).rejects.toThrow(OWN_COIN_REFUSAL);
    expect(created).toHaveLength(0);
  });

  test('a basket that says it holds more than can be read refuses named inputs', async () => {
    const created: unknown[] = [];
    const m = guardReservedBaskets(
      {
        listOutputs: async (a: { basket: string; offset?: number }) =>
          a.basket === '1sat' ? { outputs: a.offset ? [] : [{ outpoint: OWN }], totalOutputs: 2 } : { outputs: [] },
        createAction: async (a: unknown) => (created.push(a), { txid: 'x' }),
      },
      ADMIN,
    );
    await expect(m.createAction({ inputs: [{ outpoint: `${'cd'.repeat(32)}.0` }] }, SITE)).rejects.toThrow(
      OWN_COIN_REFUSAL,
    );
    expect(created).toHaveLength(0);
  });

  test("a site's own coin goes on in canonical form, its other fields and the caller's args untouched", async () => {
    const cd = 'cd'.repeat(32);
    const { m, created } = make();
    const input = { outpoint: `${cd.toUpperCase()}_7`, inputDescription: 'mine', unlockingScriptLength: 108 };
    const args = { description: 'x', inputs: [input] };
    await m.createAction(args, SITE);
    expect(created[0]).toEqual({
      description: 'x',
      inputs: [{ outpoint: `${cd}.7`, inputDescription: 'mine', unlockingScriptLength: 108 }],
    });
    expect(input.outpoint).toBe(`${cd.toUpperCase()}_7`);
    expect(args.inputs[0]).toBe(input);
  });

  test('the highest output index still passes; no inputs at all is left alone', async () => {
    const cd = 'cd'.repeat(32);
    const { m, created } = make();
    await m.createAction({ inputs: [{ outpoint: `${cd}.4294967295` }] }, SITE);
    const none = { description: 'wallet funds this' };
    await m.createAction(none, SITE);
    expect(created[0].inputs?.[0].outpoint).toBe(`${cd}.4294967295`);
    expect(created[1]).toBe(none);
  });

  test("the wallet's own calls are not rewritten or refused here", async () => {
    const { m, created } = make();
    const args = { inputs: [{ outpoint: `${T.toUpperCase()}.0` }] };
    await m.createAction(args, ADMIN);
    expect(created[0]).toBe(args);
  });
});

// b-Aware 26 Oct 2026 (N2): specOpInvalidChange with the 'all' tag listed spent outputs from every basket, decrypted
// custom instructions included, after one approval of an unreadable hex basket name.
describe('special-operation basket names', () => {
  const SPEC_OPS = [
    sdk.specOpInvalidChange,
    sdk.specOpWalletBalance,
    sdk.specOpSetWalletChangeParams,
    sdk.specOpWalletManagedUtxos,
  ];

  test('every toolbox specOp and any unissued 64-hex name counts as reserved', () => {
    for (const b of [...SPEC_OPS, 'F'.repeat(64), ` ${'0'.repeat(64)} `]) {
      expect(isSpecOpBasket(b)).toBe(true);
      expect(isReservedBasket(b)).toBe(true);
    }
    expect(isSpecOpBasket('a'.repeat(63))).toBe(false);
    expect(isSpecOpBasket('bchat posts')).toBe(false);
  });

  test('listOutputs, relinquishOutput and ensureBasketAccess refuse them to outside sites before anything runs', async () => {
    const calls: string[] = [];
    const m = guardReservedBaskets(
      {
        ensureBasketAccess: async () => (calls.push('ensure'), true),
        listOutputs: async () => (calls.push('list'), { outputs: [] }),
        relinquishOutput: async () => (calls.push('relinquish'), { relinquished: true }),
      },
      ADMIN,
    );
    for (const b of SPEC_OPS) {
      await expect(m.listOutputs({ basket: b, tags: ['all'] }, 'site.example')).rejects.toThrow(/reserved/);
      await expect(m.relinquishOutput({ basket: b }, 'site.example')).rejects.toThrow(/reserved/);
      await expect(m.ensureBasketAccess({ originator: 'site.example', basket: b })).rejects.toThrow(/reserved/);
    }
    expect(calls).toEqual([]);
    // The wallet itself (admin) still can.
    await m.listOutputs({ basket: sdk.specOpInvalidChange, tags: ['all'] }, ADMIN);
    expect(calls).toEqual(['list']);
  });

  test('stored grants for specOp names are revoked; the wallet keeps its own', async () => {
    const store = memStore([
      { type: 'basket', originator: 'site.example', basket: sdk.specOpInvalidChange },
      { type: 'basket', originator: 'site.example', basket: 'b'.repeat(64) },
      { type: 'basket', originator: 'site.example', basket: 'bchat posts' },
      { type: 'basket', originator: ADMIN, basket: sdk.specOpInvalidChange },
    ]);
    expect(await revokeReservedBasketGrants(store, ADMIN)).toBe(2);
    expect(store.all().map((k) => k.basket)).toEqual(['bchat posts', sdk.specOpInvalidChange]);
  });

  test('grouped grants drop them', () => {
    expect(withoutReservedBaskets([{ basket: sdk.specOpInvalidChange }, { basket: 'posts' }])).toEqual([
      { basket: 'posts' },
    ]);
  });

  test('sheets name them "Unknown basket"', () => {
    expect(basketDisplayName(sdk.specOpInvalidChange)).toBe('Unknown basket');
    expect(basketDisplayName('c'.repeat(40))).toBe('Unknown basket');
    expect(basketDisplayName('')).toBe('Unknown basket');
    expect(basketDisplayName('bchat posts')).toBe('bchat posts');
    expect(lineDetailForTest({ ...base, type: 'basket', basket: sdk.specOpInvalidChange })).toBe('Unknown basket');
    expect(lineDetailForTest({ ...base, type: 'basket', basket: 'bchat posts' })).toBe('basket "bchat posts"');
  });

  test('the patched toolbox Wallet refuses specOp baskets to any originator but none or a listed one', async () => {
    const W = ToolboxWallet as unknown as {
      prototype: { listOutputs: (a: unknown, o?: string) => Promise<unknown> };
      bwxSpecOpOriginators: Set<string>;
    };
    expect(W.bwxSpecOpOriginators).toBeInstanceOf(Set);
    const reached: unknown[] = [];
    // Stops right after the guard: validateAuthAndArgs is the first thing past it.
    const fake = {
      validateAuthAndArgs: () => {
        reached.push(1);
        throw new Error('past the guard');
      },
    };
    const call = (o?: string) =>
      W.prototype.listOutputs.call(fake, { basket: sdk.specOpInvalidChange, tags: ['all'] }, o);
    await expect(call('site.example')).rejects.toThrow(/special operations are for the wallet only/);
    expect(reached).toEqual([]);
    await expect(call(undefined)).rejects.toThrow(/past the guard/);
    W.bwxSpecOpOriginators.add('wallet.example');
    try {
      await expect(call('wallet.example')).rejects.toThrow(/past the guard/);
    } finally {
      W.bwxSpecOpOriginators.delete('wallet.example');
    }
  });
});
