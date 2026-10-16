import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { OneSatContext } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBackClose } from '../backStack';
import { ChatApiError } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import type { OverlayFee } from '../wallet/send/tokenFee';
import {
  ISSUER_TOPUP_PRESETS,
  QuoteError,
  claimWithRetry,
  fmtIssuerCredits,
  historyAmount,
  historyLabel,
  isUnavailable,
  parseHistory,
  parsePaused,
  type IssuerHistory,
  type IssuerHistoryEntry,
  issuerStopped,
  loadPendingClaims,
  parseBalance,
  parseIssuers,
  parseQuote,
  quoteSummary,
  rateLine,
  recordBalance,
  savePendingClaims,
  setIssuerStopped,
  spentFor,
  tickValue,
  topUpAccepts,
  type Issuer,
  type IssuerAccept,
  type PendingClaim,
  type Quote,
} from './issuerCredits';
import { payQuote, tokenIndexerFee } from './issuerTopUp';

/**
 * Credits from other issuers: one card per issuer in the swipe row and in All cards (BalanceCarousel), lazy chunk
 * behind ISSUER_CREDITS_ENABLED (off until bit-sign #294 is live). Front: the balance, ticking down live while it is
 * spent. Back: issuer, what you pay for, the rate, spent so far, Stop and Contact issuer, and this card's Top up.
 * Top up: the issuer's terms and set amounts → quote → ONE approval sheet with the exact outputs and total → sign →
 * claim (retried with backoff while the issuer's indexer catches up; kept and retried later if it never does).
 */

/** The carousel's card shape (BalanceCarousel CardDef), structurally. */
export type IssuerCardDef = {
  id: string;
  title: string;
  sub: string;
  issuer: string;
  colour: string;
  logo: ReactNode;
  backLines: string[];
  backButtons: { label: string; run: () => void; primary?: boolean }[];
  amount?: string;
};

const POLL_MS = 15_000;
const TICK_MS = 1200;
const CARD_COLOUR = '#17151f';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Plain message for a quote refusal. */
const quoteErrText = (e: unknown) => {
  if (e instanceof QuoteError) return e.message;
  if (e instanceof ChatApiError) {
    const code = (e.data as { code?: unknown } | null)?.code;
    if (e.status === 401) return 'Sign in again to top up.';
    if (code === 'topup_disabled' || e.status === 403) return "This issuer isn't taking top-ups right now.";
    if (e.status === 422) return 'The issuer refused that amount. Try a different one.';
    return e.message || 'The issuer could not quote a top-up.';
  }
  return errText(e);
};

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4 max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--bw-bg)',
          color: 'var(--bw-text)',
          borderTop: '1px solid var(--bw-line)',
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} style={{ color: 'var(--bw-muted)' }} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

