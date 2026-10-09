import type { ReactNode } from 'react';

/**
 * The one page template of the wide layout (wide.css "Page template"). Every sidebar destination renders inside it:
 * the same header (optional back, title, subtitle, actions on the right), the same padding, the same card, the same
 * background layer (the shell's, behind everything; screens' own clips are hidden). Phone screens keep their own
 * layout inside the card; their phone title rows are hidden so the page header is the only title.
 */
export const WidePage = ({
  title,
  subtitle,
  onBack,
  actions,
  bleed,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  /** Full-bleed content (a bApp): no header, no padding. */
  bleed?: boolean;
  children: ReactNode;
}) => (
  <section className={`ww-page${bleed ? ' is-bleed' : ''}`}>
    {!bleed && (
      <header className="ww-page-head">
        {onBack && (
          <button className="ww-page-back" onClick={onBack} aria-label="Back" title="Back">
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="ww-grow">
          <h1 className="ww-page-title">{title}</h1>
          {subtitle && <div className="ww-page-sub">{subtitle}</div>}
        </div>
        {actions && <div className="ww-page-actions">{actions}</div>}
      </header>
    )}
    {children}
  </section>
);

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
