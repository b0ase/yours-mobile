import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBackClose } from '../backStack';
import { useKeyboardInset } from '../ui/keyboardInset';
import { currentFx } from '../../utils/displayCurrency';
import { fmtSats, hasRate, money, satsNote, useBsvUsd } from '../money/money';
import { runTip } from './flow';
import { sendTip } from './send';
import {
  TIP_NOTE_MAX,
  TIP_PRESETS,
  cleanNote,
  fiatToTipSats,
  parseFiatInput,
  presetLabel,
  presetSats,
  tipAmountError,
  tipRoute,
  type TipContext,
  type TipRecipient,
} from './tip';

const GOLD = '#FFD24D';
const PANEL = '#121316';
const LINE = '#2b2f36';
const MUTED = '#8a8f98';
const RED = '#F97066';

/** One sheet, one Allow: pick an amount, optional note, Send. Goes out through the wallet's normal send. */
export const TipSheet = ({ to, context, onClose }: { to: TipRecipient; context: TipContext; onClose: () => void }) => {
  useBackClose(true, onClose);
  const keyboard = useKeyboardInset();
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const rate = useBsvUsd();
  const fx = currentFx();
  const presets = presetSats(fx, rate);
  const [pick, setPick] = useState(2);
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const route = tipRoute(to);
  const customAmount = parseFiatInput(custom);
  const sats = custom ? (customAmount === null ? null : fiatToTipSats(customAmount, fx, rate)) : presets[pick];
  const bad = tipAmountError(sats);

  const send = async () => {
    if (!route || bad || sats === null || busy) return;
    setBusy(true);
    setError('');
    const out = await runTip({
      route,
      sats,
      name: to.name,
      label: money(sats, rate),
      context,
      send: (r, n) => sendTip(apiContext, r, n, to.name, note),
    });
    setBusy(false);
    if (!out.ok) return setError(out.error);
    addSnackbar(out.toast, out.kind);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', paddingBottom: keyboard }}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Tip ${to.name}`}
        className="w-full max-w-md rounded-t-3xl px-5 pt-5 flex flex-col gap-3"
        style={{
          background: '#0b0c0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white">Send a tip to {to.name}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {TIP_PRESETS.map((p, i) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPick(i);
                setCustom('');
              }}
              className="rounded-xl py-2 text-sm font-bold"
              style={
                !custom && pick === i
                  ? { background: GOLD, color: '#1a1300' }
                  : { background: PANEL, color: 'white', border: `1px solid ${LINE}` }
              }
            >
              {hasRate(rate) ? presetLabel(p, fx) : fmtSats(presets[i])}
            </button>
          ))}
        </div>
        {hasRate(rate) && (
          <input
            inputMode="decimal"
            placeholder={`Other amount (${fx.currency === 'GBP' ? '£' : '$'})`}
            value={custom}
            onChange={(e) => {
              const v = e.target.value.replace(/^[£$]/, '');
              if (/^\d*(\.\d{0,2})?$/.test(v)) setCustom(v);
            }}
            className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
            aria-label="Other amount"
          />
        )}
        <input
          placeholder="Add a note (optional)"
          value={note}
          maxLength={TIP_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => setNote(cleanNote(note))}
          className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
          aria-label="Note"
        />
        <p className="text-[11px]" style={{ color: MUTED }}>
          {sats !== null && satsNote(sats, rate)} All of it goes to {to.name}.
        </p>
        {error && (
          <p className="text-xs" style={{ color: RED }}>
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !!bad || !route}
          className="w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {busy ? 'Sending…' : sats !== null && !bad ? `Send ${money(sats, rate)}` : (bad ?? 'Send')}
        </button>
      </div>
    </div>,
    document.body,
  );
};
