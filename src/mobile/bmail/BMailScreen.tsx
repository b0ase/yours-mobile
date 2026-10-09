/**
 * bMail (owner, 9 Oct 2026): the top-bar mailbox. Pay to send (postage), Penny post by default, friends free and on
 * top, everything unstamped (airdrops included) in Requests. Postage is utility: a stamp to reach someone.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Mailbox, PenSquare, RefreshCw, Settings, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { AirdropsList } from '../airdrops/AirdropsInbox';
import { fetchPeerBPhone } from '../calls/bphone';
import { shortKey } from '../calls/machine';
import { resolveCallee } from '../calls/peer';
import { money, parseUsdInput, usdToSats } from '../money/money';
import { BODY_MAX, SUBJECT_MAX } from './envelope';
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

const Stamp = ({ r, rate }: { r: Received; rate: number }) =>
  r.replyCredit ? (
    <span className="text-[10px] font-bold" style={{ color: GOLD }}>
      Reply paid
    </span>
  ) : r.verifiedSats > 0 ? (
    <span className="text-[10px] font-bold" style={{ color: GOLD }}>
      {money(r.verifiedSats, rate)} stamp
    </span>
  ) : (
    <span className="text-[10px]" style={{ color: MUTED }}>
      {r.verifyNote ? 'Stamp not valid' : 'Unstamped'}
    </span>
  );

const MailRow = ({ r, rate, friend, onOpen }: { r: Received; rate: number; friend: boolean; onOpen: () => void }) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex flex-col gap-1 rounded-xl px-3 py-3 text-left"
    style={{ background: CARD, border: r.read ? 'none' : `1px solid ${GOLD}55` }}
  >
    <div className="flex items-center gap-2">
      <span className={`flex-1 text-sm text-white ${r.read ? '' : 'font-bold'}`}>{shortKey(r.from)}</span>
      {friend && <span className="text-[10px] text-[#6CE9A6]">Contact</span>}
      <Stamp r={r} rate={rate} />
    </div>
    <div className="text-xs" style={{ color: MUTED }}>
      {r.opened ? r.opened.subject || '(no subject)' : 'Sealed: tap to open'} · {new Date(r.at).toLocaleString()}
    </div>
  </button>
);

const Reader = ({
  r,
  rate,
  open,
  creditUsed,
  onReply,
  onBack,
}: {
  r: Received;
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
        <div className="text-sm text-white font-semibold">From {shortKey(r.from)}</div>
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
              toLabel: shortKey(r.from),
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
  <div className="flex flex-col gap-1 rounded-xl px-3 py-3" style={{ background: CARD }}>
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm text-white">To {s.toLabel}</span>
      <span className="text-[10px]" style={{ color: s.sats ? GOLD : MUTED }}>
        {s.sats ? `${money(s.sats, rate)} stamp${s.replyPaidSats ? ' + reply paid' : ''}` : 'Unstamped'}
      </span>
    </div>
    <div className="text-xs text-white">{s.subject || '(no subject)'}</div>
    <div className="text-[11px]" style={{ color: MUTED }}>
      {new Date(s.at).toLocaleString()}
    </div>
  </div>
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

export const BMailScreen = ({ onClose, initialTab = 'inbox' }: { onClose: () => void; initialTab?: Tab }) => {
  const m = useBMail();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [reading, setReading] = useState<Received | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settings, setSettings] = useState(false);
  useBackClose(true, onClose);
  const isContact = (k: string) => m.state.contacts.includes(k);
  const myPriceSats = m.priceSats;
  const sub = reading || draft || settings;
  const back = () => {
    setReading(null);
    setDraft(null);
    setSettings(false);
  };

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
        ) : reading ? (
          <Reader
            r={m.state.received.find((x) => x.id === reading.id) ?? reading}
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
            <div className="flex gap-2">
              {(
                [
                  ['inbox', `Inbox${m.unread ? ` (${m.unread})` : ''}`],
                  ['requests', 'Requests'],
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
            {tab === 'inbox' &&
              (m.boxes.inbox.length ? (
                m.boxes.inbox.map((r) => (
                  <MailRow key={r.id} r={r} rate={m.rate} friend={isContact(r.from)} onOpen={() => setReading(r)} />
                ))
              ) : (
                <p className="text-xs text-center py-10 m-0" style={{ color: MUTED }}>
                  {m.loading ? 'Checking for mail…' : 'No mail yet.'}
                </p>
              ))}
            {tab === 'requests' && (
              <>
                {m.boxes.requests.map((r) => (
                  <div key={r.id} className="flex flex-col gap-1">
                    <MailRow r={r} rate={m.rate} friend={false} onOpen={() => setReading(r)} />
                    {r.verifiedSats > 0 && (
                      <span className="text-[10px] px-2" style={{ color: MUTED }}>
                        Below your price to reach ({money(m.priceSats, m.rate)}): the sender can pay the difference.
                      </span>
                    )}
                  </div>
                ))}
                <AirdropsList onLeave={onClose} />
              </>
            )}
            {tab === 'sent' &&
              (m.state.sent.length ? (
                m.state.sent.map((s) => <SentRow key={s.id} s={s} rate={m.rate} />)
              ) : (
                <p className="text-xs text-center py-10 m-0" style={{ color: MUTED }}>
                  Nothing sent yet.
                </p>
              ))}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
