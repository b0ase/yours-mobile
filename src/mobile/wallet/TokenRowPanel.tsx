/**
 * Wallet token rows: tap to expand (owner, 13 Nov 2026: "the shortcut sliders are nice, but I think the token card
 * should expand on click also, not just slide left and right"). A tap opens this panel under the row with the
 * same actions the swipe trays give (Buy, Sell, Send, Receive, Chat, Lock) plus a little detail; a second tap
 * closes it. Swipes keep working (SwipeRow swallows the click that ends a swipe).
 */
import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Lock, MessageCircle, ShoppingCart, Tag } from 'lucide-react';

export type TokenRowAction = { id: string; label: string; icon: ReactNode; onPress: () => void };

/** The actions a row offers, in panel order; absent handlers are left out. */
export const rowPanelActions = (h: {
  onBuy?: () => void;
  onSell?: () => void;
  onSend?: () => void;
  onReceive?: () => void;
  onChat?: () => void;
  onLock?: () => void;
}): TokenRowAction[] =>
  (
    [
      ['buy', 'Buy', <ShoppingCart key="i" size={16} />, h.onBuy],
      ['sell', 'Sell', <Tag key="i" size={16} />, h.onSell],
      ['send', 'Send', <ArrowUpRight key="i" size={16} />, h.onSend],
      ['receive', 'Receive', <ArrowDownLeft key="i" size={16} />, h.onReceive],
      ['chat', 'Chat', <MessageCircle key="i" size={16} />, h.onChat],
      ['lock', 'Lock', <Lock key="i" size={16} />, h.onLock],
    ] as const
  ).flatMap(([id, label, icon, onPress]) => (onPress ? [{ id, label, icon, onPress }] : []));

export const TokenRowPanel = ({
  id,
  balance,
  tokenId,
  actions,
}: {
  /** DOM id, for the row's aria-controls. */
  id: string;
  /** The full balance, e.g. "0.5 BLASTER". */
  balance: string;
  tokenId: string;
  actions: TokenRowAction[];
}) => (
  <div id={id} className="w-full px-4 pb-3 pt-1 flex flex-col gap-2" role="region" aria-label="Token actions">
    <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
      <span className="truncate">
        You hold <span style={{ color: 'var(--bw-text, #fff)' }}>{balance}</span>
      </span>
      <span className="font-mono shrink-0" title={tokenId}>
        {tokenId.slice(0, 6)}…{tokenId.slice(-4)}
      </span>
    </div>
    <div className="grid grid-cols-3 gap-2">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            a.onPress();
          }}
          className="flex items-center justify-center gap-1.5 min-h-[44px] rounded-xl text-xs font-bold cursor-pointer border"
          style={
            a.id === 'buy'
              ? { background: 'var(--bw-accent)', borderColor: 'var(--bw-accent)', color: '#000' }
              : {
                  background: 'var(--bw-surface)',
                  borderColor: 'var(--bw-line, #2b2f36)',
                  color: 'var(--bw-text, #fff)',
                }
          }
        >
          {a.icon}
          {a.label}
        </button>
      ))}
    </div>
  </div>
);
