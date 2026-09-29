import { Theme } from '../theme.types';

/** theme.settings.badge (e.g. "Experimental"), shown beside the product name. Renders nothing if unset. */
export const ThemeBadge = ({ theme, className = '' }: { theme: Theme; className?: string }) =>
  theme.settings.badge ? (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider select-none ${className}`}
      style={{ color: '#FDB022', backgroundColor: '#FDB0221F', border: '1px solid #FDB02259' }}
    >
      {theme.settings.badge}
    </span>
  ) : null;
