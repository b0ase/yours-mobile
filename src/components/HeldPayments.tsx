import { useCallback, useContext, useEffect, useState } from 'react';
import { isHeld, unsentOutcomeText, type QueuedSend, type UnsentOutcome } from '../services/stuckSends';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { TruthLinesOn } from './truthLinesContext';

const MUTED = 'var(--bw-muted, #98A2B3)';
const GOLD = 'var(--bw-accent, #D4AF37)';

type Answer<T> = { success?: boolean; data?: T; error?: string } | undefined;
type Send = (m: object) => Promise<Answer<unknown>>;
const defaultSend: Send = (m) => sendMessageAsync<Answer<unknown>>(m);

/**
 * Payments this device holds back and never sends by itself (task 54 review, round 2): a queued send restored from a
 * backup arrives held, so it can't be sent from a backup's word. Each gets its own "Send now" / "Cancel": nothing
 * happens until the user picks one. Pure (tests render this).
 */
export const HeldPaymentsView = ({
  items,
  fmt,
  hidden = false,
  busy,
  note,
  onSend,
  onCancel,
}: {
  items: Pick<QueuedSend, 'txid' | 'description' | 'satoshis' | 'createdAt'>[];
  fmt: (sats: number) => string;
  hidden?: boolean;
  busy?: string;
  note?: string;
  onSend: (txid: string) => void;
  onCancel: (txid: string) => void;
}) => {
  if (!items.length && !note) return null;
  const n = items.length;
  return (
    <div
      className="bw-held-payments"
      data-testid="held-payments"
      role="group"
      aria-label="Payments not sent"
      style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: MUTED, textAlign: 'left' }}
    >
      {n > 0 && (
        <div style={{ color: GOLD, fontWeight: 600 }}>
          {n === 1 ? 'A payment was never sent from this device' : `${n} payments were never sent from this device`}
        </div>
      )}
      {items.map((p) => (
        <div key={p.txid} className="flex gap-2 items-center justify-between" style={{ marginTop: 4 }}>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap select-text">
            {p.description || 'Payment'}
            {!hidden && typeof p.satoshis === 'number' ? ` · ${fmt(Math.abs(p.satoshis))}` : ''}
          </span>
          <span className="flex gap-1" style={{ flexShrink: 0 }}>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onSend(p.txid)}
              className="rounded-md px-2 py-0.5 border-0 cursor-pointer font-semibold"
              style={{ background: GOLD, color: '#000', fontSize: 11 }}
            >
              {busy === p.txid ? 'Sending…' : 'Send now'}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onCancel(p.txid)}
              className="rounded-md px-2 py-0.5 cursor-pointer bg-transparent"
              style={{ border: `1px solid ${MUTED}`, color: MUTED, fontSize: 11 }}
            >
              Cancel
            </button>
          </span>
        </div>
      ))}
      {n > 0 && (
        <div style={{ marginTop: 2 }}>
          Send it now, or cancel it to get the money back. Your wallet won’t send it by itself.
        </div>
      )}
      {note && (
        <div role="status" style={{ marginTop: 2, color: GOLD }}>
          {note}
        </div>
      )}
    </div>
  );
};

/**
 * The held payments under the balance (phone Wallet card and the extension's balance): asks the wallet (UNSENT_SENDS)
 * on mount and when the page comes back into view, and acts only on the user's own choice.
 */
export const HeldPayments = ({
  fmt,
  hidden = false,
  refreshKey,
  send = defaultSend,
}: {
  fmt: (sats: number) => string;
  hidden?: boolean;
  refreshKey?: unknown;
  send?: Send;
}) => {
  const on = useContext(TruthLinesOn);
  const [items, setItems] = useState<QueuedSend[]>([]);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    try {
      const r = (await send({ action: 'UNSENT_SENDS' })) as Answer<{ queued?: QueuedSend[] }>;
      if (r?.success) setItems((r.data?.queued ?? []).filter(isHeld));
    } catch {
      // the wallet still opening: the next view or balance change asks again
    }
  }, [send]);

  useEffect(() => {
    if (!on) return;
    void load();
    const onVis = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [on, load, refreshKey]);

  const act = async (txid: string, how: 'send' | 'cancel') => {
    setBusy(txid);
    setNote(undefined);
    try {
      const r = (await send({ action: 'UNSENT_SENDS', txid, how })) as Answer<UnsentOutcome>;
      setNote(unsentOutcomeText(r?.success ? r.data : undefined, r?.error));
    } catch (e) {
      setNote(unsentOutcomeText(undefined, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(undefined);
      void load();
    }
  };

  if (!on) return null;
  return (
    <HeldPaymentsView
      items={items}
      fmt={fmt}
      hidden={hidden}
      busy={busy}
      note={note}
      onSend={(t) => void act(t, 'send')}
      onCancel={(t) => void act(t, 'cancel')}
    />
  );
};
