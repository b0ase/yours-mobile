import { useContext, useEffect, useRef, useState } from 'react';
import { askDue, TRUTH_MIN_GAP_MS, truthLines, type BalanceTruth, type TruthLine } from '../services/balanceTruth';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { TruthLinesOn } from './truthLinesContext';

const MUTED = 'var(--bw-muted, #98A2B3)';
const GOLD = 'var(--bw-accent, #D4AF37)';
const RED = 'var(--bw-danger, #F97066)';
/** How often the lines are asked for again while the wallet is in view (the sync line's "N min ago" moves too). */
export const TRUTH_POLL_MS = 60_000;
/** A failed ask (the wallet still opening) is tried again this soon, once. */
export const TRUTH_RETRY_MS = 5_000;

type Answer = { success?: boolean; data?: BalanceTruth } | undefined;

/** The default ask, defined once (an inline default re-runs the effect every render: moveToDevice.ts). */
const truthSend = (m: object): Promise<Answer> => sendMessageAsync<Answer>(m);

/** The held list's closing line: true for a payment held back and for one handed to someone else to send. */
export const HELD_NOTE = 'Waiting to be confirmed sent. Its coins stay set aside until it confirms or is released.';

/**
 * The lines themselves (pure: tests render this). One small line each; the held line opens a short list of the
 * payments holding the coins. Nothing renders when there is nothing to say. `announce`: changes are read out politely
 * (set only after the first answer, so opening the wallet reads nothing out).
 */
export const BalanceTruthView = ({
  lines,
  align = 'center',
  fmt,
  announce = false,
}: {
  lines: TruthLine[];
  align?: 'center' | 'left';
  fmt: (sats: number) => string;
  announce?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  return (
    <div
      className="bw-truth-lines"
      data-testid="balance-truth"
      aria-live={announce ? 'polite' : undefined}
      style={{ textAlign: align, marginTop: 6, fontSize: 11, lineHeight: 1.5 }}
    >
      {lines.map((l) =>
        l.kind === 'held' ? (
          <div key="held">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => !o);
              }}
              aria-expanded={open}
              className="bw-truth-held border-0 bg-transparent p-0 cursor-pointer"
              style={{ color: GOLD, fontSize: 11, fontWeight: 600 }}
            >
              {l.text}
            </button>
            {open && (
              <div
                className="bw-truth-list"
                style={{ textAlign: 'left', marginTop: 4, color: MUTED, display: 'inline-block', maxWidth: '100%' }}
              >
                {l.payments.map((p) => (
                  <div key={p.txid || `${p.createdAt}-${p.sats}`} className="flex gap-2 justify-between">
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap select-text">
                      {p.description || 'Payment'}
                      {p.count > 1 ? ` (+${p.count - 1} linked)` : ''}
                      {p.createdAt
                        ? ` · ${new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                        : ''}
                    </span>
                    <span style={{ flexShrink: 0 }}>{fmt(p.sats)}</span>
                  </div>
                ))}
                <div style={{ marginTop: 2 }}>{HELD_NOTE}</div>
              </div>
            )}
          </div>
        ) : (
          <div
            key={l.kind}
            className={`bw-truth-${l.kind}${l.kind === 'sync' && l.warn ? ' is-warn' : ''}`}
            style={{ color: l.kind === 'sync' && l.warn ? RED : MUTED, fontWeight: l.kind === 'arriving' ? 600 : 400 }}
          >
            {l.text}
          </div>
        ),
      )}
    </div>
  );
};

/**
 * The balance card's truth lines (services/balanceTruth.ts), on the phone's Wallet card and the extension's balance.
 * Asks the wallet (BALANCE_TRUTH) on mount, when the page comes back into view, every minute while in view, and when
 * `refreshKey` changes (the balance moved; at most once per TRUTH_MIN_GAP_MS); a failed ask is retried once shortly.
 * Shows nothing until it knows, and nothing at all where TruthLinesOn is false (the All cards view).
 */
export const BalanceTruthLines = ({
  fmt,
  hidden = false,
  refreshKey,
  align,
  send = truthSend,
}: {
  /** Satoshis in the card's unit ("$1.20" or "120,000 sats"). */
  fmt: (sats: number) => string;
  /** Balance hidden: the money lines are left out. */
  hidden?: boolean;
  refreshKey?: unknown;
  align?: 'center' | 'left';
  send?: (m: object) => Promise<Answer>;
}) => {
  const on = useContext(TruthLinesOn);
  const [truth, setTruth] = useState<BalanceTruth | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastAsk = useRef(0);
  const askRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!on) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const ask = (again = true) => {
      if (!visible()) return;
      lastAsk.current = Date.now();
      void send({ action: 'BALANCE_TRUTH' })
        .then((r) => {
          if (!live) return;
          setNow(Date.now());
          if (r?.success && r.data) setTruth(r.data);
          else if (again) retry = setTimeout(() => ask(false), TRUTH_RETRY_MS);
        })
        .catch(() => {
          if (live && again) retry = setTimeout(() => ask(false), TRUTH_RETRY_MS);
        });
    };
    askRef.current = () => ask();
    ask();
    const t = setInterval(() => ask(), TRUTH_POLL_MS);
    const onVis = () => {
      if (visible()) ask();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      live = false;
      clearInterval(t);
      if (retry) clearTimeout(retry);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      askRef.current = () => undefined;
    };
  }, [send, on]);

  // The balance moved: ask again, throttled (the first render's ask is the mount's).
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    const wait = TRUTH_MIN_GAP_MS - (Date.now() - lastAsk.current);
    if (askDue(lastAsk.current, Date.now())) {
      askRef.current();
      return;
    }
    // Too soon after the last ask: once, when the gap is up (a later change replaces this one).
    const t = setTimeout(() => askRef.current(), Math.max(0, wait));
    return () => clearTimeout(t);
  }, [refreshKey]);

  if (!on) return null;
  return (
    <BalanceTruthView
      lines={truthLines(truth, fmt, now, { hideAmounts: hidden })}
      align={align}
      fmt={fmt}
      announce={truth !== null}
    />
  );
};
