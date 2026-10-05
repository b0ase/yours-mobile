import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUp, Flag, Loader2 } from 'lucide-react';
import { sendBsv } from '@1sat/actions';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getErrorMessage } from '../../utils/tools';
import { fetchExchangeRate } from '../../utils/wallet';
import { ChatApiError, saveSession, type BchatClient } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { oneClick } from '../settings/oneClick';
import bGlyph from '../brand/bwallet-glyph.svg';
import { MAX_INPUT, SECRET_WARNING, looksLikeSecret, transcript, type AgentMessage } from './agent';
import { BWALLET_GUIDE } from './guide';
import { PROVIDERS, callProvider } from './providers';
import { loadKey } from './keyStore';
import { KeyScreen } from '../settings/AgentSettings';
import { loadSpend, recordSpend, spentToday, useAgentPrefs } from './agentPrefs';
import {
  bitsignPaidBackend,
  formatPrice,
  payDecision,
  refuseText,
  type PaidBackend,
  type PriceInfo,
  type Quote,
} from './paid';
import { STORE_BUILD, marketTradingEnabled } from '../storeBuild';
import { agentAccountPrompt, parseActions, runAgentAction } from '../agents/agentTrade';
import { consentTarget, grantConsent, hasConsent } from './consent';
import { ConsentSheet } from './ConsentSheet';
import { ReportSheet } from '../ugc/UgcSheets';

/** Store build: no paid endpoints are ever called (own key only, storeBuild.ts). */
const storeNoPaid: PaidBackend = {
  price: () => Promise.reject(new Error('Use your own AI provider key')),
  quote: () => Promise.reject(new Error('Use your own AI provider key')),
  turn: () => Promise.reject(new Error('Use your own AI provider key')),
};
import { TopNav } from '../../components/TopNav';
import { money } from '../money/money';

/**
 * /m/agent — the b agent, opened by the top bar's centre b. Helps people use bWallet (guide.ts).
 * Not free: either the user's own provider key (direct from the device) or pay per message in
 * BSV (paid.ts). See agent.ts.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

/** A paid message whose payment went out but whose answer did not come back: retried, never re-paid. */
type Unanswered = { quote: Quote; txid: string; messages: AgentMessage[] };

