import { openBMail } from '../bmail/store';
import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, AtSign, Bell, Coins, Heart, Lock, Mailbox, MessageCircle, Phone, Quote, Tag } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { feedTimeLabel } from '../feed/post';
import { unreadCount, type NotifyItem, type NotifyKind, type NotifyTarget } from './notify';
import { clearItems, getItems, readAll, readOne, subscribeItems } from './store';
import { askNotifyPermissionOnce, pollNow } from './engine';

const GOLD = '#FFD24D';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

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

const useNotifications = () => useSyncExternalStore(subscribeItems, getItems, getItems);

/** Feed header bell: unread badge; opens the notifications list. */
export const NotificationsBell = ({
  onOpenPost,
}: {
  onOpenPost: (t: Extract<NotifyTarget, { type: 'post' }>) => void;
}) => {
  const items = useNotifications();
  const [open, setOpen] = useState(false);
  const unread = unreadCount(items);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          void askNotifyPermissionOnce();
          void pollNow();
        }}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative p-2 rounded-full active:opacity-60"
      >
        <Bell size={18} color={unread ? GOLD : MUTED} />
        {unread > 0 && (
          <span
            className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-bold leading-[16px] text-center"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <NotificationsSheet
          items={items}
          onClose={() => {
            setOpen(false);
            readAll();
          }}
          onOpenPost={(t) => {
            setOpen(false);
            readAll();
            onOpenPost(t);
          }}
        />
      )}
    </>
  );
};

const NotificationsSheet = ({
  items,
  onClose,
  onOpenPost,
}: {
  items: NotifyItem[];
  onClose: () => void;
  onOpenPost: (t: Extract<NotifyTarget, { type: 'post' }>) => void;
}) => {
  useBackClose(true, onClose);
  const { handleSelect } = useBottomMenu();
  const open = (i: NotifyItem) => {
    readOne(i.id);
    const t = i.target;
    if (!t) return;
    if (t.type === 'post') return onOpenPost(t);
    onClose();
    if (t.type === 'bmail') return openBMail();
    handleSelect(asMenuItem(t.type === 'room' || t.type === 'calls' ? 'chat' : 'bsv'));
  };
  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: '#010101' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onClose} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white truncate flex-1">Notifications</span>
        {items.length > 0 && (
          <button onClick={clearItems} className="px-3 py-1 text-xs" style={{ color: MUTED }}>
            Clear
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto pb-24">
        {!items.length && (
          <div className="px-8 pt-14 text-center">
            <p className="text-sm text-white font-semibold">Nothing yet</p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              Replies, mentions, likes, locks, room messages, payments and sales show up here while bWallet is open.
              Choose which in Settings → Notifications.
            </p>
          </div>
        )}
        {items.map((i) => {
          const Icon = ICONS[i.kind] ?? Bell;
          return (
            <button
              key={i.id}
              onClick={() => open(i)}
              className="w-full flex items-start gap-3 px-4 py-3 text-left"
              style={{
                borderBottom: `1px solid ${LINE}`,
                background: i.read ? 'transparent' : 'rgba(255,210,77,0.05)',
              }}
            >
              <Icon size={18} color={i.read ? MUTED : GOLD} className="mt-0.5 shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold text-white">{i.title}</span>
                {i.body && (
                  <span className="block text-[13px] mt-0.5 break-words" style={{ color: MUTED }}>
                    {i.body}
                  </span>
                )}
              </span>
              <span className="text-[11px] shrink-0" style={{ color: MUTED }}>
                {feedTimeLabel(i.at)}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
};
