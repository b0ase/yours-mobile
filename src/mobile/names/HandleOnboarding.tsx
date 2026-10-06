import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { accountNamesFor } from './MyNameBadge';
import { onAccountNamesChange, syncAccountNames } from './accountName';
import { HandleFlow } from './HandleFlow';
import { getPersonalLink, onPersonalChange } from './personalToken';
import { recoverPersonalLink } from './claimPersonal';
import {
  clearPendingPrompt,
  dismissCard,
  handleComplete,
  getPendingPrompt,
  isCardDismissed,
  onHandlePromptChange,
  shouldShowCard,
  shouldShowOnboarding,
} from './handlePrompt';

/**
 * Wallet tab (build-time insert into BsvWallet.tsx):
 *  - the "Choose your handle" step after a new wallet / restore (flag set by the onboarding inserts);
 *  - otherwise a dismissible "Get your $name" card until the account has a handle and its room.
 */
export const HandleOnboarding = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses?.identityAddress;
  const [hasName, setHasName] = useState(() => !!accountNamesFor(id).payable);
  const [synced, setSynced] = useState(false);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => isCardDismissed(id));
  const [hasRoom, setHasRoom] = useState(() => !!getPersonalLink(id));

  useEffect(() => {
    const update = () => {
      setHasName(!!accountNamesFor(id).payable);
      setDismissed(isCardDismissed(id));
      setHasRoom(!!getPersonalLink(id));
    };
    update();
    const a = onAccountNamesChange(update);
    const b = onHandlePromptChange(update);
    const c = onPersonalChange(update);
    return () => {
      a();
      b();
      c();
    };
  }, [id]);

  // A token minted before its local link was saved (or with app data cleared): restore the link
  // from this wallet's own deploy, so the card stops asking and "Finish setting up" can show.
  const payable = accountNamesFor(id).payable;
  useEffect(() => {
    if (!apiContext || !id || !payable || hasRoom) return;
    recoverPersonalLink(apiContext, id, payable)
      .then((l) => l && setHasRoom(true))
      .catch(() => undefined);
  }, [apiContext, id, payable, hasRoom]);

  // A restored wallet may already own a paymail / OpNS name: ask the chain first.
  useEffect(() => {
    if (!apiContext || !id) return;
    let live = true;
    // Only a lookup that answered counts: a failed one (the wallet still syncing after a restore) must not
    // read as "no name" and ask a restored wallet to pick one again (owner, 6 Oct 2026). Retry instead.
    let tries = 0;
    const attempt = () =>
      syncAccountNames(apiContext, id, { force: true })
        .catch(() => false)
        .then((ok) => {
          if (!live) return;
          if (ok) setSynced(true);
          else if (++tries < 6) setTimeout(attempt, 10_000);
        });
    attempt();
    return () => {
      live = false;
    };
  }, [apiContext, id]);

  // Open the onboarding step once per flag; a restore that turns out to be named just clears it.
  useEffect(() => {
    const pending = getPendingPrompt();
    if (!pending || pending.id !== id) return;
    if (shouldShowOnboarding(pending, id, hasName, synced)) setOpen(true);
    else if (hasName && (synced || pending.reason === 'create')) clearPendingPrompt();
  }, [id, hasName, synced]);

  const close = () => {
    clearPendingPrompt();
    setOpen(false);
  };

  if (open) return <HandleFlow onClose={close} />;
  // An unindexed personal token is offered by the Wallet's indexing list (tokens/WalletIndexing), once.
  // Not before the name check has answered: a restored wallet that owns a name must never be asked for one.
  if (!id || !synced || !shouldShowCard(handleComplete(hasName, hasRoom), dismissed, open)) return null;
  return (
    <div
      className="relative flex items-center gap-3 w-[92%] mt-4 rounded-2xl px-4 py-3 cursor-pointer"
      style={{ background: '#17191E', border: '1px solid #3a2f0c' }}
      onClick={() => setOpen(true)}
      role="button"
      aria-label="Get your $name"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: '#2a2410' }}
      >
        <Sparkles size={16} color="#FFD24D" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold" style={{ color: '#FFD24D' }}>
          {hasName ? 'Open your $name room' : 'Get your $name'}
        </div>
        <div className="text-[11px]" style={{ color: '#98A2B3' }}>
          {hasName
            ? 'Your personal token and a chat room only holders can enter.'
            : 'A free handle people can pay, plus your own chat room.'}
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          dismissCard(id);
        }}
        className="p-1.5 bg-transparent border-0 cursor-pointer"
      >
        <X size={14} color="#98A2B3" />
      </button>
    </div>
  );
};
