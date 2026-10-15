import { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, BadgeCheck, Lock, MessageCircle, Wallet } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestDm } from '../chat/segmentNav';
import { requestPay } from './payNav';
import { Avatar } from '../chat/ContactViews';
import { canMessage, payTarget, type Contact } from '../chat/contacts';
import { defaultHttp } from '../chat/api';
import { buildCard, loadCardInputs, type CardInputs } from './contactCardData';
import { contactNoteKey, loadNotes, saveNotes, type ContactNotes } from './contactNotes';

const f = (u: string, i?: RequestInit) => fetch(u, i);
const http = defaultHttp(Capacitor.isNativePlatform());
const getJson = async (url: string) => {
  const r = await http({ method: 'GET', url, headers: {} });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.data;
};

const MUTED = '#98A2B3';
const NAMES_SHOWN = 3;

const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="bw-abook-card-line">
    <span className="bw-abook-card-label">{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

const Verified = ({ title }: { title: string }) => (
  <BadgeCheck size={13} aria-label={title} style={{ color: 'var(--bw-accent)', flexShrink: 0 }} />
);

/** One contact, opened from a notebook row. Public half: published or provable only. Private half: this device. */
export const ContactCard = ({ c, account, onBack }: { c: Contact; account?: string; onBack: () => void }) => {
  const { handleSelect } = useBottomMenu();
  const [inputs, setInputs] = useState<CardInputs>({ contact: c });
  const [pic, setPic] = useState(0);
  const [allNames, setAllNames] = useState(false);
  const noteKey = contactNoteKey(c);
  const [notes, setNotes] = useState<ContactNotes>(() => loadNotes(account, noteKey));
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let live = true;
    void loadCardInputs(c, f, getJson).then((i) => live && setInputs(i));
    return () => {
      live = false;
    };
  }, [c]);

  const card = useMemo(() => buildCard(inputs), [inputs]);
  const avatar = card.avatars[Math.min(pic, card.avatars.length - 1)] ?? null;
  const pay = payTarget(c);
  const names = allNames ? card.opnsNames : card.opnsNames.slice(0, NAMES_SHOWN);

  const chat = () => {
    if (!c.handle) return;
    requestDm(c.handle);
    handleSelect(asMenuItem('chat'));
  };
  const payNow = () => {
    if (!pay) return;
    requestPay(pay);
    handleSelect(asMenuItem('bsv'));
  };
  const edit = (k: keyof ContactNotes) => (e: { target: { value: string } }) => {
    setSaved('');
    setNotes((n) => ({ ...n, [k]: e.target.value }));
  };
  const save = () => setSaved(saveNotes(account, noteKey, notes) ? 'Saved on this device.' : 'Could not save here.');

  return (
    <div className="bw-abook-card">
      <button type="button" className="bw-abook-card-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> All contacts
      </button>

      <div className="flex items-center gap-3">
        <Avatar title={card.title} src={avatar} size={72} />
        <div className="min-w-0">
          <div className="text-[17px] font-bold text-white truncate">{card.title}</div>
          {card.main && (
            <div className="text-xs truncate" style={{ color: MUTED }}>
              {card.main}
            </div>
          )}
        </div>
      </div>
      {card.avatars.length > 1 && (
        <div className="bw-abook-card-thumbs" aria-label="Their pictures">
          {card.avatars.map((u, i) => (
            <button
              key={u}
              type="button"
              aria-label={`Picture ${i + 1}`}
              aria-pressed={i === pic}
              onClick={() => setPic(i)}
            >
              <img src={u} alt="" />
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" className="bw-abook-card-btn" disabled={!canMessage(c)} onClick={chat}>
          <MessageCircle size={14} aria-hidden="true" /> Chat
        </button>
        <button type="button" className="bw-abook-card-btn" disabled={!pay} onClick={payNow}>
          <Wallet size={14} aria-hidden="true" /> Pay
        </button>
        {card.opnsNames.length > NAMES_SHOWN && (
          <button type="button" className="bw-abook-card-btn" onClick={() => setAllNames((v) => !v)}>
            {allNames ? 'Fewer names' : 'View names'}
          </button>
        )}
      </div>

      {card.otherPaymails.length > 0 && (
        <Line label="Also">
          {card.otherPaymails.map((p) => (
            <div key={p} className="truncate">
              {p}
            </div>
          ))}
        </Line>
      )}
      {names.length > 0 && (
        <Line label="Names">
          {names.map((n) => (
            <div key={n} className="flex items-center gap-1">
              <span className="truncate">{n}</span>
              <Verified title="Verified on chain" />
              <span className="text-[10px]" style={{ color: MUTED }}>
                verified on chain
              </span>
            </div>
          ))}
        </Line>
      )}
      {card.x && (
        <Line label="X">
          <span className="flex items-center gap-1">
            {card.x} <Verified title="Signed in with X" />
            <span className="text-[10px]" style={{ color: MUTED }}>
              signed in with X
            </span>
          </span>
        </Line>
      )}
      {card.twetch && <Line label="Twetch">{card.twetch}</Line>}
      {card.businesses.length > 0 && (
        <Line label="Work">
          {card.businesses.map((b) => (
            <div key={b.label} className="flex items-center gap-1">
              <span style={b.verified ? undefined : { color: MUTED }}>{b.label}</span>
              {b.verified && <Verified title="From a public register" />}
            </div>
          ))}
        </Line>
      )}
      {card.bio && <p className="bw-abook-card-bio">{card.bio}</p>}

      <section className="bw-abook-card-private" aria-label="Private notes">
        <div className="flex items-center gap-1 text-xs font-bold" style={{ color: 'var(--bw-accent)' }}>
          <Lock size={12} aria-hidden="true" /> Only you can see this
        </div>
        {noteKey && account ? (
          <>
            <input
              type="email"
              placeholder="Email"
              value={notes.email}
              onChange={edit('email')}
              autoCapitalize="none"
              autoComplete="off"
            />
            <input type="tel" placeholder="Phone" value={notes.phone} onChange={edit('phone')} autoComplete="off" />
            <textarea placeholder="Notes" rows={3} value={notes.text} onChange={edit('text')} />
            <div className="flex items-center gap-2">
              <button type="button" className="bw-abook-card-btn" onClick={save}>
                Save
              </button>
              {saved && (
                <span className="text-[11px]" style={{ color: MUTED }}>
                  {saved}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-[11px] m-0" style={{ color: MUTED }}>
            Notes need a name, paymail or key for this contact.
          </p>
        )}
      </section>
    </div>
  );
};
