import { useCallback, useEffect, useState } from 'react';
import { Lock as LockIcon } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { openDappBrowser } from '../../dappBrowser';
import { ErrorActions } from '../../errors/ErrorActions';
import {
  VEST_MAX_BPS,
  VEST_MAX_MONTHS,
  VEST_MIN_MONTHS,
  keptAmount,
  monthsUntil,
  scheduleSummary,
  trancheCount,
  validateVestPlan,
  type VerifiedVesting,
  type VestPlan,
} from './vesting';
import { claimVesting, fetchVesting, listVesting, vestTxUrl, type VestRow } from './vestingNet';

const GOLD = 'var(--bw-accent)';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const fmtAmt = (n: bigint) => n.toLocaleString('en-US');

/** Launch form: "Keep for yourself" slider (0–20%, default 10%) and the lock schedule. */
export const KeepForYourself = ({
  plan,
  onChange,
  supply,
}: {
  plan: VestPlan;
  onChange: (p: VestPlan) => void;
  supply: bigint;
}) => {
  const pct = plan.keepBps / 100;
  const err = validateVestPlan(plan);
  const months = (k: 'cliffMonths' | 'linearMonths', v: string) =>
    onChange({ ...plan, [k]: Math.min(VEST_MAX_MONTHS, Number(v.replace(/\D/g, '') || '0')) });
  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent text-white mt-1';
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: LINE }}>
      <label className="flex items-center justify-between text-sm font-bold text-white">
        <span className="flex items-center gap-2">
          <LockIcon size={14} color={GOLD} /> Keep for yourself
        </span>
        <span style={{ color: GOLD }}>{pct}%</span>
      </label>
      <input
        type="range"
        aria-label="Keep for yourself"
        min={0}
        max={VEST_MAX_BPS / 100}
        step={1}
        value={pct}
        onChange={(e) => onChange({ ...plan, keepBps: Number(e.target.value) * 100 })}
      />
      {plan.keepBps === 0 ? (
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          You keep no locked share. The whole supply lands in your wallet.
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            <label className="flex-1 text-xs" style={{ color: MUTED }}>
              Cliff (months)
              <input
                className={input}
                style={{ borderColor: LINE }}
                inputMode="numeric"
                value={String(plan.cliffMonths)}
                onChange={(e) => months('cliffMonths', e.target.value)}
              />
            </label>
            <label className="flex-1 text-xs" style={{ color: MUTED }}>
              Then unlock over (months)
              <input
                className={input}
                style={{ borderColor: LINE }}
                inputMode="numeric"
                value={String(plan.linearMonths)}
                onChange={(e) => months('linearMonths', e.target.value)}
              />
            </label>
          </div>
          <p className="text-[11px] m-0" style={{ color: MUTED }}>
            {fmtAmt(keptAmount(supply, plan.keepBps))} coins locked to a key from your own recovery phrase:{' '}
            {scheduleSummary(plan)} ({trancheCount(plan)} on-chain lock{trancheCount(plan) === 1 ? '' : 's'}). Nobody
            can move them early, not you and not bWalletX. At least {VEST_MIN_MONTHS} months. A public receipt goes on
            chain with them.
          </p>
          {err && (
            <p className="text-xs m-0" style={{ color: '#FF6B6B' }}>
              {err}
            </p>
          )}
        </>
      )}
    </div>
  );
};

/** Token page: the creator's public vesting receipt (checked on chain) and, for the creator, Claim. */
export const CreatorVesting = ({ tokenId }: { tokenId: string }) => {
  const { apiContext } = useServiceContext();
  const [pub, setPub] = useState<VerifiedVesting | null | undefined>(undefined);
  const [mine, setMine] = useState<VestRow[]>([]);
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    void fetchVesting(tokenId)
      .then(setPub)
      .catch(() => setPub(null));
    void listVesting(apiContext, tokenId)
      .then(setMine)
      .catch(() => setMine([]));
    void apiContext.services?.chaintracks
      .currentHeight()
      .then((h) => setHeight(h || 0))
      .catch(() => setHeight(0));
  }, [apiContext, tokenId]);
  useEffect(load, [load]);

  const due = height > 0 ? mine.filter((r) => r.until <= height) : [];
  const claim = async () => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const r = await claimVesting(apiContext, tokenId);
      setMsg(`Claimed ${fmtAmt(r.amt)}. Txid ${r.txid}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (pub === undefined && mine.length === 0) return null;
  const r = pub?.receipt;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border p-3" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-2 text-sm font-bold text-white">
        <LockIcon size={14} color={GOLD} /> Creator vesting
      </div>
      {pub && r ? (
        <>
          <p className="text-xs m-0" style={{ color: MUTED }}>
            The creator locked {fmtAmt(pub.kept)} ({r.keepBps / 100}% of the supply): {scheduleSummary(r)}. Checked on
            chain: every lock below is in the transaction.
          </p>
          <ul className="m-0 p-0 list-none flex flex-col gap-0.5 max-h-40 overflow-y-auto">
            {pub.tranches.map((t, i) => (
              <li key={i} className="flex justify-between text-[11px]" style={{ color: MUTED }}>
                <span>
                  Block {t.height.toLocaleString('en-US')}
                  {height > 0 &&
                    (t.height <= height ? ' · open' : ` · in ~${monthsUntil(t.height, height).toFixed(1)} months`)}
                </span>
                <span className="text-white">{fmtAmt(t.amt)}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void openDappBrowser(vestTxUrl(pub.txid))}
            className="self-start text-xs font-semibold bg-transparent border-0 p-0 cursor-pointer"
            style={{ color: GOLD }}
          >
            View the receipt on chain ›
          </button>
        </>
      ) : (
        pub === null && (
          <p className="text-xs m-0" style={{ color: MUTED }}>
            No checked creator vesting found on chain for this coin.
          </p>
        )
      )}
      {mine.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: LINE }}>
          <span className="text-xs text-white font-semibold">
            Your locks: {mine.length} · {due.length} open
          </span>
          {error && (
            <div className="flex flex-col gap-1">
              <p className="text-xs m-0 break-words" style={{ color: '#FF6B6B' }}>
                {error}
              </p>
              <ErrorActions message={error} />
            </div>
          )}
          {msg && <p className="text-xs m-0 break-all text-[#A1FF8B]">{msg}</p>}
          <button
            type="button"
            disabled={busy || due.length === 0}
            onClick={() => void claim()}
            className="bw-pill bw-pill-gold min-h-[40px] w-full text-sm font-bold disabled:opacity-50"
          >
            {busy
              ? 'Claiming…'
              : due.length > 0
                ? `Claim ${fmtAmt(due.reduce((n, x) => n + x.amt, 0n))}`
                : `Next unlock at block ${mine[0].until.toLocaleString('en-US')}`}
          </button>
        </div>
      )}
    </div>
  );
};
