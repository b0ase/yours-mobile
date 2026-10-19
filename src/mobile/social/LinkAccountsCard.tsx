import { useEffect, useState } from 'react';
import { BadgeCheck, X } from 'lucide-react';
import { LinkAccountsStep } from './LinkAccountsStep';
import { getLinks, onLinksChange } from './links';

/**
 * Wallet home (owner, 19 Oct 2026): "Link your accounts" left onboarding and became a small dismissible card beside
 * Get your $name, in the same style. Hidden once the account has a link or the card is dismissed.
 */
const KEY = (owner: string) => `bw.linkCardDismissed.${owner}`;
const isDismissed = (owner: string) => {
  try {
    return localStorage.getItem(KEY(owner)) === '1';
  } catch {
    return false;
  }
};

export const LinkAccountsCard = ({ owner }: { owner: string }) => {
  const [count, setCount] = useState(() => getLinks(owner).length);
  const [dismissed, setDismissed] = useState(() => isDismissed(owner));
  const [open, setOpen] = useState(false);
  useEffect(() => onLinksChange(() => setCount(getLinks(owner).length)), [owner]);
  if (open) return <LinkAccountsStep owner={owner} onClose={() => setOpen(false)} />;
  if (count || dismissed) return null;
  return (
    <div
      className="relative flex items-center gap-3 w-[92%] mt-3 rounded-2xl px-4 py-3 cursor-pointer"
      style={{ background: 'var(--bw-surface)', border: '1px solid var(--bw-line, #3a2f0c)' }}
      onClick={() => setOpen(true)}
      role="button"
      aria-label="Link your accounts"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--bw-tint, #2a2410)' }}
      >
        <BadgeCheck size={16} color="var(--bw-accent-hi)" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold" style={{ color: 'var(--bw-accent-hi)' }}>
          Link your accounts
        </div>
        <div className="text-[11px]" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
          Add verified X / Google badges
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          try {
            localStorage.setItem(KEY(owner), '1');
          } catch {
            /* private window: dismiss for this view only */
          }
          setDismissed(true);
        }}
        className="p-1.5 bg-transparent border-0 cursor-pointer"
      >
        <X size={14} color="#98A2B3" />
      </button>
    </div>
  );
};
