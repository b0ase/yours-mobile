import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as qr from 'qrcode';
import { ArrowLeft, Check, ScanLine, Send } from 'lucide-react';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { playChime } from '../../components/sent/chime';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { Scanner } from '../scan/Scanner';
import { bsvToSats } from '../scan/parseScan';
import type { AnswerHandle, OfferHandle, WalletLike } from '../../vendor/webrtpay/index';
import {
  OFFER_TTL_MS,
  connectFailure,
  createDirectPayClient,
  payOverChannel,
  pendingStore,
  previewOffer,
  receiveHandlers,
  seenStore,
  shortKey,
  validSats,
  type OfferPreview,
  type PayOutcome,
  type PayWallet,
  type Received,
} from './directPay';

/**
 * Phone to phone (prototype, DIRECT_PAY_ENABLED; docs/DIRECT-PAY.md). Lazy chunk: only ScanSheet opens it, behind
 * the inlined flag, so store and default builds carry none of this or the vendored package.
 *
 *   Receive: amount (optional) → offer QR → scan their answer QR → wait → "Received".
 *   Pay:     scanned offer → ONE approval sheet (nothing answered or spent before Pay) → answer QR → paid.
 *
 * If the phones can't connect, nothing was spent: say so and offer a normal send.
 */

const MUTED = '#98A2B3';
const PANEL = '#17191E';
const SATS = 100_000_000;
const big = 'flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl py-3 font-bold border-0';
const fmt = (sats: number) => `${(sats / SATS).toFixed(8).replace(/\.?0+$/, '')} BSV`;

type Props = {
  onClose: () => void;
  /** Normal send fallback: the Send card, prefilled with the amount (no recipient: they type their $name). */
  onSendNormally: (amountSats?: number) => void;
} & ({ mode: 'receive' } | { mode: 'pay'; code: string });

export default function DirectPaySheet(p: Props) {
  useBackClose(true, p.onClose);
  return createPortal(
    <div className="bw-between-bars z-[430] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      {p.mode === 'receive' ? (
        <ReceiveFlow onClose={p.onClose} />
      ) : (
        <PayFlow code={p.code} onClose={p.onClose} onSendNormally={p.onSendNormally} />
      )}
    </div>,
    document.body,
  );
}

const Header = ({ title, onBack }: { title: string; onBack: () => void }) => (
  <div className="flex items-center gap-2 px-2 py-2">
    <button
      onClick={onBack}
      aria-label="Back"
      className="w-11 h-11 flex items-center justify-center bg-transparent border-0"
    >
      <ArrowLeft size={20} color="white" />
    </button>
    <span className="text-[16px] font-bold text-white">{title}</span>
  </div>
);

const useQr = (text: string | null) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return setUrl(null);
    let live = true;
    qr.toDataURL(text, { margin: 1, width: 300, errorCorrectionLevel: 'L' })
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [text]);
  return url;
};

const QrBox = ({ text, alt }: { text: string; alt: string }) => {
  const url = useQr(text);
  return (
    <div className="mx-auto mt-4 rounded-2xl bg-white p-3" style={{ width: 300, maxWidth: '100%' }}>
      {url ? <img src={url} alt={alt} className="block w-full" /> : <div style={{ aspectRatio: '1' }} />}
    </div>
  );
};

const Done = ({ title, line, onClose }: { title: string; line: string; onClose: () => void }) => (
  <div className="mt-10 flex flex-col items-center px-5 text-center">
    <div
      className="flex items-center justify-center rounded-full"
      style={{ width: 72, height: 72, background: CARD.gold, color: '#0B0A08' }}
    >
      <Check size={40} strokeWidth={3} aria-hidden="true" />
    </div>
    <h2 className="m-0 mt-4 text-2xl font-extrabold text-white">{title}</h2>
    <p className="m-0 mt-2 text-sm" style={{ color: MUTED }}>
      {line}
    </p>
    <button onClick={onClose} className={`${big} mt-8`} style={{ background: CARD.gold, color: '#000' }}>
      Done
    </button>
  </div>
);

