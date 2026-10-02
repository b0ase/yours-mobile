import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { cancelListing, myListings, type MyListing } from './sellActions';
import { fromRaw, onListingsChanged, removeRecord } from './sell';
import { moneyNow } from '../money/money';

const GOLD = '#FFD24D';
const STATUS: Record<MyListing['status'], { label: string; color: string }> = {
  live: { label: 'On sale', color: '#A1FF8B' },
  indexing: { label: 'Indexing…', color: GOLD },
  gone: { label: 'Sold or closed', color: '#98A2B3' },
};

/** My BSV-21 listings (tickets, $NAME tokens) made in bWallet, with Cancel (tokens come back). */
export const MyTokenListings = ({ emptyText }: { emptyText?: string }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [rows, setRows] = useState<MyListing[] | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    void myListings().then(setRows);
  }, []);
  useEffect(() => {
    load();
    return onListingsChanged(load);
  }, [load]);

  const cancel = async (l: MyListing) => {
    setBusy(l.outpoint);
    try {
      await cancelListing(apiContext, l);
      addSnackbar(`Listing cancelled: ${fromRaw(BigInt(l.amount), l.dec)} $${l.symbol} back in your wallet`, 'success');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Cancel failed', 'error');
    } finally {
      setBusy('');
    }
  };

  if (rows === null) return <p className="text-xs text-[#98A2B3] text-center py-4">Loading your listings…</p>;
  if (!rows.length) return emptyText ? <p className="text-xs text-[#98A2B3] text-center py-4">{emptyText}</p> : null;

  return (
    <div className="flex flex-col gap-2">
      {rows.map((l) => {
        const s = STATUS[l.status];
        return (
          <div
            key={l.outpoint}
            className="flex items-center gap-3 rounded-xl border border-[#2b2f36] bg-[#17191E] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white overflow-hidden text-ellipsis whitespace-nowrap">
                {fromRaw(BigInt(l.amount), l.dec)} ${l.symbol}
              </div>
              <div className="text-xs text-[#98A2B3]">
                {moneyNow(l.priceSats)} · <span style={{ color: s.color }}>{s.label}</span>
              </div>
            </div>
            {l.status === 'gone' ? (
              <button
                onClick={() => removeRecord(l.outpoint)}
                className="rounded-lg px-3 py-1.5 text-xs font-bold bg-[#2b2f36] text-white"
              >
                Hide
              </button>
            ) : (
              <button
                disabled={!!busy}
                onClick={() => void cancel(l)}
                className="rounded-lg px-3 py-1.5 text-xs font-bold border disabled:opacity-40"
                style={{ background: '#17191E', borderColor: '#3a2f0c', color: GOLD }}
              >
                {busy === l.outpoint ? 'Cancelling…' : 'Cancel listing'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
