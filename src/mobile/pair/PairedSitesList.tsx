import { useSyncExternalStore } from 'react';
import { Globe } from 'lucide-react';
import { forget, pairedSites, subscribePairs, type StoredSession } from './sessions';

const MUTED = '#98A2B3';

let cache: StoredSession[] = [];
let cacheKey = '';
const snapshot = () => {
  const next = pairedSites();
  const k = JSON.stringify(next.map((s) => [s.c, s.lastUsed]));
  if (k !== cacheKey) {
    cacheKey = k;
    cache = next;
  }
  return cache;
};

/** Settings › Paired websites: every site connected by QR, with Disconnect. */
export function PairedSitesList({ onScan }: { onScan: () => void }) {
  const sites = useSyncExternalStore(subscribePairs, snapshot);
  return (
    <div>
      {sites.length === 0 && (
        <p className="text-sm" style={{ color: MUTED }}>
          No websites paired. Use Scan to connect on a site that shows a bWallet QR code.
        </p>
      )}
      {sites.map((s) => (
        <div key={s.c} className="mb-2 flex items-center gap-3 rounded-xl p-3" style={{ background: '#17191E' }}>
          <Globe size={18} color={MUTED} />
          <div className="min-w-0 flex-1">
            <div className="overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-white">
              {new URL(s.origin).host}
            </div>
            <div className="text-xs" style={{ color: MUTED }}>
              Last used {new Date(s.lastUsed).toLocaleString()}
            </div>
          </div>
          <button
            onClick={() => forget(s.c)}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold"
            style={{ background: 'rgba(240,68,56,0.12)', color: '#FDA29B' }}
          >
            Disconnect
          </button>
        </div>
      ))}
      <button
        onClick={onScan}
        className="mt-4 w-full rounded-xl py-3 font-bold"
        style={{ background: '#F5B800', color: '#000' }}
      >
        Scan to connect
      </button>
    </div>
  );
}