/** Paste box under a scanner (camera blocked, or testing on one screen). */
const PasteRow = ({ onCode, placeholder }: { onCode: (t: string) => void; placeholder: string }) => {
  const [v, setV] = useState('');
  return (
    <div className="mt-4 flex gap-2">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 min-w-0 rounded-xl px-3 py-2.5 text-sm text-white outline-none"
        style={{ background: PANEL, border: '1px solid #2A2A2C' }}
      />
      <button
        disabled={!v.trim()}
        onClick={() => onCode(v)}
        aria-label="Use pasted code"
        className="w-11 rounded-xl flex items-center justify-center border-0"
        style={{ background: CARD.gold, color: '#000', opacity: v.trim() ? 1 : 0.4 }}
      >
        <ScanLine size={16} />
      </button>
    </div>
  );
};

// ── Receive ────────────────────────────────────────────────────────────────────────────────────────────────────

type RStage =
  | { k: 'amount' }
  | { k: 'offer'; code: string }
  | { k: 'scan'; code: string }
  | { k: 'waiting' }
  | { k: 'done'; r: Received }
  | { k: 'error'; msg: string };

function ReceiveFlow({ onClose }: { onClose: () => void }) {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletLike;
  const client = useMemo(() => createDirectPayClient(wallet), [wallet]);
  const offer = useRef<OfferHandle | null>(null);
  const [stage, setStage] = useState<RStage>({ k: 'amount' });
  const [amount, setAmount] = useState('');
  const sats = amount.trim() ? bsvToSats(amount) : null;
  const amountOk = !amount.trim() || (sats !== null && validSats(sats));

  useEffect(
    () => () => {
      offer.current?.cancel();
      void client.close().catch(() => undefined);
    },
    [client],
  );

  const showCode = async () => {
    try {
      offer.current?.cancel();
      const handlers = receiveHandlers({
        wallet,
        seen: seenStore(),
        onReceived: (r) => {
          playChime();
          setStage({ k: 'done', r });
        },
        onError: (e) => console.warn('[directPay] receive session', e),
      });
      const h = await client.createOfferCode({
        amount: sats ?? undefined,
        expiresInMs: OFFER_TTL_MS,
        handlers,
      });
      offer.current = h;
      setStage({ k: 'offer', code: h.code });
    } catch (e) {
      setStage({ k: 'error', msg: e instanceof Error ? e.message : "Couldn't make a code on this device" });
    }
  };

  const onAnswer = async (text: string) => {
    const h = offer.current;
    if (!h) return;
    setStage({ k: 'waiting' });
    try {
      await h.complete(text.trim());
      // Connected and authenticated; the payment arrives through the handlers (stage → done).
    } catch (e) {
      setStage({ k: 'error', msg: connectFailure(e) });
    }
  };

  if (stage.k === 'done')
    return (
      <>
        <Header title="Phone to phone" onBack={onClose} />
        <Done
          title={stage.r.duplicate ? 'Already received' : `Received ${fmt(stage.r.sats)}`}
          line={`From ${shortKey(stage.r.sender)}. It's in your History as Phone to phone.`}
          onClose={onClose}
        />
      </>
    );

  return (
    <>
      <Header
        title="Phone to phone"
        onBack={stage.k === 'scan' ? () => setStage({ k: 'offer', code: stage.code }) : onClose}
      />
      <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-10">
        {stage.k === 'amount' && (
          <>
            <p className="mt-4 text-sm" style={{ color: MUTED }}>
              Get paid by someone standing next to you. Their phone pays yours directly, with no server in between.
            </p>
            <label className="mt-6 text-sm font-semibold text-white" htmlFor="dp-amount">
              Amount to ask for (optional)
            </label>
            <input
              id="dp-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.001 BSV"
              className="mt-2 rounded-xl px-3 py-3 text-base text-white outline-none"
              style={{ background: PANEL, border: `1px solid ${amountOk ? '#2A2A2C' : '#ff4444'}` }}
            />
            <button
              disabled={!amountOk}
              onClick={() => void showCode()}
              className={`${big} mt-6`}
              style={{ background: CARD.gold, color: '#000', opacity: amountOk ? 1 : 0.4 }}
            >
              Show my code
            </button>
          </>
        )}
        {stage.k === 'offer' && (
          <>
            <p className="mt-2 text-center text-sm" style={{ color: MUTED }}>
              1. They scan this with bWalletX › Scan{sats ? ` (asks for ${fmt(sats)})` : ''}.
            </p>
            <QrBox text={stage.code} alt="Phone to phone code" />
            <p className="mt-4 text-center text-sm" style={{ color: MUTED }}>
              2. After they approve, their phone shows a code. Scan it within 15 seconds.
            </p>
            <button
              onClick={() => setStage({ k: 'scan', code: stage.code })}
              className={`${big} mt-4`}
              style={{ background: CARD.gold, color: '#000' }}
            >
              <ScanLine size={18} /> Scan their code
            </button>
          </>
        )}
        {stage.k === 'scan' && (
          <>
            <Scanner onCode={(t) => void onAnswer(t)} />
            <PasteRow onCode={(t) => void onAnswer(t)} placeholder="Or paste their code" />
          </>
        )}
        {stage.k === 'waiting' && (
          <p className="mt-16 text-center text-base text-white" role="status">
            Connecting to their phone… then waiting for the payment.
          </p>
        )}
        {stage.k === 'error' && (
          <div className="mt-10 flex flex-col">
            <p className="text-base font-semibold text-white">{stage.msg}</p>
            <p className="mt-2 text-sm" style={{ color: MUTED }}>
              Try again with a new code, or ask them to send to your $name instead.
            </p>
            <button
              onClick={() => setStage({ k: 'amount' })}
              className={`${big} mt-6`}
              style={{ background: CARD.gold, color: '#000' }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── Pay ────────────────────────────────────────────────────────────────────────────────────────────────────────

type PStage =
  | { k: 'review'; o: OfferPreview }
  | { k: 'answer'; o: OfferPreview; code: string }
  | { k: 'paying' }
  | { k: 'done'; r: PayOutcome }
  | { k: 'failed'; msg: string; sats?: number }
  | { k: 'bad'; msg: string };

function PayFlow({
  code,
  onClose,
  onSendNormally,
}: {
  code: string;
  onClose: () => void;
  onSendNormally: (amountSats?: number) => void;
}) {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletLike & PayWallet;
  const client = useMemo(() => createDirectPayClient(wallet), [wallet]);
  const pending = useMemo(() => pendingStore(), []);
  const answer = useRef<AnswerHandle | null>(null);
  const [stage, setStage] = useState<PStage>(() => {
    try {
      return { k: 'review', o: previewOffer(code) };
    } catch (e) {
      return { k: 'bad', msg: e instanceof Error ? e.message : 'Not a payment code' };
    }
  });
  const [amount, setAmount] = useState('');
  const [details, setDetails] = useState(false);

  useEffect(
    () => () => {
      answer.current?.cancel();
      void client.close().catch(() => undefined);
    },
    [client],
  );

  if (stage.k === 'bad')
    return (
      <>
        <Header title="Phone to phone" onBack={onClose} />
        <p className="mt-10 px-5 text-base font-semibold text-white">{stage.msg}</p>
      </>
    );

  if (stage.k === 'done') {
    const r = stage.r;
    if (r.k === 'undelivered')
      return (
        <>
          <Header title="Phone to phone" onBack={onClose} />
          <div className="mt-10 px-5">
            <p className="text-base font-semibold text-white">Sent, but their phone didn&apos;t confirm it.</p>
            <p className="mt-2 text-sm" style={{ color: MUTED }}>
              {fmt(r.sats)} has left your wallet. Don&apos;t pay again: scan a new phone-to-phone code from the same
              person and bWalletX delivers this payment to them first.
            </p>
          </div>
        </>
      );
    return (
      <>
        <Header title="Phone to phone" onBack={onClose} />
        <Done
          title={r.k === 'redelivered' ? `Delivered ${fmt(r.sats)}` : `Paid ${fmt(r.sats)}`}
          line={
            r.k === 'redelivered'
              ? 'Your earlier payment reached them. Nothing new was spent; scan again to pay more.'
              : "It's in your History as Phone to phone."
          }
          onClose={onClose}
        />
      </>
    );
  }

  if (stage.k === 'failed')
    return (
      <>
        <Header title="Phone to phone" onBack={onClose} />
        <div className="mt-10 flex flex-col px-5">
          <p className="text-base font-semibold text-white">{stage.msg}</p>
          <p className="mt-2 text-sm" style={{ color: MUTED }}>
            Ask them for a new code and try again, or send to their $name the usual way.
          </p>
          <button
            onClick={() => onSendNormally(stage.sats)}
            className={`${big} mt-6`}
            style={{ background: CARD.gold, color: '#000' }}
          >
            <Send size={16} /> Send normally
          </button>
        </div>
      </>
    );

  if (stage.k === 'answer' || stage.k === 'paying')
    return (
      <>
        <Header title="Phone to phone" onBack={onClose} />
        <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-10">
          {stage.k === 'answer' ? (
            <>
              <p className="mt-2 text-center text-base font-semibold text-white">Let them scan this now</p>
              <QrBox text={stage.code} alt="Phone to phone answer code" />
              <p className="mt-4 text-center text-sm" style={{ color: MUTED }} role="status">
                Waiting for their phone… Nothing is spent until both phones connect.
              </p>
            </>
          ) : (
            <p className="mt-16 text-center text-base text-white" role="status">
              Paying…
            </p>
          )}
        </div>
      </>
    );

  // Review: the one approval sheet. Nothing is answered (no ICE, no clock) and nothing is spent before Pay.
  const o = stage.o;
  const earlier = pending.get(o.identityKey);
  const typed = amount.trim() ? bsvToSats(amount) : null;
  const sats = earlier ? earlier.amount : (o.amount ?? typed ?? 0);
  const ok = validSats(sats);

  const pay = async () => {
    if (!ok) return;
    try {
      const a = await client.answerOfferCode(code.trim());
      answer.current = a;
      setStage({ k: 'answer', o, code: a.answerCode });
      let peer;
      try {
        peer = await a.connected;
      } catch (e) {
        return setStage({ k: 'failed', msg: connectFailure(e), sats });
      }
      setStage({ k: 'paying' });
      const r = await payOverChannel({ client, wallet, peer, sats, pending });
      if (r.k !== 'undelivered') playChime();
      setStage({ k: 'done', r });
    } catch (e) {
      setStage({ k: 'failed', msg: e instanceof Error ? e.message : connectFailure(e), sats });
    }
  };

  return (
    <div className="fixed inset-0 z-[1110] flex flex-col" style={{ background: CARD.bg }}>
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub="Phone to phone"
        onClose={onClose}
        closeLabel="Close"
        hero={
          <PayHero
            amount={ok ? fmt(sats) : 'Amount'}
            sub={earlier ? 'Your earlier payment, delivered again' : 'Straight to their phone'}
          />
        }
        title={
          <>
            Pay <span style={{ color: CARD.gold }}>{shortKey(o.identityKey)}</span>
          </>
        }
        primary={{ label: ok ? `Pay ${fmt(sats)}` : 'Enter an amount', onClick: () => void pay(), disabled: !ok }}
        secondary={{ label: 'Not now', onClick: onClose }}
        details={
          <span>
            Paid to their wallet&apos;s private payment key for you (BRC-29), over an encrypted phone-to-phone link that
            both wallets sign with their identity keys. Their identity key: {o.identityKey}.
            {earlier
              ? ' A payment you made earlier did not reach them; it is delivered first, nothing new is spent.'
              : ''}
          </span>
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
      >
        {!earlier && o.amount === undefined && (
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount in BSV"
            aria-label="Amount in BSV"
            className="mb-3 w-full rounded-xl px-3 py-3 text-base text-white outline-none"
            style={{ background: PANEL, border: '1px solid #2A2A2C' }}
          />
        )}
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          <Chip>Phone to phone</Chip>
          <Chip>No server</Chip>
          <Chip>Paid in BSV</Chip>
        </div>
      </ApprovalCard>
    </div>
  );
}
