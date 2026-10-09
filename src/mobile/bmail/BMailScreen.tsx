/**
 * bMail (owner, 9 Oct 2026): the top-bar mailbox. Pay to send (postage), Penny post by default, friends free and on
 * top, everything unstamped (airdrops included) in Requests. Postage is utility: a stamp to reach someone.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Mailbox, PenSquare, RefreshCw, Settings, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { AirdropsList } from '../airdrops/AirdropsInbox';
import { fetchPeerBPhone } from '../calls/bphone';
import { shortKey } from '../calls/machine';
import { getFriends } from '../calls/friends';
import { resolveCallee } from '../calls/peer';
import { money, parseUsdInput, usdToSats } from '../money/money';
import { BODY_MAX, SUBJECT_MAX } from './envelope';
import {
  agoLabel,
  EXAMPLES,
  EXAMPLES_BELOW,
  examplesHidden,
  setExamplesHidden,
  type ExampleMail,
  type StampKind,
} from './examples';
import { PENNY_POST_USD, quote, TIERS, type TierId } from './route';
import type { Received, Sent } from './store';
import { useBMail } from './useBMail';

const CARD = '#17191E';
const MUTED = '#98A2B3';
const GOLD = '#FFD24D';
const f = (u: string, i?: RequestInit) => fetch(u, i);
type Tab = 'inbox' | 'requests' | 'sent';
type Draft = { to?: string; toLabel?: string; subject?: string; inReplyTo?: string; credit?: boolean };

const btn = 'rounded-lg px-3 py-1.5 text-xs font-semibold bg-[#2b2f36] text-white';
const gold = 'rounded-lg px-3 py-1.5 text-xs font-bold';

const ago = (at: number) => agoLabel(Math.max(1, Math.round((Date.now() - at) / 60_000)));

const CHIP: Record<StampKind, { label: string; color: string }> = {
  free: { label: 'Friend · free', color: '#6CE9A6' },
  penny: { label: 'Penny post', color: GOLD },
  priority: { label: 'Priority', color: '#FDB022' },
  reply: { label: 'Reply paid', color: '#7CD4FD' },
  signed: { label: 'Signed', color: '#BDB4FE' },
  paytoopen: { label: 'Pay to open', color: '#FD6F8E' },
  none: { label: 'Unstamped', color: MUTED },
};

const Chip = ({ kind, text }: { kind: StampKind; text?: string }) => (
  <span
    className="rounded-full px-1.5 py-[1px] text-[10px] font-semibold whitespace-nowrap"
    style={{ color: CHIP[kind].color, border: `1px solid ${CHIP[kind].color}55` }}
  >
    {text ?? CHIP[kind].label}
  </span>
);

const Avatar = ({ label, color }: { label: string; color: string }) => (
  <span
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
    style={{ background: color }}
  >
    {(label.replace(/^[$@]/, '')[0] ?? '?').toUpperCase()}
  </span>
);

const keyColor = (k: string) => `hsl(${parseInt(k.slice(2, 6), 16) % 360} 45% 42%)`;
const oneLine = (s: string) => s.replace(/\s+/g, ' ');
const ONE = 'overflow-hidden text-ellipsis whitespace-nowrap';

/** Stamp chips for a real received mail. */
const chipsFor = (r: Received, rate: number, friend: boolean): { kind: StampKind; text?: string }[] => {
  const out: { kind: StampKind; text?: string }[] = [];
  if (r.replyCredit) out.push({ kind: 'reply' });
  else if (r.verifiedSats > 0) {
    const pri = rate > 0 && (r.verifiedSats / 1e8) * rate > 0.015;
    out.push({
      kind: pri ? 'priority' : 'penny',
      text: `${pri ? 'Priority' : 'Penny post'} ${money(r.verifiedSats, rate)}`,
    });
  } else if (friend) out.push({ kind: 'free' });
  else out.push({ kind: 'none', text: r.verifyNote ? 'Stamp not valid' : 'Unstamped' });
  if (r.env.replyPaidSats && !r.replyCredit) out.push({ kind: 'reply' });
  return out;
};

