import type { ReactNode } from 'react';
import { MessageCircle, Phone, Star, Trash2, Wallet } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { dial } from '../calls/store';
import { requestPay } from '../wallet/payNav';
import { avatarHue, roomInitial } from './messages';
import { canCall, canMessage, contactLine, payTarget, SOURCE_LABEL, type Contact } from './contacts';

/** Shared contact UI for Chat › DMs › Contacts and Chat › Calls › Contacts / Favourites. */
const GOLD = '#FFD24D';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

export const Avatar = ({ title, src, size = 48 }: { title: string; src?: string | null; size?: number }) => {
  const hue = avatarHue(title);
  if (src)
    return (
      <img src={src} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
    );
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: `hsl(${hue} 70% 82%)`,
        background: `linear-gradient(145deg, hsl(${hue} 35% 26%), hsl(${hue} 30% 14%))`,
        border: `1px solid hsl(${hue} 30% 30% / 0.6)`,
      }}
    >
      {roomInitial(title)}
    </div>
  );
};

export const SourceBadges = ({ c }: { c: Contact }) => (
  <span className="flex gap-1 shrink-0">
    {c.sources.map((s) => (
      <span
        key={s}
        className="rounded-full px-[6px] py-[1px] text-[9px] font-bold"
        style={{ background: '#1b1c20', color: MUTED, border: `1px solid ${LINE}` }}
      >
        {SOURCE_LABEL[s]}
      </span>
    ))}
  </span>
);

const ActionBtn = ({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    className="flex items-center gap-1 rounded-xl px-2 py-1 text-[11px] font-bold disabled:opacity-30"
    style={{ background: PANEL, color: GOLD, border: `1px solid ${LINE}` }}
  >
    {icon}
    {label}
  </button>
);

/** Friend sources we can't read yet, said out loud rather than hidden. */
export const SOURCES_NOTE: { name: string; note: string }[] = [
  { name: 'Twetch', note: 'Twetch’s API is offline (503), so follows can’t be imported.' },
  { name: 'HandCash', note: 'Needs bChat to keep your HandCash login and expose your friends.' },
  { name: 'Treechat', note: 'Treechat has no public API.' },
];

export const ContactRow = ({
  c,
  onMessage,
  onRemove,
  busy,
  fav,
  onLeave,
  extra,
}: {
  /** Shown under the actions (Wallet › Friends: their personal token). */
  extra?: ReactNode;
  c: Contact;
  onMessage: (c: Contact) => void;
  onRemove: ((c: Contact) => void) | null;
  busy: boolean;
  /** Favourite star (Calls › Contacts). */
  fav?: { on: boolean; toggle: () => void };
  /** Called after Pay switches tab (lets a sheet close itself). */
  onLeave?: () => void;
}) => {
  const { handleSelect } = useBottomMenu();
  const pay = payTarget(c);
  return (
    <li className="flex items-center gap-3 py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
      <Avatar title={c.name} src={c.avatar} size={40} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[14px] font-semibold text-white ${ELLIPSIS}`}>{c.name}</span>
          <SourceBadges c={c} />
        </div>
        <div className={`text-[11px] ${ELLIPSIS}`} style={{ color: MUTED }}>
          {contactLine(c)}
        </div>
        <div className="flex gap-1 mt-1">
          <ActionBtn
            label="Message"
            icon={<MessageCircle size={12} />}
            disabled={!canMessage(c) || busy}
            onClick={() => onMessage(c)}
          />
          <ActionBtn
            label="Call"
            icon={<Phone size={12} />}
            disabled={!canCall(c)}
            onClick={() => c.identityKey && void dial({ key: c.identityKey, label: c.name, verified: true })}
          />
          <ActionBtn
            label="Pay"
            icon={<Wallet size={12} />}
            disabled={!pay}
            onClick={() => {
              if (!pay) return;
              requestPay(pay);
              handleSelect(asMenuItem('bsv'));
              onLeave?.();
            }}
          />
        </div>
        {extra}
      </div>
      {fav && (
        <button onClick={fav.toggle} aria-label={fav.on ? 'Unfavourite' : 'Favourite'} className="p-2">
          <Star size={16} color={fav.on ? GOLD : MUTED} fill={fav.on ? GOLD : 'none'} />
        </button>
      )}
      {onRemove && c.bchatId && (
        <button onClick={() => onRemove(c)} aria-label="Remove contact" className="p-2">
          <Trash2 size={15} color={MUTED} />
        </button>
      )}
    </li>
  );
};
