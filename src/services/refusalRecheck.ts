/**
 * Never take "refused" from the broadcaster without asking the chain (P0, 3 Nov 2026).
 *
 * When the broadcaster answers REJECTED, the wallet-toolbox marks the transaction failed at once, with no chain check
 * (only a double spend is confirmed): it gives the inputs back as spendable and hides the change. But 1sat-stack also
 * answers REJECTED (UTXO_SPENT) to a re-send of a transaction that is already mined, and a payment our server or a
 * site broadcast can be refused by 1Sat while the network holds it. A wrong refusal frees coins the chain has spent
 * (the next send double-spends) and hides change the chain holds.
 *
 * So each refusal is checked against the chain before the toolbox sees it:
 *  - WhatsOnChain or ARC has seen the transaction → it is a success (the network has it; the proof follows);
 *  - every lookup cleanly says "not found" → the refusal stands (failed, inputs released, as before);
 *  - anything unclear → a service error: the transaction stays 'sending' and is retried, nothing is released.
 * Double spends and service errors pass through untouched (the toolbox confirms double spends itself).
 */
import { chainLookups, type ChainLookup, type Sighting } from './unsentGuard';

type TxidResult = { txid?: string; status?: string; serviceError?: boolean; doubleSpend?: boolean; data?: unknown };
type ProviderResult = { name?: string; status?: string; error?: unknown; txidResults?: TxidResult[] };
type PostBeef = (beef: unknown, txids: string[], logger?: unknown) => Promise<unknown>;

/** The chain's verdict for one txid: any 'seen' wins; all 'missing' is missing; else unclear. */
async function sighting(txid: string, lookups: ChainLookup[]): Promise<Sighting> {
  let missing = 0;
  for (const look of lookups) {
    const r = await look(txid).catch((): Sighting => 'unclear');
    if (r === 'seen') return 'seen';
    if (r === 'missing') missing++;
  }
  return lookups.length && missing === lookups.length ? 'missing' : 'unclear';
}

/** Pure-ish: rewrite each definite refusal in a postBeef result list by the chain's verdict. */
export async function recheckResults(
  results: unknown,
  lookups: ChainLookup[],
  log: (m: string) => void = (m) => console.warn(m),
): Promise<unknown> {
  if (!Array.isArray(results)) return results;
  const verdicts = new Map<string, Sighting>();
  for (const r of results as ProviderResult[]) {
    for (const t of r?.txidResults ?? []) {
      if (!t?.txid || t.status !== 'error' || t.serviceError || t.doubleSpend) continue;
      let v = verdicts.get(t.txid);
      if (!v) {
        v = await sighting(t.txid, lookups);
        verdicts.set(t.txid, v);
        log(`[bwx-refusal] ${t.txid}: broadcaster refused it; the chain says ${v}`);
      }
      if (v === 'seen') {
        t.status = 'success';
        delete t.serviceError;
      } else if (v === 'unclear') {
        t.serviceError = true;
      }
    }
    if (r?.status === 'error' && (r.txidResults ?? []).length && r.txidResults!.every((t) => t.status === 'success')) {
      r.status = 'success';
      delete r.error;
    }
  }
  return results;
}

/** Wrap services.postBeef so refusals are chain-checked. Returns false when there is no postBeef to wrap. */
export function recheckRefusals(
  services: unknown,
  lookups: () => ChainLookup[] = () => chainLookups(),
  log?: (m: string) => void,
): boolean {
  const s = services as { postBeef?: PostBeef; __bwxRecheck?: boolean } | null;
  if (!s || typeof s.postBeef !== 'function') return false;
  if (s.__bwxRecheck === true) return true;
  const original = s.postBeef.bind(s);
  s.postBeef = async (beef, txids, logger) => {
    const results = await original(beef, txids, logger);
    try {
      return await recheckResults(results, lookups(), log);
    } catch {
      return results;
    }
  };
  s.__bwxRecheck = true;
  return true;
}
