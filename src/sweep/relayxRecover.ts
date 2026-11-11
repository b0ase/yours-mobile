/**
 * Recover RelayX collections (owner, 17 Oct 2026): find the Run NFTs held by a RelayX recovery phrase. Pure apart
 * from the ChainReader, so it is tested with fixtures.
 *
 * RelayX keeps everything under m/44'/236'/0': payments on /0/i (and change /1/i), NFTs on /2/i (Yours restores a
 * RelayX wallet with exactly these, utils/constants.ts). Each chain is walked until GAP addresses in a row hold
 * nothing. Outputs of jig size (1, 273 or 546 sats) are read and kept when their tx is a Run tx with a jig at that
 * output; everything else is counted as "also holds" BSV so the screen can point at the sweep for it.
 */
import { HD, Mnemonic } from '@bsv/sdk';
import { JIG_DUST, RUN_JIG_SATS } from './runGuard';
import { identifyJig, outpoint, readRun, type IdentifiedJig, type NpgMap } from './runIdentify';
import type { ChainReader, Utxo } from './chainReads';
import { readListingTx } from './relayxListing';

export const RELAYX_ACCOUNT = "m/44'/236'/0'";
export const RELAYX_CHAINS = [2, 0, 1] as const;
export const GAP = 10;
const MAX_PER_CHAIN = 400;

export type RelayxKey = { path: string; address: string; wif: string };

/** Accepts spaces, commas, new lines and "1. word" numbering. */
export const cleanWords = (input: string) => (input.toLowerCase().match(/[a-z]+/g) ?? []).join(' ');

export function wordsProblem(input: string): string | null {
  const words = cleanWords(input).split(' ').filter(Boolean);
  if (!words.length) return null;
  if (![12, 24].includes(words.length)) return `That's ${words.length} words. RelayX gave you 12.`;
  try {
    Mnemonic.fromString(words.join(' ')).check();
    return null;
  } catch {
    return "Those words don't check out. Look for a mistyped word.";
  }
}

export function relayxAccount(words: string): HD {
  return HD.fromSeed(Mnemonic.fromString(cleanWords(words)).toSeed()).derive(RELAYX_ACCOUNT);
}

/**
 * The RelayX account's public key (xpub of m/44'/236'/0'). Kept on an account restored as RelayX, so its NFTs can be
 * found again without the words or the password: it derives every address and can spend nothing.
 */
export const relayxXpub = (words: string): string => relayxAccount(words).toPublic().toString();

/** Words, or a saved xpub: what a search starts from. */
export type RelayxSource = string | { xpub: string };

/** The private key for one found NFT, from the account's words and its `path` (a restored RelayX account). */
export function wifAt(words: string, path: string): string {
  const m = /^m\/44'\/236'\/0'\/(\d+)\/(\d+)$/.exec(path);
  if (!m) throw new Error(`Not a RelayX path: ${path}`);
  return keyAt(relayxAccount(words), Number(m[1]), Number(m[2])).wif;
}
const accountOf = (src: RelayxSource): HD => (typeof src === 'string' ? relayxAccount(src) : HD.fromString(src.xpub));

/** The key at chain/i. From an xpub there is no private key: `wif` is '' and melting needs the words or password. */
export function keyAt(account: HD, chain: number, i: number): RelayxKey {
  return keyIn(account.deriveChild(chain), chain, i);
}

/**
 * The key at i on an already-derived chain node. The address comes from the node's public key, which HD has
 * already computed: privKey.toAddress() would redo the EC multiplication (~60 ms each in pure JS), same address.
 */
function keyIn(chainNode: HD, chain: number, i: number): RelayxKey {
  const node = chainNode.deriveChild(i);
  const path = `${RELAYX_ACCOUNT}/${chain}/${i}`;
  return { path, address: node.pubKey.toAddress(), wif: node.privKey ? node.privKey.toWif() : '' };
}

/**
 * Listed for sale on RelayX when it closed: the NFT sits in an OrderLock order (`location`), not at the user's
 * address. `address`/`wif`/`path` are then the cancel baton's (output 0 of the listing tx), whose key can cancel.
 */
export type Listed = { listing: string; price: number; payTo: string; problem?: string };

/** `path`: where it sits (m/44'/236'/0'/2/i), so a restored account can work out its key later (wifAt). */
export type Found = IdentifiedJig & { address: string; wif: string; path?: string; unread?: boolean; listed?: Listed };
export type ScanStep =
  | { k: 'addresses'; checked: number }
  | { k: 'outputs'; addresses: number }
  /** `items`: everything identified so far, so the gallery fills in while a big collection is read. */
  | { k: 'reading'; done: number; total: number; found: number; items: readonly Found[] };
