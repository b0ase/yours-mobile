/**
 * Pots & Locks › Locks › BSV locks: "Find my locks" files this wallet's BSV time-locks from the chain into the wallet
 * (lockFinder.findBsvLocks: the seed's lock key, 1Sat's indexer, no server of ours). Below it, the locks the wallet
 * holds that no plan on this device lists (a restored wallet, a new device, feed locks), with Claim when one is ready.
 * Runs once by itself on a device that has never looked, like Find my token locks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Unlock } from 'lucide-react';
import { listLocks, unlockBsv } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { fmtBsv, type LockPlan } from './schedule';
import { canUnlock, countdown } from './tokenLocks';
import { bsvLocksScanned, bsvScanLine, scanBsvLocks, type BsvLockScan } from './lockFinder';

const GOLD = 'var(--bw-accent)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#F97066';
const GREEN = '#32D583';

type Row = { outpoint: string; satoshis: number; until: number; id?: string };
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
  const account = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress ?? '';
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
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
          id: readAssetIdTag(o.tags),
        })),
      );
    } catch {
      // offline: keep what is shown
    }
  }, [apiContext]);
  useEffect(() => void reload(), [reload]);

  const run = useCallback(async () => {
    if (!account || !apiContext.services) return;
    setState({ kind: 'scanning', detail: 'Starting…' });
    try {
      const scan = await scanBsvLocks(
        apiContext,
        account,
        (detail) => live.current && setState({ kind: 'scanning', detail }),
      );
      if (!live.current) return;
      setState({ kind: 'done', scan });
      await reload();
      if (scan.added) changed.current();
    } catch (e) {
      if (live.current)
        setState({
          kind: 'error',
          message: `Couldn't search the chain right now${e instanceof Error && e.message ? ` (${e.message})` : ''}. Your locks are safe; try again later.`,
        });
    }
  }, [apiContext, account, reload]);

  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !account || !apiContext.services || bsvLocksScanned(account)) return;
    autoTried.current = true;
    void run();
  }, [account, apiContext.services, run]);

  const planned = useMemo(() => new Set(plans.flatMap((p) => p.pieces.map((x) => `${x.txid}.${x.vout}`))), [plans]);
  const unplanned = rows.filter((r) => r.until > 0 && !planned.has(r.outpoint)).sort((a, b) => a.until - b.until);
  const ready = unplanned.filter((r) => height > 0 && canUnlock(r.until, height) && r.id);
  const readySats = ready.reduce((s, r) => s + r.satoshis, 0);

  const claim = async () => {
    setBusy(true);
    try {
      const res = await unlockBsv.execute(apiContext, { ids: ready.map((r) => r.id!) });
      if ('error' in res && res.error)
        throw new Error(res.error === 'no-matured-locks' ? 'Nothing is ready to claim yet.' : res.error);
      addSnackbar(`Claimed ${fmtBsv(readySats)} back to your wallet.`, 'success');
      await reload();
      changed.current();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Claim failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const line = bsvScanLine(state);
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
      {ready.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void claim()}
          className="self-start flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          <Unlock size={13} /> {busy ? 'Claiming…' : `Claim ${fmtBsv(readySats)}`}
        </button>
      )}
    </div>
  );
};

export default BsvLocksSection;
