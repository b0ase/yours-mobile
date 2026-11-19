import { LOAD_STRATEGY_BLURB } from './describeRules';
import { StrategyRuleNotes } from './StrategyRuleNotes';
import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import {
  exampleStrategy,
  describeProvenance,
  getLoadedStrategy,
  getPaperBook,
  loadStrategy,
  parseStrategy,
  setStrategyMode,
  unloadStrategy,
  type Loaded,
} from './strategy';
import {
  approveProposal,
  declineProposal,
  diffStrategy,
  proposalKey,
  proposalView,
  type ApproveResult,
} from './strategyProposal';
import { isAgentSessionLive } from '../pair/sessions';
import { saveTextFile } from './saveText';
import { PublishStrategy } from '../strategies/PublishStrategy';
import { myStrategies } from '../strategies/myStrategies';
import { MARKET_ENABLED } from '../storeBuild';
import { useServiceContext } from '../../hooks/useServiceContext';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';

const download = (l: Loaded) =>
  saveTextFile(
    `${l.strategy.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-v${l.strategy.version}.json`,
    JSON.stringify(l.strategy, null, 2),
  );

/**
 * Agent account › Strategy (SMART-WALLET-SPEC.md §3): load a strategy file (pick or paste), see its goals
 * and rules, switch Paper ↔ Live, unload. Loading always starts in paper mode; Live needs a second tap.
 */
