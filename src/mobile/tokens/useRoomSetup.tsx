import { useEffect, useState } from 'react';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { useSnackbar } from '../../hooks/useSnackbar';
import { indexAutoPay } from './indexAutoPay';
import { markIndexingPaid } from './pendingIndexing';
import { getFundRecord, needsIndexFunding, overlayStatus, type OverlayStatus } from './indexFund';
import {
  chargeUsd,
  fetchServerSetupFee,
  freeRoomNote,
  payRoomSetup,
  setupFeeFor,
  setupFeeSats,
  setupTotal,
  type ServerSetupFee,
} from './roomSetup';
import { money, moneyWithSats, useBsvUsd } from '../money/money';

/**
 * The shared "Set up $X's room" flow (roomSetup.ts) for the Wallet card, Settings › My tokens and
 * Chat: reads the overlay status (read-only), prices indexer + bCorp fee, and pays only after a tap:
 * one tap under Settings → Payments → "Index own tokens" (indexAutoPay), else the confirm sheet.
 * `status` undefined = loading, null = the indexer didn't answer (offer nothing).
 */
export const useRoomSetup = (
  tokenId: string,
  ticker: string,
  {
    exchangeRate = 0,
    onDone,
    issuer = true,
  }: { exchangeRate?: number; onDone?: () => void; /** false: a holder, not the issuer: no bCorp fee. */ issuer?: boolean } = {},
) => {
  const { addSnackbar } = useSnackbar();
  const { apiContext } = useServiceContext();
  const { theme } = useTheme();
  const live = useBsvUsd();
  const rate = exchangeRate > 0 ? exchangeRate : live;
  const [status, setStatus] = useState<OverlayStatus | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);
  // The server decides the bCorp fee (first 1,000 rooms free). Loading or failed = free.
  const [serverFee, setServerFee] = useState<ServerSetupFee | undefined>(undefined);

  useEffect(() => {
    if (!issuer) return;
    let on = true;
    void fetchServerSetupFee().then((f) => on && setServerFee(f));
    return () => {
      on = false;
    };
  }, [issuer]);

  useEffect(() => {
    let on = true;
    overlayStatus(apiContext, tokenId)
      .then((s) => on && setStatus(s))
      .catch(() => on && setStatus(null));
    return () => {
      on = false;
    };
  }, [apiContext, tokenId]);

  // Already paid from this device and waiting for the indexer: never offer to pay twice.
  const paid = !!getFundRecord(tokenId);
  const needs = !!status && needsIndexFunding(status) && !paid && !done;
  /** Paid (here or earlier on this device), the indexer not caught up yet. */
  const waiting = !!status && needsIndexFunding(status) && (paid || done);
  const open = !!status && !needsIndexFunding(status);
  // Priced once per render; the confirm sheet freezes it (quote) so what is shown is what is paid.
  const [quote, setQuote] = useState<ReturnType<typeof setupTotal> | null>(null);
  const total = status ? setupTotal(status, setupFeeFor(setupFeeSats(chargeUsd(serverFee), rate), issuer)) : null;

  const pay = async (t: NonNullable<typeof total>, oneTap = false) => {
    if (!status) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await payRoomSetup(apiContext, tokenId, ticker, status, t.feeSats);
      setDone(true);
      setMsg(`Done. $${ticker} will show in wallets and its room within a minute (tx ${r.txid.slice(0, 8)}…).`);
      if (oneTap) addSnackbar(`Paid ${moneyWithSats(t.totalSats, rate)} to set up $${ticker}'s room`, 'success');
      markIndexingPaid(tokenId);
      onDone?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send the room setup payment');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const start = () => {
    if (!total || busy) return;
    setQuote(total);
    // One tap under the threshold (total incl. network fee); otherwise the confirm sheet.
    if (indexAutoPay.take(total.totalSats, rate).ok) void pay(total, true);
    else setConfirming(true);
  };

  const sheet = (
    <SendConfirmation
      show={confirming && !!quote}
      theme={theme}
      lineItems={
        quote
          ? [
              // Exact sats for every part, so what is shown is what is signed.
              { address: 'Deposit (1Sat)', amount: moneyWithSats(quote.indexSats, rate) },
              // SendConfirmation truncates labels over 16 characters: keep them short.
              ...(quote.feeSats > 0 ? [{ address: 'Setup (bCorp)', amount: moneyWithSats(quote.feeSats, rate) }] : []),
              { address: 'Network fee', amount: moneyWithSats(quote.networkSats, rate) },
            ]
          : []
      }
      total={moneyWithSats(quote?.totalSats ?? 0, rate)}
      isProcessing={busy}
      onConfirm={() => quote && void pay(quote)}
      onCancel={() => !busy && setConfirming(false)}
    />
  );

  /** "Free: one of the first 1,000 rooms (N left)" for the issuer while the offer lasts, else ''. */
  const freeNote = issuer ? freeRoomNote(serverFee) : '';

  return { status, needs, waiting, open, total, rate, busy, msg, start, sheet, freeNote };
};

/** "Set up · $1.93" */
export const setupLabel = (totalSats: number, rate: number, prefix = 'Set up') =>
  `${prefix} · ${money(totalSats, rate)}`;