export type ScanResult = { nfts: Found[]; otherSats: number; otherOutputs: number; addresses: number };

/** Addresses on one chain that hold anything, walked in bulk windows until GAP empty in a row. */
async function walkChain(account: HD, chain: number, reader: ChainReader, onChecked: () => void) {
  const hits: RelayxKey[] = [];
  let misses = 0;
  const chainNode = account.deriveChild(chain);
  for (let i = 0; i < MAX_PER_CHAIN && misses < GAP; i += GAP) {
    const window = Array.from({ length: GAP }, (_, k) => keyIn(chainNode, chain, i + k));
    const held = await reader.holding(window.map((w) => w.address));
    for (const w of window) {
      onChecked();
      if ((held.get(w.address) ?? 0) > 0) {
        hits.push(w);
        misses = 0;
      } else misses++;
    }
  }
  return hits;
}

/** Run `fn` over items with at most `n` at once, in order. */
async function mapLimit<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

/**
 * Is this output a Run jig? Known NPG origins and 273-sat outputs (RelayX's jig size) are, without a download:
 * an S2 mint tx carries its image (~470 KB), and a held-since-mint jig sits at its mint. Others (1 or 546 sats)
 * are read (batched + cached by the reader).
 */
async function isJigOutput(u: Utxo, reader: ChainReader, maps: readonly NpgMap[]): Promise<boolean | Error> {
  if (u.sats === RUN_JIG_SATS || maps.some((m) => !!m.jigs[outpoint(u.txid, u.vout)])) return true;
  try {
    const r = readRun(await reader.getTx(u.txid));
    return !!r && u.vout >= r.firstJig;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * What each output turned out to be, by location: the jig it holds, or null for "not a Run jig". A location is a
 * spent-once outpoint, so the answer never changes; a few dozen bytes each, so all of a big collection fits on the
 * phone and a second search is instant (owner, 17 Oct 2026: the raw-tx cache held only ~350 of 1,842). Unread
 * outputs are never remembered, so they are tried again.
 */
export type JigMemo = {
  get(location: string): IdentifiedJig | null | undefined;
  set(location: string, jig: IdentifiedJig | null): void;
};

export function createJigMemo(store: Pick<Storage, 'getItem' | 'setItem'> | null, key = 'bw.relayx.jigs.v1'): JigMemo {
  let map: Record<string, IdentifiedJig | 0> = {};
  try {
    map = JSON.parse(store?.getItem(key) ?? '{}') ?? {};
  } catch {
    map = {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    try {
      store?.setItem(key, JSON.stringify(map));
    } catch {
      // Storage full or blocked: the memo still works for this search.
    }
  };
  return {
    get: (location) => (location in map ? map[location] || null : undefined),
    set(location, jig) {
      map[location] = jig ?? 0;
      if (store && !timer) timer = setTimeout(save, 1000);
    },
  };
}

export async function scanRelayx(
  words: RelayxSource,
  reader: ChainReader,
  maps: readonly NpgMap[],
  onStep: (s: ScanStep) => void,
  signal?: { cancelled: boolean },
  memo?: JigMemo,
): Promise<ScanResult> {
  const account = accountOf(words);
  let checked = 0;
  const keys: RelayxKey[] = [];
  for (const chain of RELAYX_CHAINS) {
    keys.push(...(await walkChain(account, chain, reader, () => onStep({ k: 'addresses', checked: ++checked }))));
    if (signal?.cancelled) break;
  }
  onStep({ k: 'outputs', addresses: keys.length });
  const utxos: (Utxo & { wif: string; path: string })[] = [];
  for (const k of keys) {
    if (signal?.cancelled) break;
    for (const u of await reader.unspent(k.address)) utxos.push({ ...u, wif: k.wif, path: k.path });
  }
  const dust = utxos.filter((u) => JIG_DUST.has(u.sats));
  const rest = utxos.filter((u) => !JIG_DUST.has(u.sats));
  let done = 0;
  const nfts: Found[] = [];
  const results = await mapLimit(dust, 20, async (u) => {
    if (signal?.cancelled) return null;
    const location = outpoint(u.txid, u.vout);
    const known = memo?.get(location);
    const jig = known !== undefined ? !!known : await isJigOutput(u, reader, maps);
    if (jig === false) memo?.set(location, null);
    // Unread ones keep the reason, so the gallery can say why (owner, 18 Oct 2026).
    let item: Found | null = null;
    if (known) item = { ...known, address: u.address, wif: u.wif, path: u.path };
    else if (jig instanceof Error)
      item = {
        location,
        origin: '',
        title: "Couldn't read this one",
        collection: `Couldn't read it (${jig.message})`,
        address: u.address,
        wif: u.wif,
        path: u.path,
        unread: true,
      };
    else if (jig) {
      const id = await identifyJig(location, reader.getTx, maps);
      if (id.origin) memo?.set(location, id);
      item = id.origin
        ? { ...id, address: u.address, wif: u.wif, path: u.path }
        : {
            ...id,
            title: "Couldn't read this one",
            address: u.address,
            wif: u.wif,
            path: u.path,
            unread: true,
          };
    }
    if (item) nfts.push(item);
    onStep({
      k: 'reading',
      done: ++done,
      total: dust.length,
      found: nfts.filter((n) => !n.unread).length,
      items: nfts,
    });
    return item;
  });
  // A non-Run dust output (e.g. a 1-sat ordinal) counts toward "also holds".
  let notJigs = dust.filter((_, i) => results[i] === null);
  // RelayX cancel batons (546 sats at output 0 of a listing): their NFT is still listed if the order is unspent.
  const listed: Found[] = [];
  const batons = new Set<Utxo>();
  for (const u of notJigs.filter((x) => x.vout === 0)) {
    if (signal?.cancelled) break;
    const f = await findListed(u, reader, maps).catch(() => null);
    if (!f) continue;
    batons.add(u);
    listed.push(f);
  }
  notJigs = notJigs.filter((u) => !batons.has(u));
  return {
    nfts: [...results.filter((r): r is Found => !!r), ...listed],
    otherSats: [...rest, ...notJigs].reduce((n, u) => n + u.sats, 0),
    otherOutputs: rest.length + notJigs.length,
    addresses: keys.length,
  };
}

/**
 * Is this output the cancel baton of a RelayX listing whose order is still open? Read-only: it reads the listing
 * tx (already fetched by the scan), checks the order output is unspent, and names the NFT inside it.
 */
async function findListed(
  u: Utxo & { wif: string; path: string },
  reader: ChainReader,
  maps: readonly NpgMap[],
): Promise<Found | null> {
  const l = readListingTx(await reader.getTx(u.txid));
  if (!l || l.batonAddress !== u.address) return null;
  const open = await reader.scriptUnspent(l.orderScript);
  if (!open.some((o) => o.txid === l.txid && o.vout === l.orderVout)) return null;
  const location = outpoint(l.txid, l.orderVout);
  const id = await identifyJig(location, reader.getTx, maps);
  return {
    ...id,
    title: id.origin ? id.title : 'Listed NFT',
    address: u.address,
    wif: u.wif,
    path: u.path,
    listed: { listing: l.txid, price: l.price, payTo: l.payTo, problem: l.problem },
  };
}

/** Re-read just the unread ones (the "Retry" button). */
export async function retryUnread(found: Found[], reader: ChainReader, maps: readonly NpgMap[]): Promise<Found[]> {
  return mapLimit(found, 20, async (f) => {
    if (!f.unread || f.listed) return f;
    const id = await identifyJig(f.location, reader.getTx, maps);
    return id.origin ? { ...id, address: f.address, wif: f.wif, path: f.path } : { ...f, collection: id.collection };
  });
}

export type Group = { key: string; title: string; items: Found[] };

const S2 = /series 2/i;
/** Gallery sections: listed on RelayX, NPG Series 2, NPG Series 1, other NPG girls (one per class), other Run NFTs, unread. */
export function groupFound(found: readonly Found[]): Group[] {
  const groups: Group[] = [
    { key: 'listed', title: 'Listed for sale on RelayX', items: [] },
    { key: 's2', title: 'NPG Series 2', items: [] },
    { key: 's1', title: 'NPG Series 1', items: [] },
    { key: 'npg', title: 'Ninja Punk Girls', items: [] },
    { key: 'other', title: 'Other RelayX NFTs', items: [] },
    { key: 'unread', title: "Couldn't be read", items: [] },
  ];
  const by = (k: string) => groups.find((g) => g.key === k)!;
  for (const f of found) {
    if (f.listed) by('listed').items.push(f);
    else if (f.unread) by('unread').items.push(f);
    else if (f.n !== undefined && S2.test(f.collection)) by('s2').items.push(f);
    else if (f.n !== undefined) by('s1').items.push(f);
    else if (/npg|ninja punk/i.test(f.collection) || /^[A-Z][A-Z ]{2,}$/.test(f.title)) by('npg').items.push(f);
    else by('other').items.push(f);
  }
  for (const g of groups) g.items.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.title.localeCompare(b.title));
  return groups.filter((g) => g.items.length);
}
