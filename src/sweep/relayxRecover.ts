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

export function keyAt(account: HD, chain: number, i: number): RelayxKey {
  const k = account.deriveChild(chain).deriveChild(i).privKey;
  return { path: `${RELAYX_ACCOUNT}/${chain}/${i}`, address: k.toAddress(), wif: k.toWif() };
}

export type Found = IdentifiedJig & { address: string; wif: string; unread?: boolean };
export type ScanStep =
  | { k: 'addresses'; checked: number }
  | { k: 'outputs'; addresses: number }
  | { k: 'reading'; done: number; total: number; found: number };
export type ScanResult = { nfts: Found[]; otherSats: number; otherOutputs: number; addresses: number };

/** Addresses on one chain that hold anything, walked in bulk windows until GAP empty in a row. */
async function walkChain(account: HD, chain: number, reader: ChainReader, onChecked: () => void) {
  const hits: RelayxKey[] = [];
  let misses = 0;
  for (let i = 0; i < MAX_PER_CHAIN && misses < GAP; i += GAP) {
    const window = Array.from({ length: GAP }, (_, k) => keyAt(account, chain, i + k));
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
async function isJigOutput(u: Utxo, reader: ChainReader, maps: readonly NpgMap[]): Promise<boolean | 'unread'> {
  if (u.sats === RUN_JIG_SATS || maps.some((m) => !!m.jigs[outpoint(u.txid, u.vout)])) return true;
  try {
    const r = readRun(await reader.getTx(u.txid));
    return !!r && u.vout >= r.firstJig;
  } catch {
    return 'unread';
  }
}

export async function scanRelayx(
  words: string,
  reader: ChainReader,
  maps: readonly NpgMap[],
  onStep: (s: ScanStep) => void,
  signal?: { cancelled: boolean },
): Promise<ScanResult> {
  const account = relayxAccount(words);
  let checked = 0;
  const keys: RelayxKey[] = [];
  for (const chain of RELAYX_CHAINS) {
    keys.push(...(await walkChain(account, chain, reader, () => onStep({ k: 'addresses', checked: ++checked }))));
    if (signal?.cancelled) break;
  }
  onStep({ k: 'outputs', addresses: keys.length });
  const utxos: (Utxo & { wif: string })[] = [];
  for (const k of keys) {
    if (signal?.cancelled) break;
    for (const u of await reader.unspent(k.address)) utxos.push({ ...u, wif: k.wif });
  }
  const dust = utxos.filter((u) => JIG_DUST.has(u.sats));
  const rest = utxos.filter((u) => !JIG_DUST.has(u.sats));
  let done = 0;
  const nfts: Found[] = [];
  const results = await mapLimit(dust, 20, async (u) => {
    if (signal?.cancelled) return null;
    const location = outpoint(u.txid, u.vout);
    const jig = await isJigOutput(u, reader, maps);
    let item: Found | null = null;
    if (jig === 'unread')
      item = {
        location,
        origin: '',
        title: "Couldn't read this one",
        collection: '',
        address: u.address,
        wif: u.wif,
        unread: true,
      };
    else if (jig) {
      const id = await identifyJig(location, reader.getTx, maps);
      item = id.origin
        ? { ...id, address: u.address, wif: u.wif }
        : { ...id, title: "Couldn't read this one", collection: '', address: u.address, wif: u.wif, unread: true };
    }
    if (item) nfts.push(item);
    onStep({ k: 'reading', done: ++done, total: dust.length, found: nfts.filter((n) => !n.unread).length });
    return item;
  });
  // A non-Run dust output (e.g. a 1-sat ordinal) counts toward "also holds".
  const notJigs = dust.filter((_, i) => results[i] === null);
  return {
    nfts: results.filter((r): r is Found => !!r),
    otherSats: [...rest, ...notJigs].reduce((n, u) => n + u.sats, 0),
    otherOutputs: rest.length + notJigs.length,
    addresses: keys.length,
  };
}

/** Re-read just the unread ones (the "Retry" button). */
export async function retryUnread(found: Found[], reader: ChainReader, maps: readonly NpgMap[]): Promise<Found[]> {
  return mapLimit(found, 20, async (f) => {
    if (!f.unread) return f;
    const id = await identifyJig(f.location, reader.getTx, maps);
    return id.origin ? { ...id, address: f.address, wif: f.wif } : f;
  });
}

export type Group = { key: string; title: string; items: Found[] };

const S2 = /series 2/i;
/** Gallery sections: NPG Series 2, NPG Series 1, other NPG girls (one per class), other Run NFTs, unread. */
export function groupFound(found: readonly Found[]): Group[] {
  const groups: Group[] = [
    { key: 's2', title: 'NPG Series 2', items: [] },
    { key: 's1', title: 'NPG Series 1', items: [] },
    { key: 'npg', title: 'Ninja Punk Girls', items: [] },
    { key: 'other', title: 'Other RelayX NFTs', items: [] },
    { key: 'unread', title: "Couldn't be read", items: [] },
  ];
  const by = (k: string) => groups.find((g) => g.key === k)!;
  for (const f of found) {
    if (f.unread) by('unread').items.push(f);
    else if (f.n !== undefined && S2.test(f.collection)) by('s2').items.push(f);
    else if (f.n !== undefined) by('s1').items.push(f);
    else if (/npg|ninja punk/i.test(f.collection) || /^[A-Z][A-Z ]{2,}$/.test(f.title)) by('npg').items.push(f);
    else by('other').items.push(f);
  }
  for (const g of groups) g.items.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.title.localeCompare(b.title));
  return groups.filter((g) => g.items.length);
}