const Stamp = ({ r, rate }: { r: Received; rate: number }) => (
  <div className="flex flex-wrap gap-1">
    {chipsFor(r, rate, false).map((c) => (
      <Chip key={c.kind} kind={c.kind} text={c.text} />
    ))}
  </div>
);

const Row = ({
  avatar,
  title,
  bold,
  subject,
  preview,
  chips,
  time,
  tag,
  onOpen,
  extra,
}: {
  avatar: ReactNode;
  title: string;
  bold: boolean;
  subject: string;
  preview: string;
  chips: ReactNode;
  time: string;
  tag?: string;
  onOpen?: () => void;
  extra?: ReactNode;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left"
    style={{ background: CARD, border: bold ? `1px solid ${GOLD}40` : '1px solid transparent' }}
  >
    {avatar}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        {bold && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: GOLD }} />}
        <span className={`${ONE} text-sm text-white ${bold ? 'font-bold' : 'font-medium'}`}>{title}</span>
        {tag && (
          <span
            className="shrink-0 rounded px-1 text-[9px] font-bold uppercase tracking-wide bg-[#2b2f36]"
            style={{ color: MUTED }}
          >
            {tag}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px]" style={{ color: MUTED }}>
          {time}
        </span>
      </div>
      <div className={`${ONE} text-[13px] text-white ${bold ? 'font-semibold' : ''}`}>{subject || '(no subject)'}</div>
      <div className={`${ONE} text-xs`} style={{ color: MUTED }}>
        {preview}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">{chips}</div>
      {extra}
    </div>
  </button>
);

const MailRow = ({
  r,
  rate,
  friend,
  label,
  onOpen,
}: {
  r: Received;
  rate: number;
  friend: boolean;
  label: string;
  onOpen: () => void;
}) => (
  <Row
    avatar={<Avatar label={label} color={keyColor(r.from)} />}
    title={label}
    bold={!r.read}
    subject={r.opened ? r.opened.subject : 'Sealed letter'}
    preview={r.opened ? oneLine(r.opened.body) : 'Only you can open it. Tap to open.'}
    chips={chipsFor(r, rate, friend).map((c) => (
      <Chip key={c.kind} kind={c.kind} text={c.text} />
    ))}
    time={ago(r.at)}
    onOpen={onOpen}
  />
);

const centsChip = (k: StampKind, cents: number) =>
  k === 'penny' || k === 'priority' || k === 'reply' || k === 'paytoopen' ? `${CHIP[k].label} ${cents}¢` : undefined;

const TokenFacts = ({ t }: { t: NonNullable<ExampleMail['token']> }) => (
  <div className="mt-1 text-[11px]" style={{ color: t.spreading ? '#6CE9A6' : MUTED }}>
    {t.spreading ? 'Spreading · ' : ''}${t.symbol} · {t.holders.toLocaleString('en-US')} holders ·{' '}
    {t.forwards.toLocaleString('en-US')} forwards
  </div>
);

const ExampleRow = ({ e, onOpen }: { e: ExampleMail; onOpen: () => void }) => (
  <Row
    avatar={<Avatar label={e.name} color={e.color} />}
    title={e.name}
    bold={!!e.unread}
    subject={e.subject}
    preview={oneLine(e.body)}
    chips={
      <>
        {e.stamps.map((k) => (
          <Chip key={k} kind={k} text={centsChip(k, e.cents)} />
        ))}
        {e.action && (
          <span className="text-[10px] font-semibold text-white" style={{ opacity: 0.8 }}>
            · {e.action}
          </span>
        )}
      </>
    }
    time={agoLabel(e.ago)}
    tag="Example"
    onOpen={onOpen}
    extra={e.token && <TokenFacts t={e.token} />}
  />
);

