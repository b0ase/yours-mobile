import { describe, expect, test } from 'bun:test';
import {
  isAutoGrantable,
  TRUST_SITE_BASKET,
  trustCovers,
  trustedBasketsFrom,
  type BundleRequest,
} from './permissionBundle';
import { Wallet as ToolboxWallet, sdk } from '@bsv/wallet-toolbox-client';
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
