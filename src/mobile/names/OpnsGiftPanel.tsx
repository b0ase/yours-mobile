import { useEffect, useRef, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { Gift } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { NameInput } from './NameInput';
import type { Resolved } from './names';
import { giftOpnsName, opnsIdFor, unlistOpnsName } from './opnsBuy';
import { giftDestination, giftRecipientLabel, newGiftBatch, runGiftBatch, type GiftItem } from './opnsGift';
import type { OwnedForSale } from './opnsSell';
import { OpnsGiftSheet } from './OpnsSheets';

/**
 * Owned names › Gift: "Send <name> to…" with the shared recipient box ($handle, paymail or 1… address), the
 * resolved ordinals destination, an optional note, then ONE approval. Listed names are taken off sale first.
 */
const GOLD = '#FFD24D';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.58)';
const HAIR = 'rgba(255,255,255,0.08)';
const GREEN = '#3ddc84';
const RED = '#ff5a5a';

const goldBtn =
  'rounded-xl font-semibold border-0 cursor-pointer transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const ghostBtn =
  'rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer bg-transparent border-0 transition-colors duration-150 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-40 disabled:cursor-not-allowed';

const STATUS: Record<string, string> = {
  pending: 'Waiting',
  cancelling: 'Taking off sale…',
  sending: 'Sending…',
  done: 'Gifted',
  error: 'Not sent',
};
const shortTx = (t: string) => `${t.slice(0, 8)}…${t.slice(-6)}`;

export const OpnsGiftPanel = (p: {
  ctx: OneSatContext | undefined;
  names: OwnedForSale[];
  onGifted: (names: string[]) => void;
  onClose: () => void;
}) => {
  const { theme } = useTheme();
  const [to, setTo] = useState('');
  const [resolved, setResolved] = useState<Resolved | undefined>();
  const [boxStatus, setBoxStatus] = useState<'empty' | 'typing' | 'loading' | 'error' | 'ready'>('empty');
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState(false);
  const [items, setItems] = useState<GiftItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [recipient, setRecipient] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const dest = resolved ? giftDestination(resolved) : null;
  const toAddress = boxStatus === 'ready' && dest?.ok ? dest.to : '';
  const label = resolved && toAddress ? giftRecipientLabel(resolved, toAddress) : '';
  const listed = p.names.filter((n) => n.listedSats !== null).length;
  const title = p.names.length === 1 ? p.names[0].name : `${p.names.length} names`;

  const run = async () => {
    if (!p.ctx || !toAddress) return;
    const ctx = p.ctx;
    const ctl = new AbortController();
    abort.current = ctl;
    setSheet(false);
    setRunning(true);
    setMsg('');
    setRecipient(label);
    const start = items?.some((i) => i.status !== 'done') ? items : newGiftBatch(p.names);
    setItems(start);
    try {
      const r = await runGiftBatch(
        {
          cancel: (id) => unlistOpnsName(ctx, id),
          idAfterCancel: (name) => opnsIdFor(ctx, name).catch(() => undefined),
          send: (id, address) => giftOpnsName(ctx, id, address),
          onUpdate: setItems,
        },
        start,
        toAddress,
        ctl.signal,
      );
      const gifted = r.items.filter((i) => i.status === 'done').map((i) => i.name);
      if (gifted.length) p.onGifted(gifted);
      if (r.stopped === 'error') setMsg(`Stopped: ${r.error}. Check History before trying again.`);
    } finally {
      abort.current = null;
      setRunning(false);
    }
  };

  const done = items?.filter((i) => i.status === 'done') ?? [];
  const finished = !!items && !running && done.length === items.length;

  return (
    <div className="flex flex-col gap-3 rounded-xl p-3" style={{ background: '#0b0b0d', border: `1px solid ${HAIR}` }}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] font-semibold min-w-0" style={{ color: TEXT }}>
          <Gift size={15} color={GOLD} aria-hidden />
          <span className="break-all">
            {items ? (finished ? `Gifted to ${recipient}` : `Gifting to ${recipient}`) : `Send ${title} to…`}
          </span>
        </span>
        {!running && (
          <button type="button" className={ghostBtn} style={{ color: MUTED }} onClick={p.onClose}>
            {finished ? 'Done' : 'Close'}
          </button>
        )}
      </div>

      {!items && (
        <>
          <NameInput
            theme={theme}
            value={to}
            asset="token"
            autoConfirm
            placeholder="$handle, name@domain or 1… address"
            onStatus={(st, r) => {
              setBoxStatus(st);
              setResolved(r);
            }}
            onChange={(v) => setTo(v)}
            style={{ width: '100%', margin: 0 }}
          />
          {(boxStatus === 'ready' || boxStatus === 'error') && dest && !dest.ok && (
            <p className="m-0 text-xs" role="alert" style={{ color: RED }}>
              {dest.error}
            </p>
          )}
          {toAddress && (
            <p className="m-0 text-xs" style={{ color: MUTED }}>
              Name goes to {toAddress.slice(0, 8)}…{toAddress.slice(-6)}
              {resolved?.via === 'address' ? '' : ' (their ordinals address)'}
            </p>
          )}
          <input
            value={note}
            maxLength={120}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            aria-label="Note"
            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none focus-visible:ring-2"
            style={{ background: '#111114', color: TEXT, border: `1px solid ${HAIR}` }}
          />
          <button
            type="button"
            className={`${goldBtn} w-full py-3 text-[14px]`}
            style={{ background: GOLD, color: '#000' }}
            disabled={!p.ctx || !toAddress}
            onClick={() => setSheet(true)}
          >
            {label ? `Gift to ${label}` : 'Gift'}
          </button>
        </>
      )}

      {items && (
        <ul className="m-0 p-0 list-none flex flex-col">
          {items.map((it) => (
            <li key={it.name} className="flex items-center justify-between gap-3 py-1.5 text-xs">
              <span className="font-medium break-all" style={{ color: TEXT }}>
                {it.name}
              </span>
              <span
                className="shrink-0 text-right"
                style={{ color: it.status === 'done' ? GREEN : it.status === 'error' ? RED : GOLD }}
              >
                {it.txid ? (
                  <a
                    href={`https://whatsonchain.com/tx/${it.txid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                    style={{ color: GREEN }}
                  >
                    Gifted · {shortTx(it.txid)}
                  </a>
                ) : (
                  STATUS[it.status]
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {items && note && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          Note: “{note}”
        </p>
      )}
      {items && !running && !finished && (
        <button
          type="button"
          className={`${goldBtn} w-full py-2.5 text-[13px]`}
          style={{ background: GOLD, color: '#000' }}
          disabled={!p.ctx}
          onClick={() => setSheet(true)}
        >
          Try the rest again
        </button>
      )}
      {msg && (
        <p className="m-0 text-xs break-words" role="status" style={{ color: RED }}>
          {msg}
        </p>
      )}

      {sheet && toAddress && (
        <OpnsGiftSheet
          names={(items?.filter((i) => i.status !== 'done') ?? p.names).map((n) => n.name)}
          listed={listed}
          to={label}
          toAddress={toAddress}
          note={note.trim() || undefined}
          onAllow={() => void run()}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
  );
};
