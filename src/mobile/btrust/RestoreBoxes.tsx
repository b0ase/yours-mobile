/**
 * Restore from slices: one box per slice ("Key slice 1", "Key slice 2", "Add another slice" while the set has
 * more), each with Paste and Scan and its own ✓ or error. Restore turns on once enough slices are in.
 * Pasting several lines into one box also works (restoreBoxes.ts).
 */
import { useState } from 'react';
import { Scanner } from '../scan/Scanner';
import { restoreState } from './sliceRestore';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const INPUT = 'w-full rounded-xl bg-[#0f1115] border border-[#2b2f36] p-2 text-white text-sm';
const SMALL = 'rounded-xl px-3 py-2 text-sm font-bold border cursor-pointer shrink-0';

export const RestoreBoxes = ({ onRestore }: { onRestore: (texts: string[]) => void }) => {
  const [texts, setTexts] = useState(['', '']);
  const [scanning, setScanning] = useState<number | null>(null);
  const st = restoreState(texts);
  const set = (i: number, v: string) => setTexts((t) => t.map((x, j) => (j === i ? v : x)));
  const paste = async (i: number) => {
    try {
      set(i, (await navigator.clipboard.readText()).trim());
    } catch {
      /* clipboard blocked: the box still takes a normal paste */
    }
  };

  return (
    <div className="flex flex-col gap-2" aria-label="Restore from slices">
      {texts.map((t, i) => {
        const b = st.boxes[i];
        return (
          <div key={i} className="flex flex-col gap-1">
            <label className="text-sm text-white" htmlFor={`slice-box-${i}`}>
              Key slice {i + 1}
            </label>
            <div className="flex gap-2 items-start">
              <textarea
                id={`slice-box-${i}`}
                className={INPUT}
                rows={2}
                value={t}
                onChange={(e) => set(i, e.target.value)}
                placeholder="Paste or scan a slice"
                spellCheck={false}
                autoComplete="off"
              />
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className={SMALL}
                  style={{ color: GOLD, borderColor: GOLD }}
                  onClick={() => void paste(i)}
                >
                  Paste
                </button>
                <button
                  type="button"
                  className={SMALL}
                  style={{ color: GOLD, borderColor: GOLD }}
                  onClick={() => setScanning(scanning === i ? null : i)}
                >
                  {scanning === i ? 'Close' : 'Scan'}
                </button>
              </div>
            </div>
            {scanning === i && (
              <Scanner
                onCode={(code) => {
                  set(i, code.trim());
                  setScanning(null);
                }}
              />
            )}
            {b.kind === 'ok' && (
              <span className="text-xs" style={{ color: '#32D583' }}>
                ✓ {b.label}
              </span>
            )}
            {b.kind === 'error' && (
              <span role="alert" className="text-xs" style={{ color: '#F97066' }}>
                {b.message.charAt(0).toUpperCase() + b.message.slice(1)}
              </span>
            )}
          </div>
        );
      })}
      {texts.length < st.total && (
        <button
          type="button"
          className={SMALL}
          style={{ color: GOLD, borderColor: GOLD }}
          onClick={() => setTexts((t) => [...t, ''])}
        >
          Add another slice
        </button>
      )}
      {st.problem && (
        <span role="alert" className="text-xs" style={{ color: '#F97066' }}>
          {st.problem}
        </span>
      )}
      <span className="text-xs" style={{ color: MUTED }}>
        {st.have} of {st.threshold} slices needed.
      </span>
      <button
        type="button"
        className="rounded-xl px-3 py-3 text-base font-bold border-0 cursor-pointer"
        style={{ background: GOLD, opacity: st.ready ? 1 : 0.5 }}
        disabled={!st.ready}
        onClick={() => onRestore(st.texts)}
      >
        Restore
      </button>
    </div>
  );
};
