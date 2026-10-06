/**
 * Open rooms UI pieces for Chat › Chatrooms (the list and conversation live in tabs/ChatPage.tsx):
 * the "+ New room" sheet (create, or join with an invite code), the room info / moderation
 * sheet, and the message menu (report, block, delete). Every build, store build included.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Copy, Flag, LogOut, Lock, ShieldCheck, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useSnackbar } from '../../hooks/useSnackbar';
import { type BchatClient } from './api';
import { ReportSheet } from '../ugc/UgcSheets';
import type { ChatMessage } from './messages';
import {
  formatInviteCode,
  inviteMessage,
  isStaff,
  memberRole,
  parseInviteCode,
  roomNameProblem,
  type OpenRoomCard,
  type OpenVisibility,
} from './openRooms';

const GOLD = '#FFD24D';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const RED = '#F97066';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const OSheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[85vh] overflow-y-auto rounded-t-3xl px-5 pt-4"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

const inputCls = 'w-full rounded-xl px-3 py-2 text-sm text-white outline-none';
const inputStyle = { background: PANEL, border: `1px solid ${LINE}` };
const goldBtn = 'w-full rounded-xl py-2 text-sm font-bold disabled:opacity-50';

// ───────────────────────────── + New room ─────────────────────────────

export const NewRoomSheet = ({
  client,
  onDone,
  onClose,
}: {
  client: BchatClient;
  /** Created or joined: open it. */
  onDone: (room: { ticker: string; name: string }) => void;
  onClose: () => void;
}) => {
  const [mode, setMode] = useState<'create' | 'code'>('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<OpenVisibility>('public');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    const bad = roomNameProblem(name);
    if (bad) return setError(bad);
    setBusy(true);
    setError('');
    try {
      const r = await client.createOpenRoom({
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
      });
      onDone({ ticker: r.ticker, name: r.name || name.trim() });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const c = parseInviteCode(code);
    if (!c) return setError('That doesn’t look like an invite code (8 letters and numbers).');
    setBusy(true);
    setError('');
    try {
      const r = await client.joinOpenRoom({ code: c });
      onDone({ ticker: r.ticker, name: r.name });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const tab = (m: 'create' | 'code', label: string) => (
    <button
      onClick={() => {
        setMode(m);
        setError('');
      }}
      className="flex-1 rounded-lg py-[6px] text-xs font-bold"
      style={mode === m ? { background: GOLD, color: '#1a1300' } : { color: MUTED }}
    >
      {label}
    </button>
  );

  return (
    <OSheet title="New room" onClose={onClose}>
      <div className="flex gap-1 rounded-xl p-1 mb-3" style={{ background: PANEL }}>
        {tab('create', 'Create a room')}
        {tab('code', 'Have an invite code?')}
      </div>
      {mode === 'create' ? (
        <div className="flex flex-col gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Room name"
            className={inputCls}
            style={inputStyle}
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
            rows={2}
            placeholder="What’s it about? (optional)"
            className={`${inputCls} resize-none`}
            style={inputStyle}
          />
          <div className="flex gap-2">
            {(
              [
                ['public', 'Public', 'Anyone can find and join'],
                ['invite', 'Invite only', 'Join with your invite code'],
              ] as const
            ).map(([v, label, sub]) => (
              <button
                key={v}
                onClick={() => setVisibility(v)}
                className="flex-1 rounded-xl px-3 py-2 text-left"
                style={{
                  background: PANEL,
                  border: `1px solid ${visibility === v ? GOLD : LINE}`,
                }}
              >
                <div className="text-sm font-semibold text-white flex items-center gap-1">
                  {v === 'invite' && <Lock size={12} color={GOLD} />} {label}
                </div>
                <div className="text-[11px]" style={{ color: MUTED }}>
                  {sub}
                </div>
              </button>
            ))}
          </div>
          <p className="text-[11px]" style={{ color: MUTED }}>
            Free. No token needed. Be kind: rooms that break the rules get closed.
          </p>
          <button
            onClick={create}
            disabled={busy || !name.trim()}
            className={goldBtn}
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy ? 'Creating…' : 'Create room'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Invite code, e.g. K7PX-M2QA"
            autoCapitalize="characters"
            className={inputCls}
            style={inputStyle}
          />
          <button
            onClick={join}
            disabled={busy || !code.trim()}
            className={goldBtn}
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy ? 'Joining…' : 'Join room'}
          </button>
        </div>
      )}
      {error && (
        <p className="text-xs mt-2" style={{ color: RED }}>
          {error}
        </p>
      )}
    </OSheet>
  );
};

// ───────────────────────────── Room info / moderation ─────────────────────────────

export const OpenRoomSheet = ({
  client,
  card,
  me,
  onChanged,
  onLeft,
  onClose,
}: {
  client: BchatClient;
  card: OpenRoomCard;
  me: string;
  onChanged: () => void;
  /** You left, or the room closed: back to the list. */
  onLeft: () => void;
  onClose: () => void;
}) => {
  const { addSnackbar } = useSnackbar();
  const [busy, setBusy] = useState('');
  const [reporting, setReporting] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState('');
  const [confirm, setConfirm] = useState<'leave' | 'close' | null>(null);
  const staff = isStaff(card);
  const owner = card.role === 'owner';

  const act = async (
    tag: string,
    action: Parameters<BchatClient['openRoomAction']>[1],
    extra: { handle?: string } = {},
    done?: () => void,
  ) => {
    setBusy(tag);
    setError('');
    try {
      await client.openRoomAction(card.ticker, action, extra);
      done?.();
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const copyCode = () => {
    if (!card.inviteCode) return;
    const text = inviteMessage(card.name, card.inviteCode);
    if (navigator.share) {
      void navigator.share({ text }).catch(() => {});
      return;
    }
    void navigator.clipboard
      ?.writeText(text)
      .then(() => addSnackbar('Invite copied', 'success'))
      .catch(() => {});
  };

  const roleTag = (h: string) => {
    const r = memberRole(card, h);
    return r === 'owner' ? 'owner' : r === 'moderator' ? 'mod' : '';
  };

  return (
    <OSheet title={card.name} onClose={onClose}>
      <div className="flex items-center gap-2 mb-1 text-[12px]" style={{ color: MUTED }}>
        {card.official && (
          <span className="inline-flex items-center gap-1 font-bold" style={{ color: GOLD }}>
            <ShieldCheck size={12} /> Official
          </span>
        )}
        <span>{card.visibility === 'public' ? 'Public room' : 'Invite only'}</span>
        <span>·</span>
        <span>
          {card.members.length} member{card.members.length === 1 ? '' : 's'}
        </span>
        {card.closed && <span style={{ color: RED }}>· Closed</span>}
      </div>
      {card.description && <p className="text-sm text-white mb-3 whitespace-pre-wrap">{card.description}</p>}

      {staff && card.inviteCode && (
        <div className="rounded-xl p-3 mb-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
          <div className="text-[11px] mb-1" style={{ color: MUTED }}>
            Invite code
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-lg font-bold tracking-widest" style={{ color: GOLD }}>
              {formatInviteCode(card.inviteCode)}
            </span>
            <button
              onClick={copyCode}
              className="rounded-lg px-3 py-1 text-xs font-bold inline-flex items-center gap-1"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <Copy size={12} /> Share
            </button>
          </div>
          {owner && (
            <button
              onClick={() => void act('code', 'rotate_code')}
              disabled={!!busy}
              className="mt-2 text-[11px] underline"
              style={{ color: MUTED }}
            >
              {busy === 'code' ? 'Making a new code…' : 'New code (the old one stops working)'}
            </button>
          )}
        </div>
      )}

      {staff && !card.closed && (
        <div className="flex gap-2 mb-3">
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Add someone: $handle"
            className={inputCls}
            style={inputStyle}
          />
          <button
            onClick={() => void act('add', 'add', { handle: adding.trim() }, () => setAdding(''))}
            disabled={!adding.trim() || !!busy}
            className="rounded-xl px-3 text-sm font-bold disabled:opacity-50 inline-flex items-center gap-1"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            <UserPlus size={14} /> Add
          </button>
        </div>
      )}

      <div className="text-[11px] mb-1" style={{ color: MUTED }}>
        Members
      </div>
      <ul className="mb-3 max-h-56 overflow-y-auto">
        {card.members.map((h) => {
          const r = memberRole(card, h);
          const canRemove = staff && !card.closed && h !== me && r !== 'owner' && (owner || r === 'member');
          return (
            <li key={h} className="flex items-center gap-2 py-[6px]" style={{ borderBottom: `1px solid ${LINE}` }}>
              <span className="flex-1 text-sm text-white">
                ${h}
                {roleTag(h) && (
                  <span
                    className="ml-2 text-[10px] font-bold rounded-full px-2 py-[1px]"
                    style={{ background: '#2a2208', color: GOLD }}
                  >
                    {roleTag(h)}
                  </span>
                )}
              </span>
              {owner && !card.closed && h !== me && (
                <button
                  onClick={() => void act(`mod:${h}`, r === 'moderator' ? 'unmod' : 'mod', { handle: h })}
                  disabled={!!busy}
                  className="text-[11px] underline"
                  style={{ color: MUTED }}
                >
                  {r === 'moderator' ? 'Remove mod' : 'Make mod'}
                </button>
              )}
              {canRemove && (
                <button
                  onClick={() => void act(`rm:${h}`, 'remove', { handle: h })}
                  disabled={!!busy}
                  aria-label={`Remove $${h}`}
                  className="p-1"
                >
                  <UserMinus size={15} color={RED} />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-2">
        <button
          onClick={() => setReporting(true)}
          disabled={!!busy}
          className="w-full rounded-xl py-2 text-sm font-semibold text-white inline-flex items-center justify-center gap-2"
          style={{ background: PANEL }}
        >
          <Flag size={14} /> Report room
        </button>
        {!owner && (
          <button
            onClick={() => setConfirm('leave')}
            className="w-full rounded-xl py-2 text-sm font-semibold inline-flex items-center justify-center gap-2"
            style={{ background: PANEL, color: RED }}
          >
            <LogOut size={14} /> Leave room
          </button>
        )}
        {staff && !card.closed && (
          <button
            onClick={() => setConfirm('close')}
            className="w-full rounded-xl py-2 text-sm font-semibold inline-flex items-center justify-center gap-2"
            style={{ background: PANEL, color: RED }}
          >
            <Lock size={14} /> Close room
          </button>
        )}
        {confirm && (
          <div className="rounded-xl p-3" style={{ background: '#1a0d0c', border: `1px solid #3a1a17` }}>
            <p className="text-xs text-white mb-2">
              {confirm === 'leave'
                ? 'Leave this room? You can rejoin a public room any time; an invite-only room needs a new invite.'
                : 'Close this room for everyone? It becomes read-only and leaves the public list. This can’t be undone.'}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="flex-1 rounded-lg py-2 text-xs font-bold text-white"
                style={{ background: PANEL }}
              >
                Cancel
              </button>
              <button
                onClick={() => void act(confirm, confirm, {}, confirm === 'leave' ? onLeft : undefined)}
                disabled={!!busy}
                className="flex-1 rounded-lg py-2 text-xs font-bold"
                style={{ background: RED, color: '#1a0000' }}
              >
                {busy === confirm ? '…' : confirm === 'leave' ? 'Leave' : 'Close room'}
              </button>
            </div>
          </div>
        )}
      </div>
      {error && (
        <p className="text-xs mt-2" style={{ color: RED }}>
          {error}
        </p>
      )}
      {reporting && (
        <ReportSheet
          title={`Report ${card.name}`}
          report={{ kind: 'room', target: `$${card.ticker}`, details: `room: $${card.ticker} (${card.name})` }}
          onClose={() => setReporting(false)}
        />
      )}
    </OSheet>
  );
};

// ───────────────────────────── Message menu ─────────────────────────────

export const MessageMenu = ({
  client,
  ticker,
  message,
  me,
  canDelete,
  onDeleted,
  onBlock,
  onClose,
}: {
  client: BchatClient;
  ticker: string;
  message: ChatMessage;
  me: string;
  /** Owner / moderator of an open room. */
  canDelete: boolean;
  onDeleted: () => void;
  onBlock: (handle: string) => void;
  onClose: () => void;
}) => {
  const { addSnackbar } = useSnackbar();
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const author = (message.author_handle || '').replace(/^\$/, '');
  const mine = author.toLowerCase() === me.replace(/^\$/, '').toLowerCase();

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await client.openRoomAction(ticker, 'delete_message', { message_id: message.id });
      onDeleted();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const row =
    'w-full rounded-xl py-3 px-4 text-sm font-semibold text-left inline-flex items-center gap-3 disabled:opacity-50';

  return (
    <OSheet title={author ? `$${author}` : 'Message'} onClose={onClose}>
      <p className="text-xs mb-3 line-clamp-3" style={{ color: MUTED }}>
        {message.body}
      </p>
      <div className="flex flex-col gap-2">
        <>
          {!mine && (
            <button onClick={() => setReporting(true)} className={row} style={{ background: PANEL, color: '#fff' }}>
              <Flag size={16} /> Report message
            </button>
          )}
          {!mine && author && (
            <button
              onClick={() => {
                onBlock(author);
                addSnackbar(`Blocked $${author}. You won’t see their messages.`, 'success');
                onClose();
              }}
              className={row}
              style={{ background: PANEL, color: '#fff' }}
            >
              <Ban size={16} /> Block ${author}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => void remove()}
              disabled={busy}
              className={row}
              style={{ background: PANEL, color: RED }}
            >
              <Trash2 size={16} /> Delete for everyone
            </button>
          )}
          {mine && !canDelete && (
            <p className="text-xs" style={{ color: MUTED }}>
              This is your message.
            </p>
          )}
        </>
      </div>
      {error && (
        <p className="text-xs mt-2" style={{ color: RED }}>
          {error}
        </p>
      )}
      {reporting && (
        <ReportSheet
          title="Report message"
          report={{
            kind: 'room_message',
            target: message.id,
            content: message.body || undefined,
            details: `room: $${ticker}${author ? `, author: $${author}` : ''}`,
          }}
          onClose={() => setReporting(false)}
          onSent={() => addSnackbar('Thanks. We’ll review it.', 'success')}
        />
      )}
    </OSheet>
  );
};
