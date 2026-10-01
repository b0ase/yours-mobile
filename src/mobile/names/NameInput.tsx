import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Input } from '../../components/Input';
import type { Theme } from '../../theme.types';
import { destinationFor, parseRecipient, resolveRecipient, VIA_LABEL, type Resolved } from './names';

/**
 * Recipient box for the Send screens (build-time swap for upstream's address <Input>, see
 * vite.config.mobile.ts). Plain addresses pass straight through. A $handle, paymail or OpNS
 * name is resolved, shown as a card (name, avatar, destination type) and only handed to
 * upstream's send — as a paymail or address — after the user taps "Send to this name".
 */
type Props = {
  theme: Theme;
  value: string;
  onChange: (target: string) => void;
  asset: 'bsv' | 'token';
  placeholder?: string;
  style?: CSSProperties;
};

const short = (s: string) => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

export const NameInput = ({ theme, value, onChange, asset, placeholder, style }: Props) => {
  const [text, setText] = useState(value);
  const [state, setState] = useState<
    { s: 'idle' } | { s: 'loading' } | { s: 'error'; msg: string } | { s: 'resolved'; r: Resolved; confirmed: boolean }
  >({ s: 'idle' });
  const seq = useRef(0);
  const lastOut = useRef(value);

  const emit = (v: string) => {
    lastOut.current = v;
    onChange(v);
  };

  // Upstream cleared the field (e.g. after a send) → clear ours.
  useEffect(() => {
    if (value !== lastOut.current) {
      lastOut.current = value;
      setText(value);
      setState({ s: 'idle' });
    }
  }, [value]);

  const onType = (raw: string) => {
    setText(raw);
    const p = parseRecipient(raw);
    const n = ++seq.current;
    if (p.kind === 'empty' || p.kind === 'address' || p.kind === 'invalid') {
      setState({ s: 'idle' });
      emit(raw.trim());
      return;
    }
    emit('');
    setState({ s: 'loading' });
    setTimeout(async () => {
      if (n !== seq.current) return;
      try {
        const r = await resolveRecipient((u, i) => fetch(u, i), p);
        if (n === seq.current) setState({ s: 'resolved', r, confirmed: false });
      } catch (e) {
        if (n === seq.current) setState({ s: 'error', msg: e instanceof Error ? e.message : 'Lookup failed' });
      }
    }, 450);
  };

  const confirm = (r: Resolved) => {
    const d = destinationFor(r, asset);
    if (!d.ok) return;
    setState({ s: 'resolved', r, confirmed: true });
    emit(d.to);
  };

  const gray = theme.color.global.gray;
  const fg = theme.color.global.contrast;

  return (
    <div style={{ width: style?.width ?? '85%', margin: style?.margin ?? '0 auto' }} className="flex flex-col gap-2">
      <Input
        theme={theme}
        placeholder={placeholder ?? 'Address, $handle, paymail or name'}
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onType(e.target.value)}
        value={text}
        style={{ width: '100%', margin: 0 }}
      />
      {state.s === 'loading' && (
        <div className="flex items-center gap-2 text-xs" style={{ color: gray }}>
          <Loader2 size={12} className="animate-spin" /> Looking up {text.trim()}…
        </div>
      )}
      {state.s === 'error' && (
        <p className="text-xs" style={{ color: '#ff4444' }}>
          {state.msg}
        </p>
      )}
      {state.s === 'resolved' &&
        (() => {
          const { r, confirmed } = state;
          const d = destinationFor(r, asset);
          return (
            <div
              className="rounded-xl p-3 flex flex-col gap-2"
              style={{ background: theme.color.global.row, border: `1px solid ${confirmed ? '#2ecc71' : gray + '40'}` }}
            >
              <div className="flex items-center gap-3">
                {r.avatar ? (
                  <img src={r.avatar} alt="" className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
                    style={{ background: gray + '30', color: fg }}
                  >
                    {(r.displayName ?? r.input).replace(/^\$/, '').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate" style={{ color: fg }}>
                    {r.displayName ?? r.input}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: gray }}>
                    {r.input} → {short(d.ok ? d.to : r.target)}
                  </div>
                  <div className="text-[10px]" style={{ color: gray }}>
                    {asset === 'token' && d.ok && r.via !== 'opns-owner' ? 'Paymail ordinal address' : VIA_LABEL[r.via]}
                  </div>
                </div>
              </div>
              {!d.ok ? (
                <div className="flex items-center gap-1 text-xs" style={{ color: '#ff4444' }}>
                  <X size={12} /> {d.error}
                </div>
              ) : confirmed ? (
                <div className="flex items-center gap-1 text-xs" style={{ color: '#2ecc71' }}>
                  <Check size={12} /> Recipient confirmed
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => confirm(r)}
                  className="w-full py-2 rounded-lg text-sm font-semibold border-0 cursor-pointer"
                  style={{ background: '#FFD24D', color: '#000' }}
                >
                  Send to this name
                </button>
              )}
            </div>
          );
        })()}
    </div>
  );
};
