import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUp, Loader2 } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ChatApiError, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import bGlyph from '../brand/bwallet-glyph.svg';
import { MAX_INPUT, agentRequest, parseAgentReply, type AgentMessage } from './agent';
import { TopNav } from '../../components/TopNav';

/**
 * /m/agent — the b agent, opened by the top bar's centre b. bChat's composer agent (same back
 * end as bChat's b button), signed in silently with the wallet's own key. See agent.ts.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

type Shown = AgentMessage & { notes?: string[] };

const AgentPage = () => {
  const navigate = useNavigate();
  const close = () => navigate(-1);
  useBackClose(true, close);
  const { apiContext } = useServiceContext();
  const [messages, setMessages] = useState<Shown[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Braces matter: newer WebViews return a Promise from scrollIntoView, which React would call as the cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const ask = async (transcript: AgentMessage[]) => {
    if (!apiContext) throw new Error('Wallet is locked.');
    const body = agentRequest(transcript);
    try {
      return await (await signedInClient(apiContext)).agentTurn(body);
    } catch (e) {
      // A stale session: sign in again once with the wallet's key.
      if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
      saveSession(null);
      return (await signedInClient(apiContext, kycClient())).agentTurn(body);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: Shown[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setInput('');
    setError(null);
    setBusy(true);
    try {
      const reply = parseAgentReply(await ask(next));
      setMessages([...next, { role: 'assistant', text: reply.text, notes: reply.notes }]);
    } catch (e) {
      const needsKey =
        e instanceof ChatApiError && e.status === 503 && Array.isArray((e.data as { needs?: unknown })?.needs);
      setError(
        needsKey
          ? 'The b agent has no model available right now. Add your own API key in bChat › Settings.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

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
        <h1 className="text-lg font-bold text-white">b agent</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="m-auto text-center max-w-[280px]">
            <img src={bGlyph} alt="" width={56} height={56} className="mx-auto mb-3" />
            <p className="text-white font-semibold">Ask b anything</p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              bChat's agent: drafts agreements, explains tokens and rooms. Anything it prepares opens in bChat for you
              to review. Free to use.
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
              {m.notes?.map((n) => (
                <div key={n} className="mt-1 text-[12px]" style={{ color: GOLD }}>
                  {n}
                </div>
              ))}
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
        <div ref={endRef} />
      </div>

      <form
        className="shrink-0 flex items-end gap-2 px-3 pt-2"
        style={{ paddingBottom: 10, borderTop: `1px solid ${LINE}` }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
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
          disabled={busy || !input.trim()}
          className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
          style={{ background: GOLD }}
        >
          <ArrowUp size={18} color="#1a1300" />
        </button>
      </form>
    </div>
  );
};

export default AgentPage;
