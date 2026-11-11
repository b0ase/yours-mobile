import { useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { FindMissingCoins, type ScanAnswer } from './FindMissingCoins';
import { useTheme } from '../hooks/useTheme';
import { useRecoveryTools } from '../hooks/useRecoveryTools';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { VersionLabel } from './VersionLabel';
import { needsLookSummary, syncFailureText, type RefreshStepKey } from './refreshWalletText';

type SyncAnswer = { success?: boolean; error?: string };
type StepState = 'waiting' | 'running' | 'ok' | 'failed';
/** raw: the technical error behind a failed row (shown under Details); found: the rescan found coins to add back. */
type Step = { key: RefreshStepKey; title: string; state: StepState; text: string; raw?: string; found?: boolean };
type StepResult = { ok: boolean; text: string; raw?: string; found?: boolean };

const STEPS: { key: RefreshStepKey; title: string }[] = [
  { key: 'sync', title: 'Sync with my other devices' },
  { key: 'resync', title: 'Resync coins' },
  { key: 'missing', title: 'Rescan the chain' },
];

// Green with white text, AA at any size (owner, 25 Oct 2026: green, "REFRESH WALLET", was a red DON'T PANIC!).
const GREEN = '#15803D';

/**
 * Wallet home, at the very bottom (owner, 25 Oct 2026): one green REFRESH WALLET button. It runs the safe recovery
 * routines in order (Sync with my other devices → Resync coins → Find missing coins, scan only)
 * with a checklist, carrying on past a failed step. It never sends or moves money, never changes which store is active (so no Find mined payments, which can, and no Repair Sync, which can resend or drop token outputs), and
 * never runs Restore from backup and never skips a confirm:
 * coins found by the scan wait for the usual "Add it back" sheet. Recover by txid needs a transaction ID, so it is
 * offered after the run. Every tool also lives on its own in Settings › Storage and Troubleshooting (shared code:
 * useRecoveryTools, FindMissingCoins).
 */
export const HomeShortcuts = () => {
  const { theme } = useTheme();
  const t = useRecoveryTools();
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [scan, setScan] = useState<ScanAnswer['data'] | null>(null);
  const [details, setDetails] = useState<RefreshStepKey | null>(null);

  const set = (key: RefreshStepKey, state: StepState, r: Omit<StepResult, 'ok'> = { text: '' }) =>
    setSteps((p) => (p ?? []).map((s) => (s.key === key ? { ...s, state, ...r } : s)));

  const run = async () => {
    if (running) return;
    setRunning(true);
    setScan(null);
    setDetails(null);
    setSteps(STEPS.map((s) => ({ ...s, state: 'waiting', text: '' })));
    const attempt = async (key: RefreshStepKey, fn: () => Promise<StepResult>) => {
      set(key, 'running');
      try {
        const { ok, ...r } = await fn();
        set(key, ok ? 'ok' : 'failed', r);
      } catch (e) {
        const raw = e instanceof Error ? e.message : 'Failed';
        set(key, 'failed', { text: key === 'sync' ? syncFailureText(raw) : raw, raw });
      }
    };
    // Same message as the Remote backup screen's "Sync with my other devices": pull, then push (services/deviceSync.ts).
    await attempt('sync', async () => {
      const r = await sendMessageAsync<SyncAnswer>({ action: 'STORAGE_SYNC_BACKUPS' });
      if (r?.success) return { ok: true, text: 'Synced with your other devices · just now' };
      // Plain words on the row; the raw error behind Details (owner, 11 Nov 2026: "An internal error has occurred").
      const raw = r?.error ?? 'Sync failed';
      return { ok: false, text: syncFailureText(raw), raw };
    });
    await attempt('resync', () => t.handleResyncCoins());
    // Scan only (read only); any restore waits for the user's "Add it back" below.
    await attempt('missing', async () => {
      const r = await sendMessageAsync<ScanAnswer>({ action: 'STORAGE_FIND_MISSING_COINS' });
      if (!r?.success || !r.data) return { ok: false, text: r?.error ?? 'No answer from the wallet. Try again.' };
      setScan(r.data);
      const n = r.data.report.found.length;
      return n
        ? { ok: false, text: `${r.data.headline} Check below to add it back.`, found: true }
        : { ok: true, text: [r.data.headline, r.data.note].filter(Boolean).join(' ') };
    });
    setRunning(false);
  };

  const done = steps && !running;
  // Every row that needs a look is named with its next step (owner, 11 Nov 2026: "1 thing needs a look", but which?).
  const look = needsLookSummary((steps ?? []).filter((s) => s.state === 'failed'));

  return (
    <div className="bw-home-shortcuts w-[92%] space-y-3" data-testid="home-shortcuts">
      <button
        type="button"
        data-testid="dont-panic"
        onClick={() => void run()}
        disabled={running}
        className="w-full rounded-xl py-4 text-xl font-bold tracking-wide"
        style={{ background: GREEN, color: '#FFFFFF', opacity: running ? 0.8 : 1 }}
      >
        {running ? 'Refreshing…' : 'REFRESH WALLET'}
      </button>
      {!steps && (
        <p className="text-[11px] text-center" style={{ color: '#D0D5DD' }}>
          Coins or tokens look wrong? One tap checks everything safely. Nothing is sent.
        </p>
      )}
      {steps && (
        <div
          className="rounded-xl p-4 space-y-2 bg-[var(--bw-surface)]"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <ol className="space-y-2" aria-label="Checklist">
            {steps.map((s) => (
              <li key={s.key} className="flex items-start gap-2.5" data-state={s.state}>
                <span className="shrink-0 mt-0.5">
                  {s.state === 'ok' ? (
                    <CheckCircle2 size={16} style={{ color: '#22c55e' }} />
                  ) : s.state === 'failed' ? (
                    <AlertCircle size={16} style={{ color: '#FDB022' }} />
                  ) : s.state === 'running' ? (
                    <Loader2 size={16} className="animate-spin" style={{ color: '#FDB022' }} />
                  ) : (
                    <Circle size={16} style={{ color: '#667085' }} />
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold" style={{ color: '#F2F4F7' }}>
                    {s.title}
                  </p>
                  {(s.text || s.state === 'running') && (
                    <p className="text-[10px] leading-snug break-words" style={{ color: '#D0D5DD' }}>
                      {s.state === 'running' ? 'Checking…' : s.text}
                    </p>
                  )}
                  {s.state === 'failed' && s.raw && s.raw !== s.text && (
                    <>
                      <button
                        type="button"
                        className="text-[10px] underline"
                        style={{ color: '#D0D5DD' }}
                        aria-expanded={details === s.key}
                        data-testid={`refresh-details-${s.key}`}
                        onClick={() => setDetails((d) => (d === s.key ? null : s.key))}
                      >
                        {details === s.key ? 'Hide details' : 'Details'}
                      </button>
                      {details === s.key && (
                        <p className="text-[10px] leading-snug break-words font-mono" style={{ color: '#98A2B3' }}>
                          {s.raw}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {done && (
            <div role="status" className="pt-1 space-y-1" data-testid="refresh-needs-look">
              <p className="text-sm font-semibold" style={{ color: '#F2F4F7' }}>
                {look.heading}
              </p>
              {look.lines.length > 0 && (
                <ul className="space-y-1">
                  {look.lines.map((line) => (
                    <li key={line} className="text-[11px] leading-snug break-words" style={{ color: '#D0D5DD' }}>
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {done && scan && scan.report.found.length > 0 && <FindMissingCoins initialScan={scan} />}
      {done && (
        <div
          className="rounded-xl p-4 space-y-2 bg-[var(--bw-surface)]"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}
          data-testid="dont-panic-txid"
        >
          <p className="text-xs font-semibold" style={{ color: '#F2F4F7' }}>
            Have a transaction ID? Paste it
          </p>
          <p
            className={`text-[10px] leading-snug break-words${t.recoverTxidOk ? ' font-semibold' : ''}`}
            style={{ color: t.recoverTxidOk ? '#22c55e' : '#D0D5DD' }}
          >
            {t.recoveringTxid
              ? `${t.recoverStep.txid ?? 'Checking…'}${t.elapsed('txid')}`
              : t.recoverTxidResult || 'Money on chain that never showed up here? Only coins proven yours are added.'}
          </p>
          <div className="flex gap-2">
            <Input
              theme={theme}
              id="home-recover-txid"
              placeholder="Transaction ID"
              value={t.recoverTxid}
              onChange={(e) => t.setRecoverTxid(e.target.value)}
              style={{ flex: 1, margin: 0 }}
            />
            <Button
              theme={theme}
              type="primary"
              style={{ background: '#FDB022', color: '#0A0A0B' }}
              label={t.recoveringTxid ? 'Checking…' : t.recoverFailedTxid ? 'Try again' : 'Recover'}
              disabled={!t.txidValid || t.recoveringTxid}
              onClick={() => void t.handleRecoverTxid()}
            />
          </div>
        </div>
      )}
      {/* The last thing on the home (owner, 25 Oct 2026): nothing scrolls past REFRESH WALLET but the version. */}
      <VersionLabel className="pt-2 text-center" />
    </div>
  );
};
