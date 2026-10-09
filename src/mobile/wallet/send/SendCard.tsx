import { lazy, Suspense, useMemo, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpDown, ClipboardPaste, Mail, Plus, ScanLine, Trash2 } from 'lucide-react';

const ScanSheet = lazy(() => import('../../scan/ScanSheet'));
import type { Theme } from '../../../theme.types';
import { NameInput } from '../../names/NameInput';
import { useContacts } from '../../chat/useContacts';
import { payTarget } from '../../chat/contacts';
import {
  balanceLine,
  fmtBsv,
  fmtSats,
  fmtUsd,
  loadRecents,
  notePending,
  parseAmount,
  pastedRecipient,
  QUICK_USD,
  rowSats,
  rowUsd,
  SATS_PER_BSV,
  sendButton,
  type RowStatus,
  type SendRow,
} from './sendLogic';

/**
 * Send BSV card (owner, 9 Oct 2026: "as easy as HandCash"). Recipient first with quick picks and an
 * explicit Paste button, a big dollar amount with $1 · $5 · $10 · $20, and one button that says
 * exactly what happens ("Send $5.00 to $alice"). All send logic stays in BsvWallet.handleSendBsv;
 * this only edits its recipients.
 *
 * Clipboard: read only when the user taps Paste (navigator.clipboard.readText in the tap handler), or
 * through the field's own paste. Never on open or focus — on iOS a read without the user's gesture
 * shows the system "Allow Paste" prompt, and silently reading it would leak whatever was copied.
 */
type Field = 'address' | 'satSendAmount' | 'usdSendAmount' | 'amountType' | 'error';

type Props = {
  theme: Theme;
  rows: (SendRow & { error?: string })[];
  balanceBsv: number;
  rate: number;
  sendAll: boolean;
  processing: boolean;
  account: string;
  onUpdate: (id: string, field: Field, value: string | number | null) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onMax: () => void;
  /** The amount was edited after Max: it is no longer a send-all. */
  onAmountEdited: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
};

const GOLD = '#FFD24D';
const RED = '#ff4444';

