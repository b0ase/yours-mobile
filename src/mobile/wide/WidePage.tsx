import type { ReactNode } from 'react';

const BackIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * The page title, shown in the wide top bar to the left of the Ask b bar (owner, 18 Oct 2026: the old title row above
 * every page wasted vertical space). Optional Back for sub-routes, the page's one h1, truncated when long.
 */
export const WideTitle = ({ title, onBack }: { title: string; onBack?: () => void }) => (
  <div className="ww-top-title">
    {onBack && (
      <button className="ww-page-back" onClick={onBack} aria-label="Back" title="Back">
        <BackIcon />
      </button>
    )}
    <h1 className="ww-page-title" title={title}>
      {title}
    </h1>
  </div>
);

/**
 * The one page template of the wide layout (wide.css "Page template"). Every sidebar destination renders inside it:
 * the same padding, the same card, the same background layer (the shell's, behind everything; screens' own clips are
 * hidden). The title lives in the top bar (WideTitle). Phone screens keep their own layout inside the card; their phone
 * title rows are hidden so the top-bar title is the only title.
 */
export const WidePage = ({
  bleed,
  children,
}: {
  /** Full-bleed content (a bApp): no padding. */
  bleed?: boolean;
  children: ReactNode;
}) => <section className={`ww-page${bleed ? ' is-bleed' : ''}`}>{children}</section>;

/** Empty state: one icon, one line, an optional action. Same everywhere. */
export const WideEmpty = ({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) => (
  <div className="ww-empty">
    <div className="ww-empty-title">{title}</div>
    {body && <div className="ww-empty-body">{body}</div>}
    {action}
  </div>
);

/** Notice / error line: one style for info and errors. */
export const WideNotice = ({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) => (
  <div className={`ww-notice is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {children}
  </div>
);
