/**
 * The one unread badge for tab bars and docks: a small red pill with a count (99+ cap) or a dot.
 * Absolutely placed (the parent must be `relative`), so it never shifts the layout. aria-hidden:
 * the parent carries the count in its label ("Chat, 3 unread").
 * Colours: --bw-badge / --bw-badge-text when a theme sets them, else red on white, ringed in the bar colour.
 */
import { tabBadgeText } from './tabBadgeText';

type Props = {
  /** Count to show; 0 or less renders nothing. */
  count?: number;
  /** Ready-made text (e.g. an existing string badge). Wins over count. */
  text?: string;
  /** A plain dot instead of a number. */
  dot?: boolean;
  className?: string;
};

export const TabBadge = ({ count = 0, text, dot, className = '-top-1 -right-1' }: Props) => {
  const label = text ?? tabBadgeText(count);
  if (!label && !(dot && count > 0)) return null;
  const style = {
    background: 'var(--bw-badge, #F04438)',
    color: 'var(--bw-badge-text, #FFFFFF)',
    boxShadow: '0 0 0 1.5px var(--bw-bg, #0A0B0D)',
  };
  if (dot && !text)
    return (
      <span
        aria-hidden
        data-testid="tab-badge"
        className={`pointer-events-none absolute h-2.5 w-2.5 rounded-full ${className}`}
        style={style}
      />
    );
  return (
    <span
      aria-hidden
      data-testid="tab-badge"
      className={`pointer-events-none absolute min-w-4 h-4 px-1 rounded-full text-[9px] font-bold leading-none tabular-nums flex items-center justify-center ${className}`}
      style={style}
    >
      {label}
    </span>
  );
};

export default TabBadge;