export const SendCard = (p: Props) => {
  const { theme } = p;
  const fg = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const row = theme.color.global.row;
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string | undefined>>({});
  const [pasteMsg, setPasteMsg] = useState<Record<string, string>>({});
  const [scanFor, setScanFor] = useState<string | null>(null);
  const contacts = useContacts();
  const recents = useMemo(() => loadRecents(p.account), [p.account]);

  // Quick picks: recent recipients first, then contacts (bPhone friends, bChat, follows).
  const picks = useMemo(() => {
    const seen = new Set<string>();
    const out: { input: string; label: string; avatar?: string }[] = [];
    const push = (input: string, label: string, avatar?: string | null) => {
      const k = input.toLowerCase();
      if (!input || seen.has(k)) return;
      seen.add(k);
      out.push({ input, label, avatar: avatar ?? undefined });
    };
    for (const r of recents) push(r.input, r.label, r.avatar);
    for (const c of contacts) {
      const t = payTarget(c);
      if (t) push(c.handle ? `$${c.handle}` : t, c.handle ? `$${c.handle}` : c.name, c.avatar);
    }
    return out.slice(0, 10);
  }, [recents, contacts]);

  const btn = sendButton({
    rows: p.rows,
    status,
    names,
    rate: p.rate,
    balanceBsv: p.balanceBsv,
    sendAll: p.sendAll,
    processing: p.processing,
  });
  const multi = p.rows.length > 1;

  const setAddress = (id: string, v: string) => {
    setNames((n) => ({ ...n, [id]: '' }));
    p.onUpdate(id, 'address', v);
  };

  const paste = async (id: string) => {
    setPasteMsg((m) => ({ ...m, [id]: '' }));
    try {
      // Called from the tap handler only: this IS the user's paste gesture.
      const text = await navigator.clipboard.readText();
      const v = pastedRecipient(text);
      if (v) setAddress(id, v);
      else setPasteMsg((m) => ({ ...m, [id]: 'Nothing to paste: copy an address, $handle or paymail first' }));
    } catch {
      setPasteMsg((m) => ({ ...m, [id]: 'Paste was not allowed. Long-press the box and choose Paste.' }));
    }
  };

  const setAmount = (r: SendRow, v: number | null) => {
    p.onAmountEdited();
    if (r.amountType === 'usd') p.onUpdate(r.id, 'usdSendAmount', v);
    else p.onUpdate(r.id, 'satSendAmount', v === null ? null : Math.round(v * SATS_PER_BSV));
  };

  const amountText = (r: SendRow) => {
    const d = drafts[r.id];
    if (d !== undefined) return d;
    if (r.amountType === 'usd') return r.usdSendAmount ? r.usdSendAmount.toFixed(2) : '';
    return r.satSendAmount ? String(r.satSendAmount / SATS_PER_BSV) : '';
  };

  return (
    <form noValidate onSubmit={p.onSubmit} className="flex flex-col w-full gap-3">
      {/* Balance: dollars first, BSV small, Max */}
      <div className="flex items-center justify-between w-full px-1">
        <span className="text-xs" style={{ color: gray }}>
          Balance <span style={{ color: fg, fontWeight: 600 }}>{balanceLine(p.balanceBsv, p.rate)}</span>
        </span>
        {!multi && (
          <button
            type="button"
            onClick={() => {
              setDrafts({});
              p.onMax();
            }}
            className="text-xs font-bold px-2.5 py-1 rounded-full border-0 cursor-pointer"
            style={{ background: `${GOLD}20`, color: GOLD }}
          >
            Max
          </button>
        )}
      </div>

      {p.rows.map((r, idx) => {
        const sats = rowSats(r, p.rate);
        const usd = rowUsd(r, p.rate);
        const isUsd = r.amountType === 'usd';
        return (
          <motion.div
            key={r.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="w-full rounded-2xl p-4 flex flex-col gap-3"
            style={{ background: row }}
          >
            {/* To */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: gray }}>
                {multi ? `To · ${idx + 1}` : 'To'}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void paste(r.id)}
                  className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer"
                  style={{ background: `${GOLD}18`, color: GOLD }}
                >
                  <ClipboardPaste size={12} /> Paste
                </button>
                <button
                  type="button"
                  aria-label="Scan a QR code"
                  title="Scan to pay"
                  onClick={() => setScanFor(r.id)}
                  className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer"
                  style={{ background: `${GOLD}18`, color: GOLD }}
                >
                  <ScanLine size={12} /> Scan
                </button>
                {multi && (
                  <button
                    type="button"
                    aria-label="Remove recipient"
                    onClick={() => p.onRemove(r.id)}
                    className="flex items-center justify-center w-6 h-6 rounded-full border-0 cursor-pointer"
                    style={{ background: `${RED}15`, color: RED }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
            <NameInput
              theme={theme}
              asset="bsv"
              autoConfirm
              value={r.address}
              onChange={(v) => p.onUpdate(r.id, 'address', v)}
              onStatus={(s, resolved) => {
                setStatus((m) => ({ ...m, [r.id]: s }));
                const label = resolved
                  ? resolved.input.startsWith('$')
                    ? resolved.input
                    : (resolved.displayName ?? resolved.input)
                  : '';
                setNames((n) => ({ ...n, [r.id]: label }));
                if (s === 'ready' && resolved) {
                  notePending(resolved.target, { input: resolved.input, label, avatar: resolved.avatar });
                }
              }}
              style={{ width: '100%', margin: '0' }}
            />
            {pasteMsg[r.id] && (
              <p className="text-[11px] -mt-1" style={{ color: gray }}>
                {pasteMsg[r.id]}
              </p>
            )}
            {!r.address && status[r.id] !== 'loading' && picks.length > 0 && (
              <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1" style={{ scrollbarWidth: 'none' }}>
                {picks.map((k) => (
                  <button
                    key={k.input}
                    type="button"
                    onClick={() => setAddress(r.id, k.input)}
                    className="flex flex-col items-center gap-1 shrink-0 w-14 border-0 bg-transparent cursor-pointer p-0"
                  >
                    {k.avatar ? (
                      <img src={k.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <span
                        className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
                        style={{ background: `${GOLD}22`, color: GOLD }}
                      >
                        {k.label.replace(/^\$/, '').slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="text-[10px] w-full truncate text-center" style={{ color: gray }}>
                      {k.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {r.error && (
              <p className="text-xs" style={{ color: RED }}>
                {r.error}
              </p>
            )}

            {/* Amount: big dollars */}
            <div className="flex flex-col items-center gap-1 pt-1">
              <div className="flex items-center justify-center gap-1 w-full">
                <span className="font-bold" style={{ color: fg, fontSize: multi ? 24 : 40 }}>
                  {isUsd ? '$' : ''}
                </span>
                <input
                  aria-label={isUsd ? 'Amount in dollars' : 'Amount in BSV'}
                  inputMode="decimal"
                  placeholder={isUsd ? '0.00' : '0.000'}
                  value={amountText(r)}
                  onChange={(e) => {
                    const t = e.target.value;
                    setDrafts((d) => ({ ...d, [r.id]: t }));
                    setAmount(r, parseAmount(t));
                  }}
                  onBlur={() => setDrafts((d) => ({ ...d, [r.id]: undefined }))}
                  className="bg-transparent border-0 outline-none font-bold text-left min-w-0 p-0"
                  style={{
                    color: fg,
                    fontSize: multi ? 24 : 40,
                    width: `${Math.max(amountText(r).length, isUsd ? 4 : 5) + 0.5}ch`,
                    maxWidth: '70%',
                  }}
                />
                {!isUsd && (
                  <span className="font-bold" style={{ color: gray, fontSize: multi ? 14 : 18 }}>
                    BSV
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setDrafts((d) => ({ ...d, [r.id]: undefined }));
                  p.onAmountEdited();
                  p.onUpdate(r.id, 'amountType', isUsd ? 'bsv' : 'usd');
                }}
                className="flex items-center gap-1 text-[11px] border-0 bg-transparent cursor-pointer"
                style={{ color: gray }}
              >
                {sats > 0
                  ? isUsd
                    ? `≈ ${fmtBsv(sats)} BSV · ${fmtSats(sats)}`
                    : `${p.rate > 0 ? `≈ ${fmtUsd(usd)} · ` : ''}${fmtSats(sats)}`
                  : isUsd
                    ? 'Enter dollars'
                    : 'Enter BSV'}
                <span className="flex items-center gap-0.5 font-bold ml-1" style={{ color: GOLD }}>
                  {isUsd ? 'USD' : 'BSV'} <ArrowUpDown size={10} />
                </span>
              </button>
              {p.rate > 0 && (
                <div className="flex gap-2 mt-1">
                  {QUICK_USD.map((n) => {
                    const on = isUsd && r.usdSendAmount === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => {
                          setDrafts((d) => ({ ...d, [r.id]: undefined }));
                          p.onAmountEdited();
                          if (!isUsd) p.onUpdate(r.id, 'amountType', 'usd');
                          p.onUpdate(r.id, 'usdSendAmount', n);
                        }}
                        className="px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer"
                        style={{
                          background: on ? GOLD : 'transparent',
                          color: on ? '#000' : fg,
                          border: `1px solid ${on ? GOLD : gray + '50'}`,
                        }}
                      >
                        ${n}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        );
      })}

      <div className="flex items-center justify-between px-1">
        {!p.sendAll ? (
          <button
            type="button"
            onClick={p.onAdd}
            className="flex items-center gap-1 text-xs font-semibold border-0 bg-transparent cursor-pointer p-0"
            style={{ color: GOLD }}
          >
            <Plus size={12} /> Add recipient
          </button>
        ) : (
          <span />
        )}
        {/* TODO(bMail): attach a note, delivered to the recipient as a bMail. */}
        <span className="flex items-center gap-1 text-[11px]" style={{ color: gray }} title="Coming soon">
          <Mail size={11} /> Add a message · soon via bMail
        </span>
      </div>

      <button
        type="submit"
        disabled={btn.disabled}
        className="w-full h-12 rounded-2xl font-bold text-[15px] border-0 cursor-pointer disabled:cursor-not-allowed"
        style={{
          background: btn.disabled
            ? `${gray}30`
            : `linear-gradient(135deg, ${theme.color.component.primaryButtonLeftGradient}, ${theme.color.component.primaryButtonRightGradient})`,
          color: btn.disabled ? gray : theme.color.component.primaryButtonText,
        }}
      >
        {btn.label}
      </button>
      {scanFor && (
        <Suspense fallback={null}>
          <ScanSheet
            onClose={() => setScanFor(null)}
            onPay={(to, sats) => {
              const id = scanFor;
              setAddress(id, to);
              if (sats) {
                setDrafts((d) => ({ ...d, [id]: undefined }));
                p.onAmountEdited();
                p.onUpdate(id, 'amountType', 'bsv');
                p.onUpdate(id, 'satSendAmount', sats);
              }
            }}
          />
        </Suspense>
      )}
    </form>
  );
};
