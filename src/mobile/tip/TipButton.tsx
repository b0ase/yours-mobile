import { useState, type MouseEvent } from 'react';
import { Coins } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { TipSheet } from './TipSheet';
import { useMe } from './useMe';
import { isSelf, tipRoute, type TipContext, type TipRecipient } from './tip';

const GOLD = '#FFD24D';

/**
 * The shared Tip button (owner, 12 Oct 2026: tip buttons everywhere by default). Small gold-outline coin + "Tip".
 * Renders nothing for your own items or when there is nowhere to pay.
 */
export const TipButton = ({
  to,
  context,
  compact = false,
  className = '',
}: {
  to: TipRecipient;
  context: TipContext;
  /** Icon only (message rows, track rows). */
  compact?: boolean;
  className?: string;
}) => {
  const { apiContext } = useServiceContext();
  const me = useMe();
  const [open, setOpen] = useState(false);
  if (!apiContext?.wallet || !tipRoute(to) || (me && isSelf(to, me))) return null;
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setOpen(true);
  };
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        aria-label={`Tip ${to.name}`}
        title={`Send a tip to ${to.name}`}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full text-xs font-semibold ${compact ? 'p-1' : 'px-2 py-0.5'} ${className}`}
        style={{ border: `1px solid ${GOLD}66`, color: GOLD, background: 'transparent' }}
      >
        <Coins size={compact ? 13 : 14} />
        {!compact && 'Tip'}
      </button>
      {open && <TipSheet to={to} context={context} onClose={() => setOpen(false)} />}
    </>
  );
};
