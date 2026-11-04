/**
 * Never take "refused" from the broadcaster without asking the chain (P0, 3 Nov 2026; review 4 Nov 2026, F1).
 *
 * When the broadcaster answers REJECTED, the wallet-toolbox marks the transaction failed at once, with no chain check
 * (only a double spend is confirmed): it gives the inputs back as spendable and hides the change. But 1sat-stack also
 * answers REJECTED to a re-send of a transaction it already has: "UTXO_SPENT … already spent by tx <this txid>"
 * (services/spentRetry.ts reasonNamesSpender). That happens on a resume after the app was killed mid-post, while
 * WhatsOnChain still lags (16 minutes for 5916dd14). A wrong refusal frees coins the chain has spent (the next send
 * double-spends) and hides change the chain holds.
 *
 * So each refusal is checked before the toolbox sees it:
 *  - the broadcaster's own reason names THIS txid as the spender → success (the network has it);
 *  - WhatsOnChain or ARC sees the transaction during ~30 s of retries → success (the proof follows);
 *  - every lookup says "not found" on every retry → the refusal stands (failed, inputs released, as before);
 *  - anything unclear → a service error: the transaction stays 'sending' and is retried, nothing is released.
 * Double spends and service errors pass through untouched (the toolbox confirms double spends itself).
 *
 * Re-review 06c (M1): GorillaPool ARC answers 404 for the wallet's own broadcasts (1sat-stack doesn't feed it), so for
 * those WhatsOnChain is the only witness, and it can lag 16 minutes. A Store payment resumed after the app died
 * mid-post may be out already: its txid is marked "may be out" (markMayBeOut) before the re-post, and for such a txid a
 * refusal never stands on "missing": it becomes a service error, the tx stays 'sending' with its coin held, and is
 * retried. If it truly never went out, stuckSends releases it after 24 h with its own chain check. A refusal whose
 * reason names a DIFFERENT spender (the coin went elsewhere) stands at once, with no chain wait.
 */
import { reasonNamesSpender } from './spentRetry';
import { chainVerdict, releaseLookups, type ChainLookup, type Sighting } from './unsentGuard';

type TxidResult = {
  txid?: string;
  status?: string;
  serviceError?: boolean;
  doubleSpend?: boolean;
  data?: { extraInfo?: unknown; detail?: unknown } | unknown;
};
type ProviderResult = { name?: string; status?: string; error?: unknown; txidResults?: TxidResult[] };
type PostBeef = (beef: unknown, txids: string[], logger?: unknown) => Promise<unknown>;

export type RecheckOptions = { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> };

/** How long a "may be out" mark lasts (stuckSends' own 24 h review takes over well within it). */
export const MAY_BE_OUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAY_BE_OUT_KEY = 'bwx.mayBeOut.v1';
const mayBeOutSet = new Map<string, number>();
type ChromeLocal = {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};
const chromeLocal = (): ChromeLocal | undefined =>
  (globalThis as { chrome?: { storage?: { local?: ChromeLocal } } }).chrome?.storage?.local;

/** Load the persisted marks (the service worker restarts; SendWaiting re-posts later). Never throws. */
export async function loadMayBeOut(now = Date.now()): Promise<void> {
  try {
    const saved = ((await chromeLocal()?.get(MAY_BE_OUT_KEY))?.[MAY_BE_OUT_KEY] ?? {}) as Record<string, number>;
    for (const [t, at] of Object.entries(saved)) if (now - at < MAY_BE_OUT_MS) mayBeOutSet.set(t, at);
  } catch {
    /* in memory only */
  }
}

/** This txid may already be on the network (a resumed Store payment): never let a "missing" refusal stand for it. */
export async function markMayBeOut(txid: string, now = Date.now()): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) return;
  mayBeOutSet.set(txid.toLowerCase(), now);
  for (const [t, at] of mayBeOutSet) if (now - at > MAY_BE_OUT_MS) mayBeOutSet.delete(t);
  try {
    await chromeLocal()?.set({ [MAY_BE_OUT_KEY]: Object.fromEntries(mayBeOutSet) });
  } catch {
    /* in memory only */
  }
}

export const mayBeOut = (txid: string, now = Date.now()): boolean => {
  const at = mayBeOutSet.get(txid.toLowerCase());
  return at !== undefined && now - at < MAY_BE_OUT_MS;
};

/** The txid the broadcaster's reason names as the spender of an input ("spent by tx <txid>"), if any. */
const namedSpender = (reason: string): string | undefined =>
  /spent by (?:tx )?([0-9a-f]{64})/i.exec(reason)?.[1]?.toLowerCase();

/** The broadcaster's words for this refusal: ARC's extraInfo (OneSatServices puts it in data and in the error). */
const reasonOf = (r: ProviderResult, t: TxidResult): string => {
  const d = (t.data ?? {}) as { extraInfo?: unknown; detail?: unknown };
  const parts = [d.extraInfo, d.detail, r.error instanceof Error ? r.error.message : r.error];
  return parts.filter((x) => typeof x === 'string').join(' ');
};

/** Rewrite each definite refusal in a postBeef result list by the broadcaster's reason and the chain's verdict. */
export async function recheckResults(
  results: unknown,
  lookups: ChainLookup[],
  log: (m: string) => void = (m) => console.warn(m),
  o: RecheckOptions = {},
): Promise<unknown> {
  if (!Array.isArray(results)) return results;
  const verdicts = new Map<string, Sighting>();
  for (const r of results as ProviderResult[]) {
    for (const t of r?.txidResults ?? []) {
      if (!t?.txid || t.status !== 'error' || t.serviceError || t.doubleSpend) continue;
      let v = verdicts.get(t.txid);
      if (!v) {
        const reason = reasonOf(r, t);
        const other = namedSpender(reason);
        if (reasonNamesSpender(reason, t.txid)) {
          v = 'seen';
          log(`[bwx-refusal] ${t.txid}: refused as already spent by itself: the network has it`);
        } else if (other && other !== t.txid.toLowerCase()) {
          // The coin went to another transaction: a real conflict, no chain wait (06c L6).
          v = 'missing';
          log(`[bwx-refusal] ${t.txid}: its input was spent by ${other}; the refusal stands`);
        } else {
          v = await chainVerdict(t.txid, lookups, o);
          log(`[bwx-refusal] ${t.txid}: broadcaster refused it; the chain says ${v} after retries`);
          if (v === 'missing' && mayBeOut(t.txid)) {
            // A resumed Store payment that may be out, with WhatsOnChain its only witness (06c M1): keep it held.
            v = 'unclear';
            log(`[bwx-refusal] ${t.txid}: may already be on the network (resumed); held and retried, not failed`);
          }
        }
        verdicts.set(t.txid, v);
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
  lookups: () => ChainLookup[] = () => releaseLookups(),
  log?: (m: string) => void,
  o: RecheckOptions = {},
): boolean {
  const s = services as { postBeef?: PostBeef; __bwxRecheck?: boolean } | null;
  if (!s || typeof s.postBeef !== 'function') return false;
  if (s.__bwxRecheck === true) return true;
  const original = s.postBeef.bind(s);
  s.postBeef = async (beef, txids, logger) => {
    const results = await original(beef, txids, logger);
    try {
      return await recheckResults(results, lookups(), log, o);
    } catch {
      return results;
    }
  };
  s.__bwxRecheck = true;
  return true;
}
