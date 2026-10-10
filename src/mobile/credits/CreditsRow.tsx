import { useCallback, useEffect, useState } from 'react';
import { paidFeaturesEnabled } from '../storeBuild';
import { useBackClose } from '../backStack';
import { createPortal } from 'react-dom';
import { sendBsv21 } from '@1sat/actions';
import { Coins, History, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { walletHoldings } from '../chat/holdings';
import { ChatApiError } from '../chat/api';
import { signedInClient } from '../kyc/kycWallet';
import {
  CREDITS_TERMS,
  addPending,
  depositOutcome,
  entryAmount,
  entryLabel,
  loadPending,
  parseAmount,
  parseCreditsInfo,
  parseLedger,
  rawAmount,
  removePending,
  savePending,
  topUpCheck,
  topUpCost,
  type CreditEntry,
  type CreditsInfo,
  type Pending,
} from './credits';
import { moneyNow } from '../money/money';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * Wallet tab "Credits" row (build-time insert into BsvWallet.tsx, vite.config.mobile.ts):
 * in-app $BCREDIT balance, Top up, history. Top up sends $BCREDIT to the bApp treasury with
 * the wallet's normal approval (sendBsv21), then posts the txid to bit-sign. Until bit-sign
 * has a token id + treasury configured, the row says "coming soon". The balance loads on its own:
 * the wallet signs in to bit-sign silently with its key, so the user never signs in.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4 max-h-[80vh] overflow-y-auto"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** Hidden in a store build (no paying bCorp in the app, storeBuild.ts). */
export const CreditsRow = () => (paidFeaturesEnabled() ? <CreditsRowInner /> : null);

const CreditsRowInner = () => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [info, setInfo] = useState<CreditsInfo | null>(null);
  const [pending, setPending] = useState<Pending>(loadPending);
  const [sheet, setSheet] = useState<'topup' | 'history' | null>(null);

  const updatePending = (fn: (p: Pending) => Pending) =>
    setPending((p) => {
      const next = fn(p);
      savePending(next);
      return next;
    });

  const refresh = useCallback(async () => {
    if (!apiContext) return;
    try {
      // Silent: the wallet signs in with its own key, the user never sees bit-sign.
      const client = await signedInClient(apiContext);
      setInfo(parseCreditsInfo(await client.credits()));
      // Retry top-ups the indexer had not validated yet.
      for (const p of loadPending()) {
        try {
          if (depositOutcome(200, await client.depositCredits(p.txid)) !== 'pending') {
            updatePending((x) => removePending(x, p.txid));
          }
        } catch (e) {
          // A 4xx is the server refusing this txid for good; network / 5xx stays pending.
          const st = e instanceof ChatApiError ? e.status : 0;
          if (st >= 400 && st < 500 && st !== 401) updatePending((x) => removePending(x, p.txid));
        }
      }
      setInfo(parseCreditsInfo(await client.credits()));
    } catch (e) {
      console.warn('[credits] read failed:', e);
      setInfo((i) => i ?? parseCreditsInfo(null));
    }
  }, [apiContext]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabled = !!info?.enabled;
  const pendingCredits = pending.reduce((n, p) => n + p.credits, 0);

  return (
    <>
      <div className="w-full px-4 mt-3">
        <div
          className="flex items-center gap-3 rounded-2xl px-4 py-3"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        >
          <Coins size={18} color={GOLD} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white">Credits</div>
            <div className="text-[11px]" style={{ color: MUTED }}>
              {!info
                ? 'Loading…'
                : enabled
                  ? `${info.balance.toLocaleString('en-US')} available${pendingCredits ? ` · ${pendingCredits} pending` : ''}`
                  : 'Coming soon'}
            </div>
          </div>
          {enabled && (
            <>
              <button onClick={() => setSheet('history')} aria-label="Credit history" className="p-2">
                <History size={18} color={MUTED} />
              </button>
              <button
                onClick={() => setSheet('topup')}
                className="rounded-xl px-3 py-1.5 text-xs font-bold"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Top up
              </button>
            </>
          )}
        </div>
      </div>
      {sheet === 'topup' && info && (
        <TopUpSheet
          info={info}
          onClose={() => setSheet(null)}
          onSent={(txid, credits, outcome) => {
            if (outcome === 'pending') updatePending((p) => addPending(p, txid, credits));
            addSnackbar(
              outcome === 'credited' ? `Added ${credits} credits` : `Sent. ${credits} credits will appear shortly`,
              'success',
            );
            setSheet(null);
            void refresh();
          }}
        />
      )}
      {sheet === 'history' && <HistorySheet onClose={() => setSheet(null)} />}
    </>
  );
};

const TopUpSheet = ({
  info,
  onClose,
  onSent,
}: {
  info: CreditsInfo;
  onClose: () => void;
  onSent: (txid: string, credits: number, outcome: 'credited' | 'pending') => void;
}) => {
  const { apiContext } = useServiceContext();
  const [input, setInput] = useState('');
  const [heldRaw, setHeldRaw] = useState<bigint | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!apiContext || !info.tokenId) return;
    void walletHoldings(apiContext)
      .then((hs) => {
        const h = hs.find((x) => x.id === info.tokenId);
        setHeldRaw(BigInt(h?.amountRaw ?? '0'));
      })
      .catch(() => setHeldRaw(null));
  }, [apiContext, info.tokenId]);

  const parsed = parseAmount(input);
  const credits = parsed.ok ? parsed.credits : 0;
  const cost = topUpCost(credits, info.priceSats);
  const held = heldRaw === null ? null : Number(heldRaw / BigInt(10) ** BigInt(info.decimals));

  const send = async () => {
    if (!parsed.ok) return setError(parsed.error);
    const block = topUpCheck(info, parsed.credits, heldRaw);
    if (block) return setError(block);
    if (!apiContext || !info.tokenId || !info.treasury) return;
    setError('');
    setBusy('Sending…');
    try {
      const res = await sendBsv21.execute(apiContext, {
        tokenId: info.tokenId,
        recipients: [{ amount: rawAmount(parsed.credits, info.decimals), destination: { address: info.treasury } }],
      });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
      setBusy('Recording…');
      let outcome: 'credited' | 'pending' = 'pending';
      try {
        const client = await signedInClient(apiContext);
        outcome = depositOutcome(200, await client.depositCredits(res.txid)) === 'credited' ? 'credited' : 'pending';
      } catch {
        outcome = 'pending'; // sent on-chain; the row retries posting the txid
      }
      onSent(res.txid, parsed.credits, outcome);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Sheet title="Top up credits" onClose={onClose}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Send $BCREDIT from this wallet to use in bCorp apps.
        {held !== null && ` You hold ${held.toLocaleString('en-US')} $BCREDIT.`}
      </p>
      <div
        className="flex items-center gap-2 rounded-2xl px-3"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <input
          autoFocus
          inputMode="numeric"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Credits"
          className="flex-1 bg-transparent py-3 text-white outline-none"
        />
        <span className="text-xs" style={{ color: MUTED }}>
          $BCREDIT
        </span>
      </div>
      <div className="text-xs mt-2" style={{ color: MUTED }}>
        {cost !== null
          ? `Costs ${moneyNow(cost)} at ${moneyNow(info.priceSats ?? 0)} per credit`
          : info.priceSats
            ? ''
            : 'Price not set yet'}
      </div>
      {error && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs mt-2" style={{ color: '#F97066' }}>
            {error}
          </div>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        onClick={send}
        disabled={!!busy || !input.trim()}
        className="w-full mt-4 rounded-2xl py-3 font-bold disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy || 'Top up'}
      </button>
      <p className="text-[10px] leading-relaxed mt-3 text-center" style={{ color: '#667085' }}>
        {CREDITS_TERMS}
      </p>
    </Sheet>
  );
};

const HistorySheet = ({ onClose }: { onClose: () => void }) => {
  const { apiContext } = useServiceContext();
  const [rows, setRows] = useState<CreditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!apiContext) return;
    void signedInClient(apiContext)
      .then((c) => c.creditLedger())
      .then((d) => setRows(parseLedger(d)))
      .catch((e) => setError(errText(e)));
  }, [apiContext]);

  return (
    <Sheet title="Credit history" onClose={onClose}>
      {error && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs" style={{ color: '#F97066' }}>
            {error}
          </div>
          <ErrorActions message={String(error)} />
        </div>
      )}
      {!error && !rows && (
        <div className="text-xs" style={{ color: MUTED }}>
          Loading…
        </div>
      )}
      {rows && !rows.length && (
        <div className="text-xs" style={{ color: MUTED }}>
          No credit activity yet.
        </div>
      )}
      {rows?.map((r) => (
        <div
          key={r.id}
          className="flex items-center justify-between py-2"
          style={{ borderBottom: `1px solid ${LINE}` }}
        >
          <div>
            <div className="text-sm text-white">{entryLabel(r)}</div>
            <div className="text-[11px]" style={{ color: MUTED }}>
              {r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}
            </div>
          </div>
          <div className="text-sm font-semibold" style={{ color: r.kind === 'deposit' ? '#32D583' : '#FFFFFF' }}>
            {entryAmount(r)}
          </div>
        </div>
      ))}
    </Sheet>
  );
};
