/** Fetch History (same pipeline as wallet/HistoryScreen.tsx, without prices) and derive airdrops + poison data. */
import { buildRows, ownOutputs, type RawTx } from '../wallet/txHistory';
import { fetchAccountTxs, fetchLocalInfo, fetchTokenSymbols } from '../wallet/txHistoryFetch';
import { classifyEvent, findListings } from '../wallet/historyEvents';
import { loadItems, saveItems, toItems } from './inbox';
import { noteForTx } from './note';
import { poisonDataFrom, savePoisonData } from './poison';

/** Refresh at most this often in the background (the badge); the inbox screen can force it. */
export const REFRESH_MS = 10 * 60_000;

type Wallet = { listActions?: (...a: never[]) => unknown } | undefined;

const running = new Map<string, Promise<void>>();

export const refreshAirdrops = (
  account: string,
  addresses: string[],
  wallet: Wallet,
  apiKey: string | undefined,
  force = false,
): Promise<void> => {
  if (!account || !addresses.length) return Promise.resolve();
  if (!force && Date.now() - loadItems(account).at < REFRESH_MS) return Promise.resolve();
  const busy = running.get(account);
  if (busy) return busy;
  const p = (async () => {
    const local = await fetchLocalInfo(wallet?.listActions?.bind(wallet) as Parameters<typeof fetchLocalInfo>[0]);
    const txs = await fetchAccountTxs(addresses, apiKey, () => undefined, local.keys());
    const own = new Set(addresses);
    const byId = new Map<string, RawTx>(txs.map((t) => [t.txid, t]));
    const prev = ownOutputs([...byId.values()], own);
    const ctx = { own, prev, listings: findListings([...byId.values()], prev) };
    const rows = buildRows(txs, own, local, Date.now()).map((r) =>
      classifyEvent(r, byId.get(r.txid), local.get(r.txid), ctx),
    );
    let items = toItems(rows, (t) => local.has(t));
    const ids = [
      ...new Set(items.map((i) => (i.asset.kind === 'token' && !i.asset.symbol ? i.asset.id : '')).filter(Boolean)),
    ];
    const syms = ids.length ? await fetchTokenSymbols(ids) : new Map<string, { sym?: string; dec?: number }>();
    items = items.map((i) =>
      syms.get(i.asset.id)?.sym ? { ...i, asset: { ...i.asset, symbol: syms.get(i.asset.id)?.sym } } : i,
    );
    items = items.map((i) => {
      const n = noteForTx(byId.get(i.txid)?.vout, i.asset);
      return n ? { ...i, note: n.text } : i;
    });
    savePoisonData(account, poisonDataFrom(rows));
    saveItems(account, items, Date.now());
  })().finally(() => running.delete(account));
  running.set(account, p);
  return p;
};
