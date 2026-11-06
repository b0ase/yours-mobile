/**
 * Pots & Locks › Locks › BSV locks: "Find my locks" files this wallet's BSV time-locks from the chain into the wallet
 * (lockFinder.findBsvLocks: the seed's lock key, 1Sat's indexer, no server of ours). Below it, the locks the wallet
 * holds that no unclaimed plan piece on this device lists (a restored wallet, a new device, feed locks), with Claim
 * when some are ready. Runs by itself once per device store (backing off after a failed run), like Find my token locks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Unlock } from 'lucide-react';
import { listLocks } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { fmtBsv, type LockPlan } from './schedule';
import { canUnlock, countdown } from './tokenLocks';
import { claimLocks, claimSatsPerKb, claimableLocks, unclaimedOutpoints } from './lockApi';
import { bsvLockRepairs, bsvLocksScanDue, bsvScanLine, scanBsvLocks, type BsvLockScan } from './lockFinder';
import { claimRate, lockScanOptions } from './lockScanWiring';

const GOLD = 'var(--bw-accent)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#F97066';
const GREEN = '#32D583';

type Row = { outpoint: string; satoshis: number; until: number; tags?: string[] };
type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning'; detail: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; scan: BsvLockScan };

export const BsvLocksSection = ({
  height,
  plans,
  onChanged,
}: {
  height: number;
  plans: LockPlan[];
  onChanged: () => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const account = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [repairs, setRepairs] = useState<string[]>(() => (account ? bsvLockRepairs(account) : []));
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true; // StrictMode mounts twice in development
    return () => {
      live.current = false;
    };
  }, []);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const reload = useCallback(async () => {
    try {
      const res = await listLocks.execute(apiContext, { limit: 10000 });
      const out = 'outputs' in res && res.outputs ? res.outputs : [];
      if (!live.current) return;
      setRows(
        out.map((o) => ({
          outpoint: o.outpoint.replace('_', '.'),
          satoshis: o.satoshis,
          until: Number.parseInt(o.tags?.find((t) => t.startsWith('until:'))?.slice(6) ?? '0', 10),
          tags: o.tags,
        })),
      );
    } catch {
      // offline: keep what is shown
    }
  }, [apiContext]);
  useEffect(() => void reload(), [reload]);

  const run = useCallback(
    async (auto = false) => {
      if (!account || !apiContext.services) return;
      try {
        const opts = await lockScanOptions();
        if (auto && !bsvLocksScanDue(account, opts.store)) return;
        if (!live.current) return;
        setState({ kind: 'scanning', detail: 'Starting…' });
        const scan = await scanBsvLocks(apiContext, account, {
          ...opts,
          onProgress: (detail) => live.current && setState({ kind: 'scanning', detail }),
        });
        if (!live.current) return;
        setState({ kind: 'done', scan });
        setRepairs(scan.retry.length ? bsvLockRepairs(account) : scan.repair);
        await reload();
        if (scan.added) changed.current();
      } catch (e) {
        if (live.current)
          setState({
            kind: 'error',
            message: `Couldn't search the chain right now${e instanceof Error && e.message ? ` (${e.message})` : ''}. Your locks are safe; try again later.`,
          });
      }
    },
    [apiContext, account, reload],
  );

  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !account || !apiContext.services) return;
    autoTried.current = true;
    void run(true);
  }, [account, apiContext.services, run]);

  const planned = useMemo(() => unclaimedOutpoints(plans), [plans]);
  const unplanned = rows.filter((r) => r.until > 0 && !planned.has(r.outpoint)).sort((a, b) => a.until - b.until);
  // Only locks worth more than their fee at this wallet's rate; dust never costs a fee (lockApi.claimableLocks).
  const [satsPerKb, setSatsPerKb] = useState(() => claimSatsPerKb(chromeStorageService.getCustomFeeRate(), undefined));
  useEffect(() => {
    let on = true;
    void claimRate(chromeStorageService).then((r) => on && setSatsPerKb(r));
    return () => {
      on = false;
    };
  }, [chromeStorageService]);
  const ready = claimableLocks(unplanned, height, { satsPerKb });

  const claim = async () => {
    setBusy(true);
    try {
      const r = await claimLocks(apiContext, { outpoints: ready.picks.map((p) => p.outpoint), satsPerKb });
      addSnackbar(
        `Claimed ${fmtBsv(r.sats)} back to your wallet.${r.error ? ' Some locks are left; tap Claim again.' : ''}`,
        'success',
      );
      await reload();
      changed.current();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Claim failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const line = bsvScanLine(state);
  const showRepairs = state.kind !== 'done' && repairs.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold" style={{ color: MUTED }}>
          BSV locks on chain
        </div>
        <button
          type="button"
          disabled={state.kind === 'scanning'}
          onClick={() => void run()}
          className="flex items-center gap-1 text-xs font-bold"
          style={{ color: state.kind === 'scanning' ? MUTED : GOLD }}
        >
          <Search size={13} /> {state.kind === 'scanning' ? 'Searching…' : 'Find my locks'}
        </button>
      </div>
      {line && (
        <div className="text-xs" style={{ color: state.kind === 'error' ? RED : MUTED }}>
          {line}
        </div>
      )}
      {showRepairs && (
        <div className="text-xs" style={{ color: MUTED }}>
          {repairs.length} lock{repairs.length === 1 ? '' : 's'} on chain couldn’t be added: {repairs.join('; ')}
        </div>
      )}
      {unplanned.map((r) => {
        const open = height > 0 && canUnlock(r.until, height);
        return (
          <div
            key={r.outpoint}
            className="rounded-2xl p-3 flex flex-col gap-1"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <div className="flex justify-between gap-2">
              <span className="text-sm font-bold text-white truncate">Lock</span>
              <span className="text-sm text-white">{fmtBsv(r.satoshis)}</span>
            </div>
            <div className="flex justify-between text-xs" style={{ color: MUTED }}>
              <span>Block {r.until}</span>
              <span style={{ color: open ? GREEN : GOLD }}>{height ? countdown(r.until, height) : '…'}</span>
            </div>
          </div>
        );
      })}
      {ready.ids.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void claim()}
          className="self-start flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          <Unlock size={13} /> {busy ? 'Claiming…' : `Claim ${fmtBsv(ready.sats)}`}
        </button>
      )}
    </div>
  );
};

export default BsvLocksSection;
