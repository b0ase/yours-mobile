import { parseNameList, type KV } from './opnsBatch';

/**
 * OpNS Vault (owner, 13 Oct 2026): names the owner keeps, plus a "To gift" shelf. Stored in the wallet
 * (localStorage, per identity address, like the mint queue); exportable as JSON.
 *
 *  - Vault / To-gift names can't be listed for sale and are never auto-listed after a mint. The mint batch
 *    asks `isProtected` at listing time, so a name added after the batch was approved is still skipped.
 *  - Entries may be names not minted yet: they are protected the moment they mint.
 */
export type Shelf = 'keep' | 'gift';
export type VaultState = { v: 1; keep: string[]; gift: string[] };

export const emptyVault = (): VaultState => ({ v: 1, keep: [], gift: [] });

const key = (identityAddress: string) => `bwallet.opnsVault.${identityAddress}`;
const ls = (): KV | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

const clean = (list: unknown): string[] =>
  Array.isArray(list) ? parseNameList(list.filter((x) => typeof x === 'string').join('\n')).names : [];

/** Reads a vault (from storage or an imported JSON); anything malformed gives an empty one. */
export const parseVault = (raw: string | null): VaultState => {
  try {
    const s = JSON.parse(raw ?? 'null') as Partial<VaultState> | null;
    if (!s || typeof s !== 'object') return emptyVault();
    const keep = clean(s.keep);
    // A name lives on one shelf: Vault wins.
    return { v: 1, keep, gift: clean(s.gift).filter((n) => !keep.includes(n)) };
  } catch {
    return emptyVault();
  }
};

export const loadVault = (identityAddress: string, kv: KV | null = ls()): VaultState => {
  try {
    return parseVault(kv?.getItem(key(identityAddress)) ?? null);
  } catch {
    return emptyVault();
  }
};

export const saveVault = (identityAddress: string, s: VaultState, kv: KV | null = ls()) => {
  try {
    kv?.setItem(key(identityAddress), JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
};

/** A dropped .txt (one name per line; commas, @/$ and # comments are fine too). */
export const parseVaultFile = (text: string) => parseNameList(text);

/** Adds names to a shelf (moving them off the other one). */
export const addToShelf = (s: VaultState, shelf: Shelf, names: string[]): VaultState => {
  const other: Shelf = shelf === 'keep' ? 'gift' : 'keep';
  const add = names.filter((n) => !s[shelf].includes(n));
  return { ...s, [shelf]: [...s[shelf], ...add], [other]: s[other].filter((n) => !names.includes(n)) };
};

export const removeFromVault = (s: VaultState, name: string): VaultState => ({
  ...s,
  keep: s.keep.filter((n) => n !== name),
  gift: s.gift.filter((n) => n !== name),
});

export const shelfOf = (s: VaultState, name: string): Shelf | null =>
  s.keep.includes(name) ? 'keep' : s.gift.includes(name) ? 'gift' : null;

/** Never listed: in the Vault or on the To-gift shelf. */
export const isProtected = (s: VaultState, name: string) => shelfOf(s, name) !== null;

export const exportVault = (s: VaultState) => JSON.stringify({ v: 1, keep: s.keep, gift: s.gift }, null, 2);

/** Imported JSON is merged into what is already there. */
export const importVault = (s: VaultState, json: string): VaultState => {
  const inc = parseVault(json);
  return addToShelf(addToShelf(s, 'gift', inc.gift), 'keep', inc.keep);
};

/** Mint invoice: how many of the names to mint go straight to the Vault (never listed). */
export const vaultedInBatch = (s: VaultState, names: string[]) => names.filter((n) => isProtected(s, n));

export type Counts = { keep: number; gift: number; listed: number; unlisted: number };
export const vaultCounts = (s: VaultState, owned: { name: string; listedSats: number | null }[]): Counts => ({
  keep: s.keep.length,
  gift: s.gift.length,
  listed: owned.filter((o) => o.listedSats !== null).length,
  unlisted: owned.filter((o) => o.listedSats === null && !isProtected(s, o.name)).length,
});

/**
 * Move an owned name into the Vault. The Vault entry is saved FIRST (so nothing can list it again from here
 * on), then, if it is listed and the owner approved, its listing is cancelled. A failed cancel leaves it
 * vaulted and reports the error.
 */
export const moveIntoVault = async (
  deps: { add: (name: string) => void; cancel: (id: string) => Promise<void> },
  o: { name: string; id: string; listedSats: number | null },
  cancelListing: boolean,
): Promise<{ cancelled: boolean; error?: string }> => {
  deps.add(o.name);
  if (o.listedSats === null || !cancelListing) return { cancelled: false };
  try {
    await deps.cancel(o.id);
    return { cancelled: true };
  } catch (e) {
    return { cancelled: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * The owner's built-in lists (ownerVault.ts) for identities on VITE_BMINT_STUDIO_KEYS: always merged in,
 * so his Vault/To-gift names are protected from first load with nothing to drop or untick.
 */
export const withBuiltIn = (s: VaultState, builtIn: { keep: readonly string[]; gift: readonly string[] } | null) =>
  builtIn
    ? addToShelf(
        addToShelf(
          s,
          'gift',
          [...builtIn.gift].filter((n) => !s.keep.includes(n)),
        ),
        'keep',
        [...builtIn.keep].filter((n) => !s.gift.includes(n)),
      )
    : s;
