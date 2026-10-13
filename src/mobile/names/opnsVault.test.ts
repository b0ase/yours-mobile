import { describe, expect, test } from 'bun:test';
import { newBatch, planBatch, runBatch, type BatchState, type KV } from './opnsBatch';
import { newSellBatch, runSellBatch } from './opnsSell';
import {
  addToShelf,
  emptyVault,
  exportVault,
  importVault,
  isProtected,
  loadVault,
  moveIntoVault,
  parseVaultFile,
  saveVault,
  vaultCounts,
  vaultedInBatch,
  withBuiltIn,
  type VaultState,
} from './opnsVault';
import { OWNER_GIFT, OWNER_KEEP } from './ownerVault';

const memKV = (): KV => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe('bulk import parsing', () => {
  test('one per line, CRLF, blanks, comments, @/$, case, dupes, invalid', () => {
    const r = parseVaultFile('Alpha\r\n\n@beta\n$gamma # mine\nalpha\nbad.name\n');
    expect(r.names).toEqual(['alpha', 'beta', 'gamma']);
    expect(r.invalid).toEqual(['bad.name']);
  });
  test('a name lives on one shelf; export/import round-trips and merges', () => {
    let v = addToShelf(emptyVault(), 'gift', ['a', 'b']);
    v = addToShelf(v, 'keep', ['b', 'c']);
    expect(v).toEqual({ v: 1, keep: ['b', 'c'], gift: ['a'] });
    const back = importVault(emptyVault(), exportVault(v));
    expect(back).toEqual(v);
    expect(importVault(v, 'garbage')).toEqual(v);
  });
  test('stored per identity', () => {
    const kv = memKV();
    saveVault('id1', addToShelf(emptyVault(), 'keep', ['x']), kv);
    expect(loadVault('id1', kv).keep).toEqual(['x']);
    expect(loadVault('id2', kv).keep).toEqual([]);
  });
  test('owner built-in lists merge in and protect', () => {
    expect(OWNER_KEEP.length).toBe(348);
    const v = withBuiltIn(emptyVault(), { keep: OWNER_KEEP, gift: OWNER_GIFT });
    expect(v.keep.length + v.gift.length).toBe(new Set([...OWNER_KEEP, ...OWNER_GIFT]).size);
    expect(isProtected(v, OWNER_GIFT[0])).toBe(true);
    expect(withBuiltIn(emptyVault(), null)).toEqual(emptyVault());
  });
  test('counts and invoice share', () => {
    const v = addToShelf(addToShelf(emptyVault(), 'keep', ['k']), 'gift', ['g']);
    const owned = [
      { name: 'k', listedSats: null },
      { name: 'g', listedSats: null },
      { name: 'l', listedSats: 100 },
      { name: 'u', listedSats: null },
    ];
    expect(vaultCounts(v, owned)).toEqual({ keep: 1, gift: 1, listed: 1, unlisted: 1 });
    expect(vaultedInBatch(v, ['k', 'u', 'g'])).toEqual(['k', 'g']);
  });
});

describe('auto-list skips vaulted / gift names', () => {
  test('including names vaulted after approval', async () => {
    const plan = planBatch(['aa', 'bb', 'cc', 'dd'].map((name) => ({ name, state: 'free' as const, domain: 'x' })));
    const start = newBatch(plan, 1e9);
    let vault: VaultState = addToShelf(addToShelf(emptyVault(), 'keep', ['aa']), 'gift', ['bb']);
    const listed: string[] = [];
    const r = await runBatch(
      {
        fetch: (async () => new Response('{}')) as never,
        mine: async (n) => {
          if (n === 'bb') vault = addToShelf(vault, 'keep', ['cc']); // added mid-run, after approval
          return [{ txid: `t-${n}` }];
        },
        afterMint: async (n) => {
          listed.push(n);
          return `l-${n}`;
        },
        keep: (n) => isProtected(vault, n),
        isMine: () => false,
        save: () => {},
        onUpdate: () => {},
      },
      start,
      new AbortController().signal,
    );
    expect(listed).toEqual(['dd']);
    const by = (n: string) => r.state.items.find((i) => i.name === n) as BatchState['items'][number];
    expect(by('aa').status).toBe('done');
    expect(by('aa').listed).toBeUndefined();
    expect(by('cc').note).toContain('Vault');
    expect(by('dd').listed).toBe(true);
  });
});

describe('listing disabled for vaulted', () => {
  test('a queued sell batch never lists a vaulted name', async () => {
    const b = newSellBatch(
      [
        { name: 'alpha', id: '1' },
        { name: 'bravo', id: '2' },
      ],
      50,
    )!;
    const vault = addToShelf(emptyVault(), 'keep', ['alpha']);
    const listed: string[] = [];
    const r = await runSellBatch(
      {
        list: async (it) => (listed.push(it.name), 'tx'),
        isListed: () => false,
        keep: (n) => isProtected(vault, n),
        save: () => {},
        onUpdate: () => {},
      },
      b,
      new AbortController().signal,
    );
    expect(listed).toEqual(['bravo']);
    expect(r.state.items[0].note).toBe('In your Vault');
  });
});

describe('cancel-on-vault ordering', () => {
  test('vault entry saved before the listing is cancelled', async () => {
    const log: string[] = [];
    const r = await moveIntoVault(
      { add: (n) => log.push(`add ${n}`), cancel: async (id) => void log.push(`cancel ${id}`) },
      { name: 'n', id: 'i', listedSats: 10 },
      true,
    );
    expect(log).toEqual(['add n', 'cancel i']);
    expect(r.cancelled).toBe(true);
  });
  test('cancel failure keeps it vaulted; unlisted or declined never cancels', async () => {
    const log: string[] = [];
    const deps = {
      add: (n: string) => void log.push(`add ${n}`),
      cancel: async () => {
        throw new Error('nope');
      },
    };
    expect(await moveIntoVault(deps, { name: 'a', id: '1', listedSats: 5 }, true)).toEqual({
      cancelled: false,
      error: 'nope',
    });
    expect(await moveIntoVault(deps, { name: 'b', id: '2', listedSats: null }, true)).toEqual({ cancelled: false });
    expect(await moveIntoVault(deps, { name: 'c', id: '3', listedSats: 5 }, false)).toEqual({ cancelled: false });
    expect(log).toEqual(['add a', 'add b', 'add c']);
  });
});