const FullSheet = ({ children }: { children: ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {children}
    </div>,
    document.body,
  );

/** The balance shown on the card: eases from the old value to the new one when it falls (the live tick-down). */
const useTicking = (target: Record<string, number>) => {
  const [shown, setShown] = useState<Record<string, number>>(target);
  const from = useRef<Record<string, number>>(target);
  useEffect(() => {
    const start = performance.now();
    const base = { ...from.current };
    let raf = 0;
    const step = (now: number) => {
      const t = (now - start) / TICK_MS;
      const next: Record<string, number> = {};
      for (const [id, to] of Object.entries(target)) {
        const f = base[id];
        // Only a fall ticks; a top-up lands at once.
        next[id] = f === undefined || to >= f ? to : tickValue(f, to, t);
      }
      from.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
};

export default function IssuerCreditCards({ onCards }: { onCards: (cards: IssuerCardDef[]) => void }) {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [issuers, setIssuers] = useState<Issuer[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [spent, setSpent] = useState<Record<string, number>>({});
  const [stopped, setStopped] = useState<Record<string, boolean>>({});
  const [topUp, setTopUp] = useState<Issuer | null>(null);
  const [serverSpent, setServerSpent] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<Record<string, IssuerHistory>>({});
  const [historyFor, setHistoryFor] = useState<Issuer | null>(null);

  /** Stop/Resume: the server's pause (#296); device-only when it answers 404/503 not_configured. */
  const togglePause = async (i: Issuer, want: boolean) => {
    let r: { status: number; body: unknown } | null = null;
    try {
      if (apiContext) r = await (await signedInClient(apiContext)).issuerPause(i.id, want);
    } catch {
      r = null;
    }
    if (r && r.status === 200) {
      const p = (r.body as { paused?: unknown } | null)?.paused;
      const now = typeof p === 'boolean' ? p : want;
      setIssuerStopped(i.id, now);
      setStopped((x) => ({ ...x, [i.id]: now }));
      addSnackbar(now ? `${i.name} credits paused` : `${i.name} credits resumed`, 'success');
      return;
    }
    if (!r || isUnavailable(r.status)) {
      setIssuerStopped(i.id, want);
      setStopped((x) => ({ ...x, [i.id]: want }));
      addSnackbar(want ? 'Stopped on this device' : 'Resumed on this device', 'info');
      return;
    }
    addSnackbar((r.body as { error?: string } | null)?.error ?? "Couldn't change that. Try again.", 'error');
  };
  const prev = useRef<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    kycClient()
      .creditIssuers()
      .then((d) => {
        if (!live) return;
        const list = parseIssuers(d);
        setIssuers(list);
        setStopped(Object.fromEntries(list.map((i) => [i.id, issuerStopped(i.id)])));
        setSpent(Object.fromEntries(list.map((i) => [i.id, spentFor(i.id)])));
      })
      .catch(() => live && setIssuers([])); // server not live yet: no cards
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!apiContext || !issuers.length) return;
    let client;
    try {
      client = await signedInClient(apiContext);
    } catch {
      return;
    }
    const next: Record<string, number> = {};
    const server: Record<string, number> = {};
    const paused: Record<string, boolean> = {};
    const histories: Record<string, IssuerHistory> = {};
    await Promise.all(
      issuers.map(async (i) => {
        const raw = await client.issuerBalance(i.id).catch(() => null);
        const b = parseBalance(raw);
        if (b !== null) next[i.id] = b;
        const p = parsePaused(raw);
        if (p !== null) paused[i.id] = p;
        // #296: the server's spent total and history; 404/503 (not live / not migrated) keeps the device count.
        const h = await client.issuerHistory(i.id).catch(() => null);
        const hist = h && h.status === 200 ? parseHistory(h.body) : null;
        if (hist) {
          server[i.id] = hist.spentTotal;
          histories[i.id] = hist;
          paused[i.id] = hist.paused;
        }
      }),
    );
    setServerSpent((x) => ({ ...x, ...server }));
    setHistory((x) => ({ ...x, ...histories }));
    setStopped((x) => ({ ...x, ...paused }));
    const s: Record<string, number> = {};
    for (const [id, b] of Object.entries(next)) s[id] = recordBalance(id, prev.current[id] ?? null, b);
    prev.current = { ...prev.current, ...next };
    setSpent((x) => ({ ...x, ...s }));
    setBalances((x) => ({ ...x, ...next }));
  }, [apiContext, issuers]);

  // Poll while the wallet is on screen, so a balance being spent ticks down.
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Claims sent but never credited (indexer slow, app closed): try again once per mount.
  useEffect(() => {
    if (!apiContext || !issuers.length) return;
    const pending = loadPendingClaims();
    if (!pending.length) return;
    void (async () => {
      let client;
      try {
        client = await signedInClient(apiContext);
      } catch {
        return;
      }
      let left = pending;
      for (const p of pending) {
        const out = await claimWithRetry(
          () => client.issuerClaim(p.issuerId, { quote_id: p.quoteId, txid: p.txid, rawtx: p.rawtx }),
          { max: 2 },
        );
        if (out.kind === 'credited' || out.kind === 'failed') left = left.filter((x) => x.txid !== p.txid);
        if (out.kind === 'credited') addSnackbar(`${fmtIssuerCredits(p.credits)} added`, 'success');
      }
      savePendingClaims(left);
      void refresh();
    })();
  }, [apiContext, issuers, refresh, addSnackbar]);

  const shown = useTicking(balances);

  useEffect(() => {
    onCards(
      issuers.map((i): IssuerCardDef => {
        const accepts = topUpAccepts(i);
        const contact = i.contactUrl
          ? [{ label: 'Contact issuer', run: () => window.open(i.contactUrl!, '_blank', 'noopener') }]
          : i.handle
            ? [
                {
                  label: 'Contact issuer',
                  run: () => window.open(`https://bchatx.com/u/${encodeURIComponent(i.handle!)}`, '_blank'),
                },
              ]
            : [];
        return {
          id: `issuer:${i.id}`,
          title: `${i.name} credits`,
          sub: fmtIssuerCredits(0),
          amount: fmtIssuerCredits(shown[i.id] ?? 0),
          issuer: `Issued by ${i.name}${i.handle ? ` · $${i.handle}` : ''}`,
          colour: CARD_COLOUR,
          logo: '¢',
          backLines: [
            i.terms ?? `Prepaid credits for ${i.name}. Spent only with ${i.name}; they can't be sent or cashed out.`,
            ...i.accepts.map(rateLine),
            `Spent so far: ${fmtIssuerCredits(serverSpent[i.id] ?? spent[i.id] ?? 0)}${i.id in serverSpent ? '' : ' (this device)'}`,
            ...(stopped[i.id]
              ? [
                  i.id in serverSpent
                    ? 'Paused: nothing can be spent until you resume.'
                    : 'Stopped: this device will not spend these credits.',
                ]
              : []),
          ],
          backButtons: [
            ...(accepts.length ? [{ label: 'Top up', primary: true, run: () => setTopUp(i) }] : []),
            {
              label: stopped[i.id] ? 'Resume' : 'Stop',
              run: () => void togglePause(i, !stopped[i.id]),
            },
            ...(history[i.id] ? [{ label: 'History', run: () => setHistoryFor(i) }] : []),
            ...contact,
          ],
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- togglePause reads current state via its args
  }, [issuers, shown, spent, serverSpent, history, stopped, onCards]);

  useEffect(() => () => onCards([]), [onCards]);

  if (historyFor && apiContext)
    return (
      <IssuerHistorySheet
        issuer={historyFor}
        ctx={apiContext}
        first={history[historyFor.id]}
        onClose={() => setHistoryFor(null)}
      />
    );
  if (!topUp || !apiContext) return null;
  return (
    <IssuerTopUpSheet
      issuer={topUp}
      ctx={apiContext}
      onClose={() => setTopUp(null)}
      onDone={(msg, ok) => {
        setTopUp(null);
        addSnackbar(msg, ok ? 'success' : 'info');
        void refresh();
      }}
    />
  );
}

const IssuerHistorySheet = ({
  issuer,
  ctx,
  first,
  onClose,
}: {
  issuer: Issuer;
  ctx: OneSatContext;
  first?: IssuerHistory;
  onClose: () => void;
}) => {
  const [rows, setRows] = useState<IssuerHistoryEntry[]>(first?.entries ?? []);
  const [next, setNext] = useState<string | null>(first?.nextBefore ?? null);
  const [busy, setBusy] = useState(false);
  const more = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const r = await (await signedInClient(ctx)).issuerHistory(issuer.id, next);
      const h = r.status === 200 ? parseHistory(r.body) : null;
      if (h) {
        setRows((x) => [...x, ...h.entries]);
        setNext(h.nextBefore);
      } else setNext(null);
    } catch {
      /* keep what we have */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`${issuer.name} credits history`} onClose={onClose}>
      {first && (
        <div className="text-xs mb-2" style={{ color: 'var(--bw-muted)' }}>
          Spent {fmtIssuerCredits(first.spentTotal)} · topped up {fmtIssuerCredits(first.toppedUpTotal)}
        </div>
      )}
      {!rows.length && (
        <div className="text-sm py-6 text-center" style={{ color: 'var(--bw-muted)' }}>
          Nothing yet.
        </div>
      )}
      {rows.map((r) => (
        <div
          key={r.id}
          className="flex items-center justify-between py-2"
          style={{ borderBottom: '1px solid var(--bw-line)' }}
        >
          <div className="min-w-0">
            <div className="text-sm truncate">{historyLabel(r)}</div>
            <div className="text-[11px]" style={{ color: 'var(--bw-muted)' }}>
              {r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}
            </div>
          </div>
          <div
            className="text-sm font-semibold"
            style={{ color: r.units > 0 ? 'var(--bw-success)' : 'var(--bw-text)' }}
          >
            {historyAmount(r)}
          </div>
        </div>
      ))}
      {next && (
        <button
          onClick={() => void more()}
          disabled={busy}
          className="w-full rounded-2xl py-2 mt-3 text-sm font-semibold"
          style={{ background: 'var(--bw-surface)', color: 'var(--bw-text)', border: '1px solid var(--bw-line)' }}
        >
          {busy ? 'Loading…' : 'Show more'}
        </button>
      )}
    </Sheet>
  );
};

type Approve = { quote: Quote; accept: IssuerAccept; credits: number; fee: OverlayFee | null };

const IssuerTopUpSheet = ({
  issuer,
  ctx,
  onClose,
  onDone,
}: {
  issuer: Issuer;
  ctx: OneSatContext;
  onClose: () => void;
  onDone: (msg: string, ok: boolean) => void;
}) => {
  const accepts = topUpAccepts(issuer);
  const [accept, setAccept] = useState<IssuerAccept>(accepts[0]);
  const [credits, setCredits] = useState<number>(ISSUER_TOPUP_PRESETS[0]);
  const [approve, setApprove] = useState<Approve | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const getQuote = async () => {
    setError('');
    setBusy('Getting a quote…');
    try {
      const client = await signedInClient(ctx);
      const data = await client.issuerQuote(issuer.id, { asset: accept.asset, credits });
      const quote = parseQuote(data, { asset: accept.asset, accept, credits });
      const tokens = quote.outputs.filter((o) => o.kind === 'bsv21').length;
      const fee = accept.asset === 'BSV' ? null : await tokenIndexerFee(ctx, accept.tokenId!, tokens);
      setApprove({ quote, accept, credits, fee });
    } catch (e) {
      setError(quoteErrText(e));
    } finally {
      setBusy('');
    }
  };

  const send = async (a: Approve) => {
    setError('');
    setBusy('Sending…');
    let paid;
    try {
      paid = await payQuote(ctx, a.quote, a.accept, a.fee);
    } catch (e) {
      setBusy('');
      setError(errText(e));
      return;
    }
    // Sent on chain: from here the claim is kept until it is credited or refused.
    const claim: PendingClaim = {
      issuerId: issuer.id,
      quoteId: a.quote.quoteId,
      txid: paid.txid,
      rawtx: paid.rawtx,
      credits: a.credits,
      at: Date.now(),
    };
    savePendingClaims([...loadPendingClaims(), claim]);
    setBusy('Recording…');
    let out;
    try {
      const client = await signedInClient(ctx);
      out = await claimWithRetry(() =>
        client.issuerClaim(issuer.id, { quote_id: claim.quoteId, txid: claim.txid, rawtx: claim.rawtx }),
      );
    } catch {
      out = { kind: 'pending' as const };
    }
    if (out.kind === 'credited' || out.kind === 'failed')
      savePendingClaims(loadPendingClaims().filter((x) => x.txid !== claim.txid));
    setBusy('');
    if (out.kind === 'credited') onDone(`${fmtIssuerCredits(a.credits)} added`, true);
    else if (out.kind === 'failed') onDone(`${out.message} (${claim.txid.slice(0, 12)}…)`, false);
    else onDone("Sent. The issuer hasn't seen it yet; your credits will appear once it has.", true);
  };

  if (approve) {
    const sum = quoteSummary(approve.quote, approve.accept);
    return (
      <FullSheet>
        <ApprovalCard
          site={issuer.name}
          siteSub={`Top up ${issuer.name} credits`}
          onClose={() => !busy && setApprove(null)}
          closeDisabled={!!busy}
          hero={<PayHero amount={sum.total} sub={fmtIssuerCredits(approve.credits)} badge="TOP UP" />}
          title={
            <>
              Get <span style={{ color: CARD.gold }}>{fmtIssuerCredits(approve.credits)}</span>
            </>
          }
          primary={{ label: busy || 'Allow', onClick: () => void send(approve), busy: !!busy, disabled: !!busy }}
          secondary={{ label: 'Not now', onClick: () => setApprove(null), disabled: !!busy }}
          error={error || undefined}
        >
          <div className="flex flex-col gap-1 text-[12px]" style={{ color: CARD.muted }}>
            {sum.lines.map((l, i) => (
              <div key={`${l.address}-${i}`} className="flex justify-between gap-3">
                <span className="truncate">{l.address}</span>
                <span style={{ color: CARD.ink }}>{l.amount}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <span>Payment reference</span>
              <span style={{ color: CARD.ink }}>on chain, 0 sats</span>
            </div>
            {approve.fee && (
              <div className="flex justify-between gap-3">
                <span className="truncate">{approve.fee.address}</span>
                <span style={{ color: CARD.ink }}>up to {approve.fee.sats} sats (indexer fee)</span>
              </div>
            )}
            <div className="flex justify-between gap-3 font-semibold" style={{ color: CARD.ink }}>
              <span>Total</span>
              <span>{sum.total}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Chip>Spent only with {issuer.name}</Chip>
            <Chip>Plus a small network fee</Chip>
          </div>
        </ApprovalCard>
      </FullSheet>
    );
  }

  const tile = (on: boolean) => ({
    background: on ? 'var(--bw-accent-hi)' : 'var(--bw-surface)',
    color: on ? 'var(--bw-on-accent)' : 'var(--bw-text)',
    border: '1px solid var(--bw-line)',
  });

  return (
    <Sheet title={`Top up ${issuer.name} credits`} onClose={onClose}>
      {accepts.length > 1 && (
        <div className="grid grid-cols-2 gap-2 mb-2">
          {accepts.map((a) => (
            <button
              key={a.asset}
              onClick={() => setAccept(a)}
              className="rounded-2xl py-2 text-sm font-bold"
              style={tile(a === accept)}
            >
              Pay in {a.asset === 'PNEE' ? 'PNEEs' : a.asset}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-4 gap-2">
        {ISSUER_TOPUP_PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setCredits(p)}
            className="rounded-2xl py-3 text-sm font-bold"
            style={tile(credits === p)}
          >
            {p.toLocaleString('en-US')}
          </button>
        ))}
      </div>
      <div className="text-xs mt-2" style={{ color: 'var(--bw-muted)' }}>
        {rateLine(accept)}
      </div>
      <div
        className="rounded-2xl p-3 mt-3 text-[12px] leading-relaxed"
        style={{ background: 'var(--bw-surface)', color: 'var(--bw-text)' }}
      >
        {issuer.terms ??
          `${issuer.name} credits are spent only with ${issuer.name}. They can't be sent to anyone or cashed out. Top-ups pay ${issuer.name} directly; ask them about refunds.`}
      </div>
      {error && (
        <div className="text-xs mt-2" style={{ color: 'var(--bw-danger)' }}>
          {error}
        </div>
      )}
      <button
        onClick={() => void getQuote()}
        disabled={!!busy}
        className="w-full rounded-2xl py-3 mt-3 font-bold"
        style={{ background: 'var(--bw-accent-hi)', color: 'var(--bw-on-accent)', opacity: busy ? 0.6 : 1 }}
      >
        {busy || `Top up ${fmtIssuerCredits(credits)}`}
      </button>
    </Sheet>
  );
};
