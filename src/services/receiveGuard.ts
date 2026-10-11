/**
 * The address the Receive screen shows must always count.
 *
 * Owner, 10 Oct 2026: $5 sent to the new $vexvoid account's receive address (13WRxSg…, BRC-29 deposit index 0)
 * sat unspent on chain and on the 1Sat indexer, yet the extension showed $0 after every sync, rescan and
 * unlock. The address sync skips any txid its processed-tx store already holds, and only counts a payment
 * once internalizeAction has written it to wallet storage, so one silent failure there hides the money
 * for good. This guard asks the indexer for unspent outputs at the wallet's own receive addresses, compares
 * them with the outputs wallet storage knows, retries the missing ones directly (bypassing the processed
 * store), and counts whatever is still missing as "arriving" so nobody sees $0 for money the wallet handed
 * them an address for.
 */

export interface ChainOutput {
  outpoint: string; // "txid.vout" or "txid_vout"
  satoshis: number;
  address: string;
}

export interface UncreditedResult {
  satoshis: number;
  outputs: ChainOutput[];
  txids: string[];
}

/** Normalise "txid.vout" / "txid_vout" to "txid.vout". */
export const normOutpoint = (o: string) => o.replace('_', '.');

/**
 * Outputs the wallet has already moved itself (receiveRescue.ts), so they are spent even while the indexer still
 * lists them as unspent: the spend sits in the mempool until the next block, and the owner sync only reports a
 * spendTxid once it is mined. Owner, 11 Oct 2026 (5.2.1): right after the rescue the card showed $9.84 for $4.92,
 * the new output plus the old one still counted as "arriving", and every site createAction re-ran the guard.
 */
const moved = new Map<string, number>();
/** How long a moved outpoint is remembered: long past the spend's first confirmation. */
export const MOVED_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export function markMoved(outpoints: string[], at = Date.now()) {
  for (const o of outpoints) moved.set(normOutpoint(o), at);
}
export function isMoved(outpoint: string, now = Date.now()): boolean {
  const at = moved.get(normOutpoint(outpoint));
  if (at === undefined) return false;
  if (now - at > MOVED_TTL_MS) {
    moved.delete(normOutpoint(outpoint));
    return false;
  }
  return true;
}
/** Persistable form, for restoring after a service-worker restart. */
export const movedEntries = (): [string, number][] => [...moved.entries()];
export function restoreMoved(entries: unknown, now = Date.now()) {
  if (!Array.isArray(entries)) return;
  for (const e of entries)
    if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && now - e[1] <= MOVED_TTL_MS)
      moved.set(normOutpoint(e[0]), e[1]);
}

/** On-chain unspent outputs at our receive addresses that wallet storage does not hold. */
export function findUncredited(chain: ChainOutput[], walletOutpoints: Iterable<string>): UncreditedResult {
  const known = new Set(Array.from(walletOutpoints, normOutpoint));
  const outputs = chain.filter((o) => o.satoshis > 0 && !known.has(normOutpoint(o.outpoint)) && !isMoved(o.outpoint));
  return {
    satoshis: outputs.reduce((t, o) => t + o.satoshis, 0),
    outputs,
    txids: [...new Set(outputs.map((o) => normOutpoint(o.outpoint).split('.')[0]))],
  };
}

interface OwnerSyncOutput {
  outpoint: string;
  score?: number;
  spendTxid?: string;
  satoshis?: number;
}

export interface GuardDeps {
  /** The indexer's owner sync stream (services.owner.sync) — unspent and spent outputs at the given addresses. */
  ownerSync: (addresses: string[]) => AsyncIterable<OwnerSyncOutput>;
  /** Satoshis of one output, when the stream doesn't carry them (raw tx lookup). */
  outputSats: (outpoint: string) => Promise<number>;
  /** Every outpoint wallet storage holds, any basket, spendable or not. */
  walletOutpoints: () => Promise<string[]>;
}

/** Ask the indexer about our receive addresses and report what wallet storage is missing. */
export async function checkReceiveAddresses(addresses: string[], deps: GuardDeps): Promise<UncreditedResult> {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (!unique.length) return { satoshis: 0, outputs: [], txids: [] };
  const chain: ChainOutput[] = [];
  for await (const o of deps.ownerSync(unique)) {
    if (o.spendTxid) continue;
    const satoshis = typeof o.satoshis === 'number' ? o.satoshis : await deps.outputSats(o.outpoint);
    chain.push({ outpoint: o.outpoint, satoshis, address: '' });
  }
  return findUncredited(chain, await deps.walletOutpoints());
}

/** Last guard result, so the balance can count money still arriving. Cleared when nothing is missing. */
let arriving: { satoshis: number; at: number } = { satoshis: 0, at: 0 };
export const setArriving = (satoshis: number) => {
  arriving = { satoshis, at: Date.now() };
};
export const arrivingSats = () => arriving.satoshis;
