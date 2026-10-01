import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { AccountAvatar } from './AccountAvatar';
import { identityRowText } from './identityText';

/** Height of the identity row (px). Pages under the TopNav get this much extra top offset. */
export const IDENTITY_ROW_H = 32;

/**
 * The second row under the TopNav: avatar, account name, $handle and handle@bwallet.space
 * (tap to copy), verified tick. Compact, translucent dark. Rendered by the mobile TopNav, which
 * also renders the in-flow spacer that pushes page content down by IDENTITY_ROW_H.
 */
export const IdentityRow = ({
  avatar,
  displayName,
  paymail,
  handle,
  verified,
  onGetName,
}: {
  avatar: string;
  displayName: string;
  paymail: string;
  handle: string;
  verified: boolean;
  onGetName: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const t = identityRowText(displayName, paymail, handle);
  const copy = () => {
    if (!t.copy) return onGetName();
    navigator.clipboard
      ?.writeText(t.copy)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };
  return (
    <div
      className="fixed left-0 w-full z-10 flex items-center justify-center px-3"
      style={{
        top: 'calc(var(--wallet-inset-top, 0px) + 3.5rem)',
        height: IDENTITY_ROW_H,
        background: 'rgba(12,13,16,0.72)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <button
        type="button"
        onClick={copy}
        aria-label={t.copy ? `Copy ${t.copy}` : 'Get your $name'}
        className="flex items-center gap-1.5 min-w-0 max-w-full bg-transparent border-0 p-0 cursor-pointer"
      >
        <AccountAvatar src={avatar} size={20} />
        {t.name && <span className="text-xs font-semibold text-white truncate max-w-[40%]">{t.name}</span>}
        {verified && (
          <span aria-label="Verified identity" title="Verified identity" style={{ color: '#2ecc71' }}>
            <Check size={12} strokeWidth={3} />
          </span>
        )}
        {t.tag ? (
          <span className="text-xs font-bold" style={{ color: '#FFD24D' }}>
            {t.tag}
          </span>
        ) : (
          <span className="text-xs font-semibold" style={{ color: '#FFD24D' }}>
            Get your $name
          </span>
        )}
        {t.full && (
          <span className="text-[11px] truncate min-w-0" style={{ color: '#98A2B3' }}>
            {t.full}
          </span>
        )}
        {t.copy &&
          (copied ? (
            <Check size={12} color="#2ecc71" className="shrink-0" />
          ) : (
            <Copy size={12} color="#98A2B3" className="shrink-0" />
          ))}
      </button>
    </div>
  );
};
