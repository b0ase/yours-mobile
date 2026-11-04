import { useCallback, useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { nextTryText } from './moveToDevice';

/** What the background says about moving this account's records to this device (STORAGE_MOVE_STATUS). */
export type MoveStatus = {
  onDevice: boolean;
  moving: boolean;
  failures: number;
  nextRetryAt: number;
  reason: string | null;
};

type Answer = { success?: boolean; data?: MoveStatus; error?: string } | undefined;

/**
 * Review 4 Nov 2026 (F4): no payment builds change while this account is still on the online backup store
 * (services/localFirst.ts). If the move to this device hasn't finished, say so plainly and offer the retry now, never a
 * silent refusal. Renders nothing once the account is on this device.
 */
export const MoveToDeviceNotice = ({
  send = (m: object) => sendMessageAsync<Answer>(m),
  pollMs = 60_000,
}: {
  send?: (m: object) => Promise<Answer>;
  pollMs?: number;
}) => {
  const [status, setStatus] = useState<MoveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const r = await send({ action: 'STORAGE_MOVE_STATUS' }).catch((): Answer => undefined);
    if (r?.success && r.data) setStatus(r.data);
  }, [send]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  if (!status || status.onDevice) return null;

  const retry = async () => {
    setBusy(true);
    setNote('Moving this account to this device…');
    const r = await send({ action: 'STORAGE_MOVE_TO_DEVICE' }).catch(
      (e: unknown): Answer => ({ success: false, error: e instanceof Error ? e.message : String(e) }),
    );
    if (r?.data) setStatus(r.data);
    setNote(
      r?.success ? 'Done: this account is on this device now.' : `Not moved yet${r?.error ? ` (${r.error})` : ''}.`,
    );
    setBusy(false);
  };

  return (
    <div
      role="status"
      className="rounded-xl p-3 mt-2 mb-2 text-xs leading-relaxed"
      style={{
        background: 'rgba(245,158,11,0.10)',
        border: '1px solid rgba(245,158,11,0.4)',
        color: 'var(--bw-text, #FFFFFF)',
      }}
    >
      <div className="flex items-start gap-2">
        <Smartphone size={16} color="#F59E0B" aria-hidden="true" style={{ flexShrink: 0 }} />
        <span>
          This account is still kept on the online backup. Payments wait until its records move to this device, so the
          change from each payment is made and kept here.
          {status.moving ? ' Moving now…' : ''}
          {!status.moving && status.failures > 0
            ? ` The last try didn't finish${status.reason ? ` (${status.reason})` : ''}. ${nextTryText(status.nextRetryAt)}`
            : ''}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={busy || status.moving}
        className="mt-2 w-full min-h-[36px] cursor-pointer rounded-lg border-0 text-xs font-bold disabled:opacity-50"
        style={{ background: 'linear-gradient(180deg,#FFD84D,#E8A100)', color: '#111' }}
      >
        {busy ? 'Moving…' : 'Retry moving this account to this device'}
      </button>
      {note && (
        <p className="m-0 mt-1" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
          {note}
        </p>
      )}
    </div>
  );
};
