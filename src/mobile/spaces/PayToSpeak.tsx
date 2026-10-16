/**
 * "Pay $X to speak" for listeners (paySpeak.ts, bit-sign PR #289). bWalletX only — SpaceScreen loads
 * this lazily behind PAY_TO_SPEAK_ENABLED, so a store build never contains it.
 *
 * quote → one approval sheet (fiat + sats) → wallet createAction (payees + memo) → keep the payment on
 * the device → claim → SpaceScreen upgrades the LiveKit connection so the mic works.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Utils } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { fmtSats, money, useBsvUsd } from '../money/money';
import { ErrorActions } from '../errors/ErrorActions';
import {
  claimPending,
  loadPending,
  parseSpeakQuote,
  savePending,
  speakOutputs,
  type LiveKitGrant,
  type PendingSpeak,
  type SpeakClient,
  type SpeakQuote,
} from './paySpeak';

const GOLD = 'var(--bw-accent-hi)';
const POLL_MS = 15_000;

type Props = {
  client: SpeakClient;
  ticker: string;
  role: string;
  /** Called after a successful claim; null livekit = fetch a fresh token. */
  onSeat: (livekit: LiveKitGrant | null) => Promise<void> | void;
};

export default function PayToSpeak({ client, ticker, role, onSeat }: Props) {
  const { apiContext } = useServiceContext();
  const rate = useBsvUsd();
  const [quote, setQuote] = useState<SpeakQuote | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingSpeak | null>(() => loadPending(ticker));
  const claiming = useRef(false);
  const listener = role === 'listener';

  const refresh = useCallback(async () => {
    try {
      const q = parseSpeakQuote(await client.speakQuote(ticker));
      setQuote(q.enabled ? q : null);
    } catch {
      setQuote(null);
    }
  }, [client, ticker]);

  useEffect(() => {
    if (!listener) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [listener, refresh]);

  const claim = useCallback(
    async (p: PendingSpeak) => {
      if (claiming.current) return;
      claiming.current = true;
      setBusy(true);
      const out = await claimPending(client, p, { onFail: (f) => setError(f.message) });
      claiming.current = false;
      setBusy(false);
      if (out.ok) {
        setPending(null);
        setError('');
        setQuote(null);
        try {
          await onSeat(out.claim.livekit);
        } catch (e) {
          setError(`You’re on stage, but the mic couldn’t connect: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      setError(out.failure.message);
      if (out.failure.action === 'drop') setPending(null);
    },
    [client, onSeat],
  );

  // A seat paid for earlier (crash, closed app, failed claim): claim it now.
  useEffect(() => {
    if (pending && listener) void claim(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listener]);

  const pay = async (q: SpeakQuote) => {
    setAsking(false);
    setBusy(true);
    setError('');
    let p: PendingSpeak;
    try {
      const r = await apiContext.wallet.createAction({
        description: `Pay to speak in $${ticker}`,
        outputs: speakOutputs(q),
        options: { randomizeOutputs: false },
      });
      if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
      p = { ticker, quoteId: q.quoteId, txid: r.txid, rawtx: Utils.toHex(r.tx), paidAt: Date.now() };
      savePending(p);
      setPending(p);
    } catch (e) {
      setBusy(false);
      setError(`Payment didn’t go through: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(false);
    await claim(p);
  };

  if (!listener && !pending) return null;
  const price = quote ? money(quote.priceSats, rate) : '';

  return (
    <>
      {listener && quote && !pending && (
        <button
          disabled={busy}
          onClick={() => setAsking(true)}
          className="mx-3 mt-2 self-start rounded-full px-3 py-1 text-xs font-bold"
          style={{ background: GOLD, color: '#010101', opacity: busy ? 0.6 : 1 }}
        >
          Pay {price} to speak
        </button>
      )}

      {pending && (
        <button
          disabled={busy}
          onClick={() => void claim(pending)}
          className="mx-3 mt-2 self-start rounded-full px-3 py-1 text-xs font-semibold"
          style={{ border: `1px solid ${GOLD}`, color: GOLD, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Claiming your seat…' : 'Paid · Retry claiming your seat'}
        </button>
      )}

      {error && (
        <div className="mx-3 mt-2 rounded-xl p-3 text-sm" style={{ background: '#2a0f0f', color: '#fff' }}>
          <span className="select-text">{error}</span>
          <ErrorActions message={`Pay to speak: ${error}`} />
        </div>
      )}

      {asking &&
        quote &&
        createPortal(
          <div
            className="fixed inset-0 z-[420] flex flex-col"
            style={{
              background: CARD.bg,
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <ApprovalCard
              ours
              site="bWalletX"
              siteSub={`$${ticker} · Space`}
              onClose={() => setAsking(false)}
              hero={<PayHero amount={price} sub={fmtSats(quote.priceSats)} />}
              title={
                <>
                  Pay to <span style={{ color: CARD.gold }}>speak</span>
                </>
              }
              primary={{ label: 'Allow', onClick: () => void pay(quote) }}
              secondary={{ label: 'Not now', onClick: () => setAsking(false) }}
            >
              <div className="flex flex-wrap gap-2">
                <Chip>A seat on stage</Chip>
                <Chip>Paid straight to the Space</Chip>
                <Chip>Plus a small network fee</Chip>
              </div>
            </ApprovalCard>
          </div>,
          document.body,
        )}
    </>
  );
}
