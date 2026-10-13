/**
 * Desktop Notifications page (/m/notifications): the wide shell's bell opens this in the main column instead of the
 * phone's full-screen sheet (owner, 13 Oct 2026: "take up the space, not a narrow card"). Same store, same targets
 * as NotificationsPanel.tsx; the phone keeps its sheet.
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AtSign,
  Bell,
  CheckCheck,
  Coins,
  Heart,
  Lock,
  Mailbox,
  MessageCircle,
  Phone,
  Quote,
  Tag,
  Trash2,
} from 'lucide-react';
import { openBMail } from '../bmail/store';
import { CALLS_ROUTE } from '../calls/route';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { feedTimeLabel } from '../feed/post';
import { bavatarSvg } from '../bavatar/bavatar';
import { unreadCount, type NotifyItem, type NotifyKind } from './notify';
import { clearItems, getItems, readAll, readOne, subscribeItems } from './store';
import './notifications-page.css';

const ICONS: Record<NotifyKind, typeof Bell> = {
  reply: MessageCircle,
  quote: Quote,
  like: Heart,
  lock: Lock,
  mention: AtSign,
  chat: MessageCircle,
  call: Phone,
  payment: Coins,
  token: Coins,
  sale: Tag,
  bmail: Mailbox,
};

type Filter = 'all' | 'messages' | 'items' | 'mentions';
const FILTERS: { id: Filter; label: string; kinds?: NotifyKind[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages', kinds: ['chat', 'reply', 'quote', 'bmail', 'call'] },
  { id: 'items', label: 'Items', kinds: ['payment', 'token', 'sale'] },
  { id: 'mentions', label: 'Mentions', kinds: ['mention'] },
];

const EMPTY_ART = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg('notifications', { size: 160 }));

export default function NotificationsPage() {
  const items = useSyncExternalStore(subscribeItems, getItems, getItems);
  const [filter, setFilter] = useState<Filter>('all');
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: items.length, messages: 0, items: 0, mentions: 0 };
    for (const f of FILTERS) if (f.kinds) c[f.id] = items.filter((i) => f.kinds!.includes(i.kind)).length;
    return c;
  }, [items]);
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
  const shown = kinds ? items.filter((i) => kinds.includes(i.kind)) : items;
  const unread = unreadCount(items);

  const open = (i: NotifyItem) => {
    readOne(i.id);
    const t = i.target;
    if (!t) return;
    if (t.type === 'post') return navigate('/m/feed');
    if (t.type === 'bmail') return openBMail();
    if (t.type === 'calls') return navigate(CALLS_ROUTE);
    handleSelect(asMenuItem(t.type === 'room' ? 'chat' : 'bsv'));
  };

  return (
    <div className="nf-page">
      <div className="nf-bar">
        <div className="nf-chips" role="tablist" aria-label="Filter notifications">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? 'on' : ''}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {counts[f.id] > 0 && <span className="nf-count">{counts[f.id]}</span>}
            </button>
          ))}
        </div>
        <div className="nf-actions">
          <button onClick={readAll} disabled={!unread}>
            <CheckCheck size={15} /> Mark all read
          </button>
          <button onClick={clearItems} disabled={!items.length}>
            <Trash2 size={15} /> Clear
          </button>
        </div>
      </div>

      {!shown.length ? (
        <div className="nf-empty">
          <img src={EMPTY_ART} alt="" width={120} height={120} />
          <p className="nf-empty-title">{items.length ? 'Nothing here' : 'You’re all caught up'}</p>
          <p className="nf-empty-sub">
            {items.length
              ? 'No notifications of this kind yet.'
              : 'Replies, mentions, room messages, payments and sales show up here while bWalletX is open. Choose which in Settings → Notifications.'}
          </p>
        </div>
      ) : (
        <ul className="nf-list">
          {shown.map((i) => {
            const Icon = ICONS[i.kind] ?? Bell;
            const text = i.full || i.body;
            return (
              <li key={i.id}>
                <button className={`nf-row${i.read ? '' : ' unread'}`} onClick={() => open(i)}>
                  <span className="nf-icon" data-kind={i.kind}>
                    <Icon size={18} />
                  </span>
                  <span className="nf-main">
                    <span className="nf-title">{i.title}</span>
                    {text && <span className="nf-text">{text}</span>}
                  </span>
                  <span className="nf-meta">
                    <time dateTime={new Date(i.at).toISOString()}>{feedTimeLabel(i.at)}</time>
                    {!i.read && <span className="nf-dot" aria-label="Unread" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
