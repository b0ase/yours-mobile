import { ChevronDown, ChevronUp } from 'lucide-react';

/** The small chevron in a panel header. */
export const CollapseToggle = ({
  collapsed,
  onToggle,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) => (
  <button
    type="button"
    className="bw-home-toggle"
    aria-expanded={!collapsed}
    aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
    title={`${collapsed ? 'Show' : 'Hide'} ${label}`}
    onClick={onToggle}
  >
    {collapsed ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
  </button>
);
