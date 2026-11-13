import { useEffect, useState } from 'react';
import { truthLines, type BalanceTruth, type TruthLine } from '../services/balanceTruth';
import { sendMessageAsync } from '../utils/chromeHelpers';

const MUTED = 'var(--bw-muted, #98A2B3)';
const GOLD = 'var(--bw-accent, #D4AF37)';
const RED = 'var(--bw-danger, #F97066)';
/** How often the lines are asked for again while the wallet is in view (the sync line's "N min ago" moves too). */
export const TRUTH_POLL_MS = 60_000;

type Answer = { success?: boolean; data?: BalanceTruth } | undefined;

/** The default ask, defined once (an inline default re-runs the effect every render: moveToDevice.ts). */
const truthSend = (m: object): Promise<Answer> => sendMessageAsync<Answer>(m);

/**
 * The lines themselves (pure: tests render this). One small line each; the held line opens a short list of the
 * payments holding the coins. Nothing renders when there is nothing to say.
 */
export const BalanceTruthView = ({
  lines,
  align = 'center',
  fmt,
}: {
  lines: TruthLine[];
  align?: 'center' | 'left';
  fmt: (sats: number) => string;
}) => {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  return (
    <div
      className="bw-truth-lines"
      data-testid="balance-truth"
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
                      {p.createdAt
                        ? ` · ${new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                        : ''}
                    </span>
                    <span style={{ flexShrink: 0 }}>{fmt(p.sats)}</span>
                  </div>
                ))}
                <div style={{ marginTop: 2 }}>Not sent. Its coins stay set aside until it goes out or is released.</div>
              </div>
            )}
          </div>
        ) : (
          <div
            key={l.kind}
            className={`bw-truth-${l.kind}`}
            role={l.kind === 'sync' && l.warn ? 'alert' : undefined}
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
 * Asks the wallet (BALANCE_TRUTH) on mount, whenever `refreshKey` changes (the balance moved) and every minute while
 * in view; shows nothing until it knows.
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
  const [truth, setTruth] = useState<BalanceTruth | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const ask = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void send({ action: 'BALANCE_TRUTH' })
        .then((r) => {
          if (!live) return;
          setNow(Date.now());
          if (r?.success && r.data) setTruth(r.data);
        })
        .catch(() => undefined);
    };
    ask();
    const t = setInterval(ask, TRUTH_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [send, refreshKey]);
  return <BalanceTruthView lines={truthLines(truth, fmt, now, { hideAmounts: hidden })} align={align} fmt={fmt} />;
};