const ExampleReader = ({ e, onBack, onHide }: { e: ExampleMail; onBack: () => void; onHide: () => void }) => (
  <div className="flex flex-col gap-3">
    <button type="button" onClick={onBack} className="self-start text-xs underline" style={{ color: MUTED }}>
      ← Back
    </button>
    <div className="rounded-xl p-3 text-xs" style={{ background: '#22252c', color: MUTED }}>
      Example: this shows what a bMail looks like. It is not real mail, so nothing here can be paid, signed or answered.
    </div>
    <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: CARD }}>
      <Avatar label={e.name} color={e.color} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-white">{e.name}</span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          {e.handle} · {agoLabel(e.ago)} ago
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        {e.stamps.map((k) => (
          <Chip key={k} kind={k} text={centsChip(k, e.cents)} />
        ))}
      </div>
    </div>
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
      <div className="text-base font-bold text-white">{e.subject}</div>
      <div className="text-sm text-white whitespace-pre-wrap break-words">{e.body}</div>
      {e.token && <TokenFacts t={e.token} />}
    </div>
    {e.action && (
      <button type="button" disabled className={gold} style={{ background: GOLD, opacity: 0.45 }}>
        {e.action} (example)
      </button>
    )}
    <button type="button" className={btn} onClick={onHide}>
      Hide examples
    </button>
  </div>
);

