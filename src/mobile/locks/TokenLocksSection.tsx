/**
 * Pots & Locks › Locks › Token locks: every BSV-21 token lock of this wallet, whatever the token, so a lock
 * whose token has no row in the Wallet (all of it locked, or a restored wallet) can still be seen and
 * unlocked. "Find my token locks" rebuilds the list from the chain (tokenLockApi.findTokenLocks).
 */
import { useCallback, useState } from 'react';
import { Search, Unlock } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { fmtToken } from './receipt';
import { canUnlock, countdown, loadTokenLocks, type TokenLockRecord } from './tokenLocks';
import { unlockTokenLock } from './tokenLockApi';
import { scanLine, useTokenLockScan } from './useTokenLockScan';

const GOLD = 'var(--bw-accent)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#F97066';
const GREEN = '#32D583';

export const TokenLocksSection = ({ height }: { height: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const account = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress ?? '';
  const [locks, setLocks] = useState<TokenLockRecord[]>(() => loadTokenLocks(account, chromeStorageService));
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(
    () => setLocks(loadTokenLocks(account, chromeStorageService)),
    [account, chromeStorageService],
  );
  const { state, run } = useTokenLockScan(apiContext, account, chromeStorageService, reload, true);
  const line = scanLine(state);
  const sorted = [...locks].sort((a, b) => Number(!!a.unlockedTxid) - Number(!!b.unlockedTxid) || a.until - b.until);

  const doUnlock = async (r: TokenLockRecord) => {
    setBusy(r.outpoint);
    try {
      const txid = await unlockTokenLock(apiContext, account, r, chromeStorageService);
      addSnackbar(`Unlocked. ${r.sym || 'Tokens'} are back in your wallet (${txid.slice(0, 8)}…).`, 'success');
      reload();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Unlock failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold" style={{ color: MUTED }}>
          Token locks
        </div>
        <button
          type="button"
          disabled={state.kind === 'scanning'}
          onClick={() => void run()}
          className="flex items-center gap-1 text-xs font-bold"
          style={{ color: state.kind === 'scanning' ? MUTED : GOLD }}
        >
          <Search size={13} /> {state.kind === 'scanning' ? 'Searching…' : 'Find my token locks'}
        </button>
      </div>
      {line && (
        <div className="text-xs" style={{ color: state.kind === 'error' ? RED : MUTED }}>
          {line}
        </div>
      )}
      {sorted.map((r) => {
        const open = !r.unlockedTxid && height > 0 && canUnlock(r.until, height);
        return (
          <div
            key={r.outpoint}
            className="rounded-2xl p-3 flex flex-col gap-2"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <div className="flex justify-between gap-2">
              <span className="text-sm font-bold text-white truncate">{r.label}</span>
              <span className="text-sm text-white">{fmtToken(r)}</span>
            </div>
            <div className="flex justify-between text-xs" style={{ color: MUTED }}>
              <span>Block {r.until}</span>
              <span style={{ color: r.unlockedTxid ? MUTED : open ? GREEN : GOLD }}>
                {r.unlockedTxid ? 'Unlocked' : height ? countdown(r.until, height) : '…'}
              </span>
            </div>
            {open && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void doUnlock(r)}
                className="self-start flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                <Unlock size={13} /> {busy === r.outpoint ? 'Unlocking…' : 'Unlock'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default TokenLocksSection;