const ConfirmSheet = ({
  sats,
  bsvUsd,
  usd,
  onPay,
  onCancel,
}: {
  sats: number;
  bsvUsd: number;
  usd: number | null;
  onPay: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full rounded-t-3xl p-5"
        style={{
          background: PANEL,
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'max(env(safe-area-inset-bottom), 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-base font-bold text-white">Pay for this message?</p>
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          {formatPrice(sats, bsvUsd, usd)} from this wallet, plus a small network fee.
        </p>
        {(usd !== null || bsvUsd > 0) && (
          <p className="mt-0.5 text-[11px]" style={{ color: MUTED, opacity: 0.7 }}>
            Paid as {sats.toLocaleString('en-US')} sats
          </p>
        )}
        <button
          onClick={onPay}
          className="mt-4 w-full rounded-2xl py-3 text-sm font-bold"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Pay and send
        </button>
        <button onClick={onCancel} className="mt-2 w-full py-2 text-sm" style={{ color: MUTED }}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};

/**
 * Quick starts above the composer (bWalletX only, owner 5 Oct 2026): each fills in a prompt the user can edit
 * before sending, so nothing is paid for until they tap Send.
 */
const QUICK_STARTS: { label: string; prompt: string }[] = [
  {
    label: 'Create a strategy',
    prompt: 'Help me create a strategy. Ask me what I want it to do, which tokens, my budget and when it should stop.',
  },
  {
    label: 'Trade a Strategy',
    prompt: 'Help me trade with a strategy: load one into an agent account, check its limits, and run it.',
  },
  {
    label: 'Buy / sell a strategy',
    prompt: 'Help me buy or sell a strategy on Exchange › Strategies: compare listings, or fill in the listing spec for mine and suggest a price.',
  },
];

const AgentPage = () => {
  const navigate = useNavigate();
  const close = () => navigate(-1);
  useBackClose(true, close);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const accountId = account?.addresses.identityAddress;
  // bWalletX only: in an agent account b may act, within the account's limits and loaded strategy (agents/agentTrade.ts).
  const system = marketTradingEnabled() ? BWALLET_GUIDE + agentAccountPrompt(accountId, account?.name || 'Agent account') : BWALLET_GUIDE;
  const [prefs, setPrefs] = useAgentPrefs();
  const [keyScreen, setKeyScreen] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [rate, setRate] = useState(0);
  const [keyReady, setKeyReady] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState<{ sats: number; resolve: (ok: boolean) => void } | null>(null);
  const [unanswered, setUnanswered] = useState<Unanswered | null>(null);
  // Third-party AI consent (agent/consent.ts): asked before the first message to each provider.
  const [consentAsk, setConsentAsk] = useState<((ok: boolean) => void) | null>(null);
  const [reportingReply, setReportingReply] = useState<{ text: string; index: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const provider = PROVIDERS[prefs.provider];

  // Braces matter: newer WebViews return a Promise from scrollIntoView, which React would call as the cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  /** The signed-in bit-sign client, re-signing once with the wallet's key on a stale session. */
  const withClient = useCallback(
    async <T,>(fn: (c: BchatClient) => Promise<T>): Promise<T> => {
      if (!apiContext) throw new Error('Wallet is locked.');
      try {
        return await fn(await signedInClient(apiContext));
      } catch (e) {
        if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
        saveSession(null);
        return fn(await signedInClient(apiContext, kycClient()));
      }
    },
    [apiContext],
  );
  const backend = useMemo(
    () =>
      STORE_BUILD
        ? storeNoPaid
        : bitsignPaidBackend((method, path, body) => withClient((c) => c.agentCall(method, path, body))),
    [withClient],
  );

  useEffect(() => {
    let live = true;
    setError(null);
    if (prefs.mode === 'own') {
      setKeyReady(null);
      void loadKey(prefs.provider).then((k) => live && setKeyReady(!!k));
    } else {
      setPrice(null);
      backend
        .price()
        .then((p) => live && setPrice(p))
        .catch(
          () =>
            live &&
            setPrice({
              enabled: false,
              usd: null,
              sats: 0,
              bsvUsd: 0,
              model: '',
              reason: 'Paid messages are not available right now.',
            }),
        );
    }
    // Both modes: paid prices show in dollars, and agent-account actions are sized in dollars.
    fetchExchangeRate('main')
      .then((r) => live && setRate(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [prefs.mode, prefs.provider, backend]);

  const bsvUsd = price?.bsvUsd || rate;
  const askConfirm = (sats: number) => new Promise<boolean>((resolve) => setConfirm({ sats, resolve }));

  const answerPaid = async (u: Unanswered) => {
    setUnanswered(u);
    const text = await backend.turn(u.quote, u.txid, u.messages, system);
    setUnanswered(null);
    return text;
  };

  const runPaid = async (sent: AgentMessage[]): Promise<string | null> => {
    if (!apiContext) throw new Error('Wallet is locked.');
    const quote = await backend.quote(sent);
    const decision = payDecision(
      quote.sats,
      prefs.dailyLimitSats,
      spentToday(loadSpend(), Date.now()),
      () => oneClick.take(quote.sats).ok,
    );
    if (decision.kind === 'refuse') throw new Error(refuseText(decision.reason, prefs.dailyLimitSats, bsvUsd));
    if (decision.kind === 'confirm' && !(await askConfirm(quote.sats))) return null;
    const res = await sendBsv.execute(apiContext, { requests: [{ address: quote.payTo, satoshis: quote.sats }] });
    if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
    recordSpend(quote.sats);
    return answerPaid({ quote, txid: res.txid, messages: sent });
  };

  const runOwn = async (sent: AgentMessage[]) => {
    const key = await loadKey(prefs.provider);
    if (!key) throw new Error(`Add your ${provider.label} API key in Settings › b agent.`);
    return callProvider(prefs.provider, key, prefs.models[prefs.provider], system, sent);
  };

  /** Show a reply; in an agent account, run any actions it asked for and show each result. */
  const answer = async (before: AgentMessage[], reply: string) => {
    const { text, actions, bad } = system === BWALLET_GUIDE ? { text: reply, actions: [], bad: 0 } : parseActions(reply);
    let shown: AgentMessage[] = [...before, { role: 'assistant', text: text || 'Working on it.' }];
    setMessages(shown);
    if (bad) shown = [...shown, { role: 'assistant', text: `⚙ Wallet: ignored ${bad} action${bad === 1 ? '' : 's'} it couldn't read.` }];
    for (const a of actions) {
      let r: { ok: boolean; text: string; txid?: string };
      try {
        r = apiContext && accountId ? await runAgentAction(apiContext, accountId, a, bsvUsd) : { ok: false, text: 'Wallet is locked.' };
      } catch (e) {
        r = { ok: false, text: e instanceof Error ? e.message : String(e) };
      }
      shown = [...shown, { role: 'assistant', text: `⚙ Wallet: ${r.text}${r.txid ? ` (tx ${r.txid.slice(0, 10)}…)` : ''}` }];
      setMessages(shown);
    }
    setMessages(shown);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (looksLikeSecret(text)) {
      setInput('');
      setError(SECRET_WARNING);
      return;
    }
    // ⚠ Nothing leaves the phone for an AI provider the user has not allowed (Apple 5.1.2(i)).
    const target = consentTarget(prefs.mode, prefs.provider);
    if (!hasConsent(target)) {
      const ok = await new Promise<boolean>((resolve) => setConsentAsk(() => resolve));
      setConsentAsk(null);
      if (!ok) return;
      grantConsent(target);
    }
    const next: AgentMessage[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setInput('');
    setError(null);
    setBusy(true);
    try {
      const sent = transcript(next);
      const reply = prefs.mode === 'own' ? await runOwn(sent) : await runPaid(sent);
      if (reply === null) {
        // Cancelled at the confirm step: nothing paid, put the text back.
        setMessages(messages);
        setInput(text);
      } else await answer(next, reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!unanswered || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await answerPaid(unanswered);
      await answer(messages, reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const today = spentToday(loadSpend(), Date.now());
  const status =
    prefs.mode === 'own'
      ? keyReady === false
        ? `Add your ${provider.label} API key in Settings › b agent.`
        : `Your ${provider.label} key · ${prefs.models[prefs.provider]}`
      : price === null
        ? 'Checking the price…'
        : price.enabled
          ? `${formatPrice(price.sats, bsvUsd, price.usd)} per message · today ${money(today, bsvUsd)} / ${money(prefs.dailyLimitSats, bsvUsd)}`
          : (price.reason ?? 'Paid messages are not available yet.');
  const canSend = prefs.mode === 'own' ? keyReady !== false : !!price?.enabled;

  return (
    // Top padding = the fixed TopNav (h-14); bottom = the tab bar (tabs/BottomMenu.tsx, 3.75rem) so the composer sits above it.
    <div
      className="w-full h-full flex flex-col"
      style={{ background: '#010101', paddingTop: '3.5rem', paddingBottom: '3.75rem' }}
    >
      <TopNav />
      <div className="flex items-center gap-2 px-2 py-1 shrink-0" style={{ borderBottom: `1px solid ${LINE}` }}>
        <button aria-label="Back" onClick={close} className="p-2">
          <ArrowLeft size={20} color="#fff" />
        </button>
        <img src={bGlyph} alt="" width={22} height={22} />
        <h1 className="text-lg font-bold text-white shrink-0">b agent</h1>
      </div>
      {/* Price / key status: a small yellow banner under the title row (owner, 5 Oct 2026). Tap for Settings. */}
      <button
        type="button"
        onClick={() => navigate('/m/settings')}
        className="shrink-0 w-full px-4 py-1.5 text-[11px] font-semibold text-left border-0 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ background: '#F5B800', color: '#1a1300' }}
      >
        {status}
      </button>

      {/* Own-key nudge (owner, 5 Oct 2026): most people never find Settings › b agent. With their own key, messages
          go from this device straight to their AI provider instead of through bCorp's paid service. */}
      {(prefs.mode !== 'own' || keyReady === false) && (
        <button
          type="button"
          onClick={() => setKeyScreen(true)}
          className="shrink-0 w-full px-4 py-1.5 text-[11px] font-semibold text-left border-0"
          style={{ background: PANEL, color: GOLD, borderBottom: `1px solid ${LINE}` }}
        >
          More private: use your own AI key (Claude, OpenAI or OpenRouter). Messages go straight to them, not through us. Add it here ›
        </button>
      )}
      {keyScreen && (
        <KeyScreen
          onBack={() => {
            setKeyScreen(false);
            void loadKey(prefs.provider).then((k) => {
              if (k) {
                setPrefs({ mode: 'own' });
                setKeyReady(true);
              }
            });
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="m-auto text-center">
            <img src={bGlyph} alt="" width={56} height={56} className="mx-auto mb-3" />
            <p className="text-sm" style={{ color: MUTED }}>
              Talk to b
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className="max-w-[85%] rounded-2xl px-3 py-2 text-[14px] whitespace-pre-wrap break-words"
              style={
                m.role === 'user'
                  ? { background: GOLD, color: '#1a1300' }
                  : { background: PANEL, color: '#F2F2F0', border: `1px solid ${LINE}` }
              }
            >
              {m.text}
              {m.role === 'assistant' && (
                <button
                  onClick={() => setReportingReply({ text: m.text, index: i })}
                  className="mt-1.5 flex items-center gap-1 text-[11px]"
                  style={{ color: MUTED }}
                  aria-label="Report response"
                >
                  <Flag size={11} /> Report response
                </button>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
            <Loader2 size={14} className="animate-spin" /> b is thinking…
          </div>
        )}
        {error && (
          <p className="text-xs" style={{ color: '#ff6b6b' }}>
            {error}
          </p>
        )}
        {unanswered && !busy && (
          <button
            onClick={() => void retry()}
            className="self-start rounded-full px-3 py-1 text-xs font-bold"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          >
            Paid — get the answer (no new payment)
          </button>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="shrink-0 flex flex-col gap-1 px-3 pt-2"
        style={{ paddingBottom: 10, borderTop: `1px solid ${LINE}` }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {marketTradingEnabled() && !input && !busy && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {QUICK_STARTS.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setInput(q.prompt)}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-bold"
                style={{ border: `1px solid ${GOLD}88`, color: GOLD, background: 'transparent' }}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Message b"
            aria-label="Message b"
            className="flex-1 resize-none rounded-2xl px-3 py-2 text-[14px] text-white outline-none max-h-32"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={busy || !input.trim() || !canSend || !!unanswered}
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
            style={{ background: GOLD }}
          >
            <ArrowUp size={18} color="#1a1300" />
          </button>
        </div>
      </form>
      {consentAsk && (
        <ConsentSheet
          target={consentTarget(prefs.mode, prefs.provider)}
          onAllow={() => consentAsk(true)}
          onCancel={() => consentAsk(false)}
        />
      )}
      {reportingReply && (
        <ReportSheet
          title="Report this response"
          report={{
            kind: 'ai_response',
            target: `b-agent:${prefs.mode === 'paid' ? 'paid' : `${prefs.provider}/${prefs.models[prefs.provider]}`}`,
            content: reportingReply.text,
            details: `the user's message: ${messages[reportingReply.index - 1]?.text.slice(0, 1000) ?? ''}`,
          }}
          onClose={() => setReportingReply(null)}
        />
      )}
      {confirm && (
        <ConfirmSheet
          sats={confirm.sats}
          bsvUsd={bsvUsd}
          usd={price?.usd && confirm.sats === price.sats ? price.usd : null}
          onPay={() => {
            confirm.resolve(true);
            setConfirm(null);
          }}
          onCancel={() => {
            confirm.resolve(false);
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
};

export default AgentPage;