const Reader = ({
  r,
  label,
  rate,
  open,
  creditUsed,
  onReply,
  onBack,
}: {
  r: Received;
  label: string;
  rate: number;
  open: (r: Received) => Promise<{ subject: string; body: string }>;
  creditUsed: boolean;
  onReply: (d: Draft) => void;
  onBack: () => void;
}) => {
  const [mail, setMail] = useState(r.opened ?? null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const doOpen = () => {
    setBusy(true);
    open(r)
      .then(setMail)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const credit = !!r.env.replyPaidSats && r.verifiedSats > 0 && !creditUsed;
  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={onBack} className="self-start text-xs underline" style={{ color: MUTED }}>
        ← Back
      </button>
      <div className="rounded-xl p-3 flex flex-col gap-1" style={{ background: CARD }}>
        <div className="text-sm text-white font-semibold">From {label}</div>
        <div className="text-[11px] break-all" style={{ color: MUTED }}>
          {r.from}
        </div>
        <Stamp r={r} rate={rate} />
        {r.verifyNote && <div className="text-[11px] text-[#F97066]">{r.verifyNote}</div>}
        {r.env.postage && (
          <div className="text-[10px] break-all" style={{ color: '#667085' }}>
            Postage tx {r.env.postage.txid}
          </div>
        )}
      </div>
      {!mail ? (
        <button type="button" disabled={busy} onClick={doOpen} className={gold} style={{ background: GOLD }}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      ) : (
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
          <div className="text-base font-bold text-white">{mail.subject || '(no subject)'}</div>
          <div className="text-sm text-white whitespace-pre-wrap break-words">{mail.body}</div>
        </div>
      )}
      {err && <p className="text-xs text-[#F97066] m-0">{err}</p>}
      {mail && (
        <button
          type="button"
          className={btn}
          onClick={() =>
            onReply({
              to: r.from,
              toLabel: label,
              subject: mail.subject.startsWith('Re:') ? mail.subject : `Re: ${mail.subject}`,
              inReplyTo: r.id,
              credit,
            })
          }
        >
          {credit ? 'Reply (postage prepaid by sender)' : 'Reply'}
        </button>
      )}
    </div>
  );
};

const Compose = ({
  draft,
  rate,
  myPriceSats,
  send,
  onDone,
}: {
  draft: Draft;
  rate: number;
  myPriceSats: number;
  send: ReturnType<typeof useBMail>['send'];
  onDone: () => void;
}) => {
  const [to, setTo] = useState(draft.toLabel ?? '');
  const [peer, setPeer] = useState<{ key: string; label: string; priceSats: number } | null>(
    draft.to ? { key: draft.to, label: draft.toLabel ?? shortKey(draft.to), priceSats: 0 } : null,
  );
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState('');
  const [tier, setTier] = useState<TierId | 'free'>(draft.credit ? 'free' : 'standard');
  const [replyPaid, setReplyPaid] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const lookup = async () => {
    setErr('');
    setBusy('Looking up…');
    try {
      const p = await resolveCallee(f, to.trim());
      const card = await fetchPeerBPhone(f, p.key).catch(() => null);
      const usd = card?.profile.mail?.usd ?? PENNY_POST_USD;
      const priceSats = usdToSats(usd, rate) ?? 0;
      setPeer({ key: p.key, label: p.label, priceSats });
      return { key: p.key, label: p.label, priceSats };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy('');
    }
  };
  // Reply targets an identity key directly: price defaults to Penny post.
  const priceSats = peer?.priceSats || usdToSats(PENNY_POST_USD, rate) || 0;
  const q =
    tier === 'free' ? { stamp: 0, replyPaid: 0, total: 0 } : quote(priceSats, tier, replyPaid ? myPriceSats : 0);
  const go = async () => {
    const p = peer ?? (await lookup());
    if (!p) return;
    if (!body.trim()) return setErr('Write something');
    setBusy('Sending…');
    setErr('');
    try {
      await send({
        to: p.key,
        toLabel: p.label,
        sealed: { subject: subject.trim(), body },
        sats: q.total,
        replyPaidSats: q.replyPaid,
        inReplyTo: draft.inReplyTo,
        usesReplyCredit: draft.credit && tier === 'free',
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  const input = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-[#22252c] outline-none';
  return (
    <div className="flex flex-col gap-2">
      <input
        className={input}
        placeholder="To: $handle, paymail or name"
        value={to}
        disabled={!!draft.to}
        onChange={(e) => {
          setTo(e.target.value);
          setPeer(null);
        }}
        onBlur={() => to.trim() && !peer && void lookup()}
      />
      <input
        className={input}
        placeholder="Subject"
        maxLength={SUBJECT_MAX}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className={`${input} min-h-[140px]`}
        placeholder="Message (sealed: only they can open it)"
        maxLength={BODY_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="text-xs" style={{ color: MUTED }}>
        Postage
      </div>
      <div className="flex gap-2">
        {[
          ...(draft.credit
            ? [{ id: 'free' as const, label: 'Reply paid' }]
            : [{ id: 'free' as const, label: 'No stamp' }]),
          ...TIERS.map((t) => ({ id: t.id, label: t.label })),
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tier === t.id}
            onClick={() => setTier(t.id)}
            className="flex-1 rounded-xl py-2 text-xs font-semibold"
            style={
              tier === t.id ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#fff' }
            }
          >
            {t.label}
            {t.id !== 'free' && (
              <div className="text-[10px] font-normal opacity-80">{money(quote(priceSats, t.id).stamp, rate)}</div>
            )}
          </button>
        ))}
      </div>
      {tier !== 'free' && (
        <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
          <input type="checkbox" checked={replyPaid} onChange={(e) => setReplyPaid(e.target.checked)} />
          Reply paid: include their return postage ({money(myPriceSats, rate)}) so answering costs them nothing
        </label>
      )}
      <div className="rounded-xl p-3 text-xs" style={{ background: CARD, color: '#fff' }}>
        {peer
          ? `${peer.label} · price to reach: ${money(priceSats, rate)}`
          : 'Price to reach: Penny post (1¢) unless they set one'}
        <br />
        {tier === 'free'
          ? draft.credit
            ? 'Free: the sender prepaid your reply.'
            : 'No stamp: lands in their Requests unless you are a contact.'
          : `You pay ${money(q.total, rate)} postage to them, from your wallet, when you send.`}
      </div>
      {err && <p className="text-xs text-[#F97066] m-0">{err}</p>}
      <button type="button" disabled={!!busy} onClick={() => void go()} className={gold} style={{ background: GOLD }}>
        {busy || (q.total ? `Send · ${money(q.total, rate)}` : 'Send')}
      </button>
    </div>
  );
};

const SentRow = ({ s, rate }: { s: Sent; rate: number }) => (
  <Row
    avatar={<Avatar label={s.toLabel} color={keyColor(s.to)} />}
    title={`To ${s.toLabel}`}
    bold={false}
    subject={s.subject}
    preview={oneLine(s.body)}
    chips={
      <>
        {s.sats ? (
          <Chip kind="penny" text={`Postage ${money(s.sats - s.replyPaidSats, rate)}`} />
        ) : (
          <Chip kind="none" />
        )}
        {s.replyPaidSats > 0 && <Chip kind="reply" text={`Reply paid ${money(s.replyPaidSats, rate)}`} />}
      </>
    }
    time={ago(s.at)}
  />
);

const PriceSettings = ({
  usd,
  rate,
  save,
  onDone,
}: {
  usd: number;
  rate: number;
  save: (usd: number) => Promise<void>;
  onDone: () => void;
}) => {
  const [v, setV] = useState(String(usd));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseUsdInput(v);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-bold text-white">Price to reach me</div>
      <div className="text-xs" style={{ color: MUTED }}>
        Strangers who put at least this much postage on their mail land in your Inbox, highest first. Less goes to
        Requests. Contacts always write free. Default: Penny post (1¢).
      </div>
      <input
        className="w-full rounded-lg px-3 py-2 text-sm text-white bg-[#22252c] outline-none"
        inputMode="decimal"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      {n !== null && (
        <div className="text-xs" style={{ color: MUTED }}>
          ≈ {money(usdToSats(n, rate) ?? 0, rate)}
        </div>
      )}
      {err && <p className="text-xs text-[#F97066] m-0">{err}</p>}
      <button
        type="button"
        disabled={busy || n === null || n > 100}
        className={gold}
        style={{ background: GOLD }}
        onClick={() => {
          if (n === null) return;
          setBusy(true);
          save(n)
            .then(onDone)
            .catch((e) => setErr(`Saved on this device; not published: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => setBusy(false));
        }}
      >
        Save
      </button>
    </div>
  );
};

/** Best label for an identity key: Calls friend name, a label I sent to, their bPhone paymail/name, else short key. */
const useNames = (keys: string[], sent: Sent[]) => {
  const [remote, setRemote] = useState<Record<string, string>>({});
  const joined = [...new Set(keys)].sort().join(',');
  useEffect(() => {
    let live = true;
    for (const k of joined ? joined.split(',') : []) {
      if (remote[k] || getFriends().some((x) => x.key === k)) continue;
      fetchPeerBPhone(f, k)
        .then((p) => {
          const label = p?.paymail ? `$${p.paymail.split('@')[0]}` : p?.name;
          if (live && label) setRemote((m) => ({ ...m, [k]: label }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (k: string) =>
    getFriends().find((x) => x.key === k)?.name ||
    remote[k] ||
    sent.find((s) => s.to === k && !/…/.test(s.toLabel))?.toLabel ||
    shortKey(k);
};

const WEEK_MS = 7 * 24 * 3600 * 1000;

const Empty = ({ title, text }: { title: string; text: string }) => (
  <div className="flex flex-col items-center gap-2 rounded-xl px-6 py-8 text-center" style={{ background: CARD }}>
    <Mailbox size={28} color={GOLD} />
    <div className="text-sm font-bold text-white">{title}</div>
    <div className="text-xs leading-relaxed" style={{ color: MUTED }}>
      {text}
    </div>
  </div>
);

export const BMailScreen = ({ onClose, initialTab = 'inbox' }: { onClose: () => void; initialTab?: Tab }) => {
  const m = useBMail();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [reading, setReading] = useState<Received | null>(null);
  const [example, setExample] = useState<ExampleMail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settings, setSettings] = useState(false);
  const [hideEx, setHideEx] = useState(examplesHidden);
  useBackClose(true, onClose);
  const isContact = (k: string) => m.state.contacts.includes(k);
  const myPriceSats = m.priceSats;
  const sub = reading || draft || settings || example;
  const back = () => {
    setReading(null);
    setExample(null);
    setDraft(null);
    setSettings(false);
  };
  const nameOf = useNames(
    m.state.received.map((r) => r.from),
    m.state.sent,
  );
  const showEx = !hideEx && m.state.received.length + m.state.sent.length < EXAMPLES_BELOW;
  const hideExamples = () => {
    setExamplesHidden(true);
    setHideEx(true);
    setExample(null);
  };
  const [now] = useState(() => Date.now());
  const week = useMemo(() => {
    const recent = m.state.received.filter((r) => now - r.at < WEEK_MS && r.verifiedSats > 0);
    return { sats: recent.reduce((a, r) => a + r.verifiedSats, 0), n: recent.length };
  }, [m.state.received, now]);
  const exInbox = showEx ? EXAMPLES.filter((e) => e.box === 'inbox') : [];
  const exRequests = showEx ? EXAMPLES.filter((e) => e.box === 'requests') : [];
  const exCents = exInbox.reduce((a, e) => a + e.cents, 0);

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex flex-col overflow-y-auto"
      style={{ background: '#0d0e11', paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Mailbox size={18} color={GOLD} />
        <h2 className="text-base font-bold text-white flex-1 m-0">bMail</h2>
        <button type="button" aria-label="Write" onClick={() => setDraft({})} className="p-1">
          <PenSquare size={16} color={MUTED} />
        </button>
        <button type="button" aria-label="Refresh" onClick={() => void m.refresh()} className="p-1">
          <RefreshCw size={16} color={MUTED} className={m.loading ? 'animate-spin' : ''} />
        </button>
        <button type="button" aria-label="bMail settings" onClick={() => setSettings(true)} className="p-1">
          <Settings size={16} color={MUTED} />
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className="p-1">
          <X size={18} color={MUTED} />
        </button>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-24">
        {draft ? (
          <>
            <button type="button" onClick={back} className="self-start text-xs underline" style={{ color: MUTED }}>
              ← Back
            </button>
            <Compose
              draft={draft}
              rate={m.rate}
              myPriceSats={myPriceSats}
              send={m.send}
              onDone={() => {
                back();
                setTab('sent');
              }}
            />
          </>
        ) : settings ? (
          <>
            <button type="button" onClick={back} className="self-start text-xs underline" style={{ color: MUTED }}>
              ← Back
            </button>
            <PriceSettings usd={m.state.priceUsd} rate={m.rate} save={m.setPrice} onDone={back} />
          </>
        ) : example ? (
          <ExampleReader e={example} onBack={back} onHide={hideExamples} />
        ) : reading ? (
          <Reader
            r={m.state.received.find((x) => x.id === reading.id) ?? reading}
            label={nameOf(reading.from)}
            rate={m.rate}
            open={m.open}
            creditUsed={m.state.usedCredits.includes(reading.id)}
            onReply={(d) => {
              setReading(null);
              setDraft(d);
            }}
            onBack={back}
          />
        ) : null}
        {!sub && (
          <>
            <div
              className="flex items-center gap-3 rounded-2xl px-4 py-3"
              style={{ background: `linear-gradient(135deg, ${GOLD}26, ${CARD})`, border: `1px solid ${GOLD}33` }}
            >
              <div className="flex flex-1 flex-col">
                <span className="text-[11px] uppercase tracking-wide" style={{ color: MUTED }}>
                  Postage received this week
                </span>
                <span className="text-xl font-bold" style={{ color: GOLD }}>
                  {money(week.sats, m.rate)}
                </span>
                <span className="text-[11px]" style={{ color: MUTED }}>
                  {week.n} stamped {week.n === 1 ? 'letter' : 'letters'}
                  {showEx && exCents > 0 ? ` · examples below show ${exCents}¢` : ''}
                </span>
              </div>
              <div className="flex flex-col items-end text-[11px]" style={{ color: MUTED }}>
                <span>Price to reach you</span>
                <span className="text-sm font-semibold text-white">{money(m.priceSats, m.rate)}</span>
                <span>Penny post</span>
              </div>
            </div>
            <div className="flex gap-2">
              {(
                [
                  ['inbox', `Inbox${m.unread ? ` (${m.unread})` : ''}`],
                  ['requests', `Requests${m.boxes.requests.length ? ` (${m.boxes.requests.length})` : ''}`],
                  ['sent', 'Sent'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={tab === id}
                  onClick={() => setTab(id)}
                  className="flex-1 rounded-xl py-2 text-xs font-semibold"
                  style={
                    tab === id ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#fff' }
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {tab !== 'sent' && (
              <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
                <input type="checkbox" checked={m.newest} onChange={(e) => m.setNewest(e.target.checked)} />
                Newest first (otherwise contacts, then highest postage)
              </label>
            )}
            {m.error && <p className="text-xs text-[#F97066] m-0">{m.error}</p>}
            {tab === 'inbox' && (
              <>
                {m.boxes.inbox.map((r) => (
                  <MailRow
                    key={r.id}
                    r={r}
                    rate={m.rate}
                    friend={isContact(r.from)}
                    label={nameOf(r.from)}
                    onOpen={() => setReading(r)}
                  />
                ))}
                {!m.boxes.inbox.length && !exInbox.length && (
                  <Empty
                    title={m.loading ? 'Checking for mail…' : 'No mail yet'}
                    text="bMail is sealed mail with a stamp. Friends write free and sit on top. Strangers pay your price to reach you (Penny post, 1¢), and the postage comes to you. Unstamped mail waits in Requests."
                  />
                )}
              </>
            )}
            {tab === 'requests' && (
              <>
                {m.boxes.requests.map((r) => (
                  <div key={r.id} className="flex flex-col gap-1">
                    <MailRow r={r} rate={m.rate} friend={false} label={nameOf(r.from)} onOpen={() => setReading(r)} />
                    {r.verifiedSats > 0 && (
                      <span className="text-[10px] px-2" style={{ color: MUTED }}>
                        Below your price to reach ({money(m.priceSats, m.rate)}): the sender can pay the difference.
                      </span>
                    )}
                  </div>
                ))}
                {!m.boxes.requests.length && !exRequests.length && (
                  <Empty
                    title="Requests"
                    text="Unstamped mail, promotions and token airdrops wait here. Nothing is thrown away: keep what you like, hide an issuer to stop more."
                  />
                )}
              </>
            )}
            {tab === 'sent' &&
              (m.state.sent.length ? (
                m.state.sent.map((s) => <SentRow key={s.id} s={s} rate={m.rate} />)
              ) : (
                <Empty
                  title="Nothing sent yet"
                  text="Write to a $handle or paymail. Your letter is sealed so only they can open it, and the stamp (1¢ by default) is paid to them from your wallet as you send."
                />
              ))}
            {tab !== 'sent' && (tab === 'inbox' ? exInbox : exRequests).length > 0 && (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
                    Examples
                  </span>
                  <span className="flex-1 text-[11px]" style={{ color: '#667085' }}>
                    what bMail looks like in use
                  </span>
                  <button
                    type="button"
                    onClick={hideExamples}
                    className="text-[11px] underline"
                    style={{ color: MUTED }}
                  >
                    Hide examples
                  </button>
                </div>
                {(tab === 'inbox' ? exInbox : exRequests).map((e) => (
                  <ExampleRow key={e.id} e={e} onOpen={() => setExample(e)} />
                ))}
              </>
            )}
            {tab === 'requests' && <AirdropsList onLeave={onClose} />}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
