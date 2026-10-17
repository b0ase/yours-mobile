import type { ScanResult } from '../../sweep/relayxRecover';

/**
 * The last search, kept on this phone so the gallery survives the app being closed (owner, 17 Oct 2026). Public
 * chain facts only: the keys (wif) are stripped, so melting asks for the words again.
 */
const SAVED_KEY = 'bw.relayx.lastsearch.v1';
/** A restored RelayX account keeps its own saved search, keyed by its xpub's tail. */
const savedKey = (xpub?: string) => (xpub ? `${SAVED_KEY}.${xpub.slice(-16)}` : SAVED_KEY);

export function saveRelayxResult(r: ScanResult, xpub?: string) {
  try {
    const nfts = r.nfts.filter((n) => !n.unread).map((n) => ({ ...n, wif: '' }));
    localStorage.setItem(savedKey(xpub), JSON.stringify({ at: Date.now(), result: { ...r, nfts } }));
  } catch {
    // Storage full or blocked: the search still shows; it just won't survive a restart.
  }
}

/** The saved search for this xpub (or the words search without one); null when there is none or it holds no NFTs. */
export function loadSavedRelayx(xpub?: string): { result: ScanResult; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(savedKey(xpub)) ?? 'null');
    return v?.result?.nfts?.length ? v : null;
  } catch {
    return null;
  }
}
