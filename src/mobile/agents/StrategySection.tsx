import { describeRules } from './describeRules';
import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import {
  exampleStrategy,
  getLoadedStrategy,
  getPaperBook,
  loadStrategy,
  parseStrategy,
  setStrategyMode,
  unloadStrategy,
  type Loaded,
} from './strategy';
import { saveTextFile } from './saveText';
import { PublishStrategy } from '../strategies/PublishStrategy';
import { myStrategies } from '../strategies/myStrategies';
import { marketTradingEnabled } from '../storeBuild';
import { useServiceContext } from '../../hooks/useServiceContext';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';

const download = (l: Loaded) =>
  saveTextFile(`${l.strategy.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-v${l.strategy.version}.json`, JSON.stringify(l.strategy, null, 2));

/**
 * Agent account › Strategy (SMART-WALLET-SPEC.md §3): load a strategy file (pick or paste), see its goals
 * and rules, switch Paper ↔ Live, unload. Loading always starts in paper mode; Live needs a second tap.
 */
export const StrategySection = ({ id }: { id: string }) => {
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
            style={{ background: live ? '#12B76A22' : '#F5B80022', color: live ? '#6CE9A6' : GOLD, letterSpacing: '0.05em' }}
          >
            {live ? 'LIVE' : 'PAPER'}
          </span>
        </div>
        <div className="text-xs whitespace-pre-wrap" style={{ color: '#D0D5DD' }}>
          {s.goals}
        </div>
        <ul className="m-0 pl-4 text-xs flex flex-col gap-0.5" style={{ color: MUTED }}>
          {describeRules(s.rules).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="text-[11px]" style={{ color: MUTED }}>
          The wallet checks these rules before anything is signed. The agent can't change them.
        </div>
        {book && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: '#010101', color: '#D0D5DD' }}>
            Paper money: ${book.cashUsd.toFixed(2)} cash
            {Object.entries(book.tokens)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => ` · ${+n.toFixed(4)} $${t}`)
              .join('')}
            <div style={{ color: MUTED }}>Live prices, pretend money. Nothing is signed. Trades show in Activity.</div>
          </div>
        )}
        {live ? (
          <button type="button" onClick={() => setStrategyMode(id, 'paper')} className={btn} style={{ background: '#F5B80022', color: GOLD }}>
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
          <button type="button" onClick={() => setEditing(true)} className={`${btn} flex-1`} style={{ background: LINE, color: '#fff' }}>
            Load another
          </button>
          <button type="button" onClick={() => void download(loaded)} className={`${btn} flex-1`} style={{ background: LINE, color: '#fff' }}>
            Save file
          </button>
          {marketTradingEnabled() && isCurrent && (
            <button type="button" onClick={() => setPublishing(true)} className={`${btn} flex-1`} style={{ background: '#F5B80022', color: GOLD }}>
              Sell
            </button>
          )}
          <button type="button" onClick={() => unloadStrategy(id)} className={`${btn} flex-1`} style={{ background: LINE, color: '#FDA29B' }}>
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
        A strategy is a file of goals for the agent and rules the wallet enforces: which tokens, how much per trade and per
        day, buy and sell prices, when to stop. It starts on paper (pretend money) until you choose Run live.
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
          style={{ background: '#F5B80022', color: GOLD }}
        >
          Start from example
        </button>
      </div>
      {Object.keys(myStrategies()).length > 0 && (
        <div className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
          Your strategies (bought or published):
          {Object.entries(myStrategies()).map(([op, m]) => (
            <button key={op} type="button" onClick={() => (loadStrategy(id, m.strategy, 'paper'), setEditing(false))} className="text-left text-sm font-bold border-0 bg-transparent p-0" style={{ color: GOLD }}>
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
        style={{ background: '#010101', borderColor: LINE }}
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
          <button type="button" onClick={() => load(text)} className={`${btn} flex-1`} style={{ background: GOLD, color: '#000' }}>
            Load on paper
          </button>
        )}
        {editing && (
          <button type="button" onClick={() => (setEditing(false), setErrors([]))} className={`${btn} flex-1`} style={{ background: LINE, color: '#fff' }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};