const StrategyBody = ({ id }: { id: string }) => {
  const loaded = getLoadedStrategy(id);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const { chromeStorageService } = useServiceContext();
  const isCurrent = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress === id;
  const file = useRef<HTMLInputElement>(null);

  const load = (src: string) => {
    const r = parseStrategy(src);
    if (!r.ok) return setErrors(r.errors);
    setErrors([]);
    setEditing(false);
    setText('');
    loadStrategy(id, r.strategy, 'paper');
  };

  const section = 'rounded-2xl p-3 flex flex-col gap-2';
  const btn = 'rounded-lg px-3 py-2 text-sm font-bold border-0';

  if (loaded && !editing && publishing)
    return (
      <div className="rounded-2xl p-3" style={{ background: CARD }}>
        <PublishStrategy strategy={loaded.strategy} onClose={() => setPublishing(false)} />
      </div>
    );

  if (loaded && !editing) {
    const s = loaded.strategy;
    const book = loaded.mode === 'paper' ? getPaperBook(id) : null;
    const live = loaded.mode === 'live';
    return (
      <div className={section} style={{ background: CARD }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white flex-1">
            {s.name} <span style={{ color: MUTED }}>v{s.version}</span>
          </span>
          <span
            className="text-[9px] font-bold rounded px-1.5 py-0.5"
            style={{
              background: live ? '#12B76A22' : 'rgb(var(--bw-accent-rgb)/0.13)',
              color: live ? '#6CE9A6' : GOLD,
              letterSpacing: '0.05em',
            }}
          >
            {live ? 'LIVE' : 'PAPER'}
          </span>
        </div>
        <div className="text-xs whitespace-pre-wrap" style={{ color: '#D0D5DD' }}>
          {s.goals}
        </div>
        <div className="text-xs" style={{ color: MUTED }} data-testid="strategy-source">
          Loaded by: {describeProvenance(loaded.source)}
        </div>
        <StrategyRuleNotes rules={s.rules} paper={!live} />
        {book && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--bw-bg)', color: '#D0D5DD' }}>
            Paper money: ${book.cashUsd.toFixed(2)} cash
            {Object.entries(book.tokens)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => ` · ${+n.toFixed(4)} $${t}`)
              .join('')}
            <div style={{ color: MUTED }}>Live prices, pretend money. Nothing is signed. Trades show in Activity.</div>
          </div>
        )}
        {live ? (
          <button
            type="button"
            onClick={() => setStrategyMode(id, 'paper')}
            className={btn}
            style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: GOLD }}
          >
            Back to paper
          </button>
        ) : (
          <button
            type="button"
            onClick={() => (confirmLive ? (setStrategyMode(id, 'live'), setConfirmLive(false)) : setConfirmLive(true))}
            className={btn}
            style={{ background: confirmLive ? '#12B76A' : GOLD, color: confirmLive ? '#fff' : '#000' }}
          >
            {confirmLive ? 'Tap again: run with this account’s real money' : 'Run live'}
          </button>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`${btn} flex-1`}
            style={{ background: LINE, color: '#fff' }}
          >
            Load another
          </button>
          <button
            type="button"
            onClick={() => void download(loaded)}
            className={`${btn} flex-1`}
            style={{ background: LINE, color: '#fff' }}
          >
            Save file
          </button>
          {MARKET_ENABLED && isCurrent && (
            <button
              type="button"
              onClick={() => setPublishing(true)}
              className={`${btn} flex-1`}
              style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: GOLD }}
            >
              Sell
            </button>
          )}
          <button
            type="button"
            onClick={() => unloadStrategy(id)}
            className={`${btn} flex-1`}
            style={{ background: LINE, color: '#FDA29B' }}
          >
            Unload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={section} style={{ background: CARD }}>
      <div className="text-sm font-bold text-white">Load strategy</div>
      <div className="text-xs" style={{ color: MUTED }}>
        {LOAD_STRATEGY_BLURB}
      </div>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) load(await f.text());
        }}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => file.current?.click()}
          className={`${btn} flex-1 flex items-center justify-center gap-1.5`}
          style={{ background: GOLD, color: '#000' }}
        >
          <FileUp size={14} /> Choose file
        </button>
        <button
          type="button"
          onClick={() => setText(JSON.stringify(exampleStrategy(), null, 2))}
          className={`${btn} flex-1`}
          style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: GOLD }}
        >
          Start from example
        </button>
      </div>
      {Object.keys(myStrategies()).length > 0 && (
        <div className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
          Your strategies (bought or published):
          {Object.entries(myStrategies()).map(([op, m]) => (
            <button
              key={op}
              type="button"
              onClick={() => (loadStrategy(id, m.strategy, 'paper'), setEditing(false))}
              className="text-left text-sm font-bold border-0 bg-transparent p-0"
              style={{ color: GOLD }}
            >
              {m.strategy.name} v{m.strategy.version} → Load on paper
            </button>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…or paste a strategy here"
        rows={text ? 12 : 3}
        spellCheck={false}
        className="rounded-lg px-3 py-2 text-xs font-mono text-white outline-none border"
        style={{ background: 'var(--bw-bg)', borderColor: LINE }}
      />
      {errors.length > 0 && (
        <ul className="m-0 pl-4 text-xs" style={{ color: '#FDA29B' }}>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {text.trim() && (
          <button
            type="button"
            onClick={() => load(text)}
            className={`${btn} flex-1`}
            style={{ background: GOLD, color: '#000' }}
          >
            Load on paper
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={() => (setEditing(false), setErrors([]))}
            className={`${btn} flex-1`}
            style={{ background: LINE, color: '#fff' }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};

/** How long Approve stays off after the proposal on screen appears or changes, so a swap can't catch a tap. */
export const APPROVE_ARM_MS = 1500;

/** Full free text (goals can be 4,000 characters), scrolling, never cut. */
const LONG_BOX = 'rounded-lg px-2 py-1 whitespace-pre-wrap break-words overflow-y-auto max-h-48';

const REFUSED: Record<Exclude<ApproveResult, { ok: true }>['reason'], string> = {
  gone: 'That proposal is no longer waiting.',
  changed: 'The proposal or the loaded strategy changed. Check it again before you approve.',
  'session-ended': 'That pairing has ended, so its proposal was dropped.',
};

/** A strategy a paired computer sent: what would change, which pairing, and the owner's Approve / Decline. */
const ProposalSheet = ({ id }: { id: string }) => {
  // The proposal and the strategy it is compared with, read once: the diff, the arm delay and Approve all use this view.
  const view = proposalView(id);
  const p = view?.proposal;
  const key = view ? proposalKey(view) : '';
  const [armedFor, setArmedFor] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => setArmedFor(key), APPROVE_ARM_MS);
    return () => clearTimeout(t);
  }, [key]);
  if (!view || !p)
    return note ? (
      <div className="text-xs mb-2" style={{ color: MUTED }}>
        {note}
      </div>
    ) : null;
  const armed = armedFor === key;
  const changes = diffStrategy(view.current ?? undefined, p.strategy);
  return (
    <div
      className="rounded-2xl p-3 flex flex-col gap-2 mb-2"
      style={{ background: CARD }}
      data-testid="strategy-proposal"
    >
      <div className="text-sm font-bold text-white">A paired computer wants to change this strategy</div>
      <div className="text-xs" style={{ color: MUTED }}>
        Pairing &quot;{p.computer}&quot;, session {p.session.slice(0, 8)}. Nothing changes until you approve. It loads
        on paper; going live is a separate tap.
      </div>
      {changes.length === 0 && (
        <div className="text-xs" style={{ color: '#D0D5DD' }}>
          Same limits as now.
        </div>
      )}
      {changes.map((c) =>
        c.long ? (
          <div key={c.what} className="text-xs flex flex-col gap-1" style={{ color: '#D0D5DD' }}>
            <b className="text-white">{c.what} changed</b>
            <span style={{ color: MUTED }}>Now:</span>
            <div className={LONG_BOX} style={{ background: 'var(--bw-bg)' }}>
              {c.from}
            </div>
            <span style={{ color: MUTED }}>Proposed:</span>
            <div className={LONG_BOX} style={{ background: 'var(--bw-bg)' }} data-testid="proposal-long-to">
              {c.to}
            </div>
          </div>
        ) : (
          <div key={c.what} className="text-xs" style={{ color: '#D0D5DD' }}>
            <b className="text-white">{c.what}:</b> {c.from} → {c.to}
          </div>
        ),
      )}
      {note && (
        <div className="text-xs" style={{ color: MUTED }}>
          {note}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-sm font-bold border-0 flex-1"
          style={{ background: GOLD, color: '#000', opacity: armed ? 1 : 0.5 }}
          disabled={!armed}
          onClick={() => {
            // Approve exactly what this sheet shows: refused if the proposal or the loaded strategy changed since.
            const r = approveProposal(id, view, isAgentSessionLive);
            setNote(r.ok ? '' : REFUSED[r.reason]);
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-sm font-bold border-0 flex-1"
          style={{ background: LINE, color: '#fff' }}
          onClick={() => {
            setNote('');
            declineProposal(id);
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
};

export const StrategySection = ({ id }: { id: string }) => (
  <>
    <ProposalSheet id={id} />
    <StrategyBody id={id} />
  </>
);
