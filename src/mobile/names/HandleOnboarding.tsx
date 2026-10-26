import { useEffect, useState } from 'react';
import { Coins, MessageCircle, Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestRoomByTicker } from '../chat/segmentNav';
import { chatClient } from '../tickets/mintTicket';
import { PersonalTokenLauncher } from './PersonalTokenLauncher';
import { ensureNameRoom, getNameRooms, onNameRoomsChange, orderNameRooms, type NameRoom } from './nameRooms';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useLegacyKeys } from './useLegacyKeys';
import { accountNamesFor } from './accountNames';
import { onAccountNamesChange, syncAccountNames } from './accountName';
import { HandleFlow } from './HandleFlow';
import { LINK_ACCOUNTS_ENABLED, PAID_FEATURES_ENABLED, handleCardText } from '../storeBuild';
import { LinkAccountsStep } from '../social/LinkAccountsStep';
import { LinkAccountsCard } from '../social/LinkAccountsCard';
import { getPersonalLink, onPersonalChange } from './personalToken';
import { existingChoice, recoverPersonalLink } from './claimPersonal';
import {
  clearPendingPrompt,
  dismissCard,
  handleCardTitle,
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
  const legacy = useLegacyKeys();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses?.identityAddress;
  const [hasName, setHasName] = useState(() => !!accountNamesFor(id).payable);
  const [synced, setSynced] = useState(false);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => isCardDismissed(id));
  const [hasRoom, setHasRoom] = useState(() => !!getPersonalLink(id));
  // Owner, 26 Oct 2026: "Open your $name room" opens the name's free room in Chat (nameRooms.ts), never Choose your
  // handle; the token launcher has its own "Launch your tokens" card.
  const [nameRooms, setNameRooms] = useState<NameRoom[]>(() => getNameRooms(id));
  useEffect(() => onNameRoomsChange(() => setNameRooms(getNameRooms(id))), [id]);
  const [launching, setLaunching] = useState(false);
  const [chooser, setChooser] = useState<NameRoom[] | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState('');
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  const goRoom = (ticker: string) => {
    setChooser(null);
    requestRoomByTicker(ticker, false);
    handleSelect(asMenuItem('chat'));
    navigate('/m/chat');
  };
  /** The primary name's room (made now, free, if this device has none yet); several rooms → a chooser, primary first. */
  const openNameRoom = async () => {
    setRoomError('');
    const have = orderNameRooms(getNameRooms(id));
    if (have.length > 1) return setChooser(have);
    if (have.length === 1) return goRoom(have[0].ticker);
    const alias = (accountNamesFor(id).payable || '').split('@')[0];
    if (!apiContext || !id || !alias) return;
    setRoomBusy(true);
    try {
      goRoom((await ensureNameRoom(await chatClient(apiContext), id, alias, true)).ticker);
    } catch (e) {
      setRoomError(e instanceof Error ? e.message : 'Could not open your room');
    } finally {
      setRoomBusy(false);
    }
  };

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

  // The handle matches a token this account controls: the card offers the import instead of a new mint.
  const [importSym, setImportSym] = useState<string | null>(null);
  useEffect(() => {
    if (!apiContext || !id || !payable || hasRoom || !PAID_FEATURES_ENABLED) return setImportSym(null);
    let live = true;
    existingChoice(apiContext, payable, undefined, legacy)
      .then((c) => live && setImportSym(c.kind === 'import' ? c.token.sym : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext, id, payable, hasRoom, legacy]);

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
    // Owner, 19 Oct 2026: create + backup lands straight on the wallet. No "Claim your name" / "Link your accounts"
    // screens after a new wallet; the Get your $name chip and card on the wallet home stay.
    if (pending.reason === 'create') return clearPendingPrompt();
    if (shouldShowOnboarding(pending, id, hasName, synced)) setOpen(true);
    else if (hasName && synced) clearPendingPrompt();
  }, [id, hasName, synced]);

  // A new wallet's "Claim your name" step continues with "Link your accounts" (owner, 18 Oct 2026), skippable.
  const [linking, setLinking] = useState(false);
  const close = () => {
    const fromCreate = getPendingPrompt()?.reason === 'create';
    clearPendingPrompt();
    setOpen(false);
    if (fromCreate && LINK_ACCOUNTS_ENABLED) setLinking(true);
  };

  if (LINK_ACCOUNTS_ENABLED && linking && id) return <LinkAccountsStep owner={id} onClose={() => setLinking(false)} />;
  if (launching) return <PersonalTokenLauncher onClose={() => setLaunching(false)} />;
  if (open)
    return (
      <HandleFlow onClose={close} title={getPendingPrompt()?.reason === 'create' ? 'Claim your name' : undefined} />
    );
  // An unindexed personal token is offered by the Wallet's indexing list (tokens/WalletIndexing), once.
  // Not before the name check has answered: a restored wallet that owns a name must never be asked for one.
  const linkCard = LINK_ACCOUNTS_ENABLED && id ? <LinkAccountsCard owner={id} /> : null;
  // "Launch your tokens" (owner, 26 Oct 2026): the personal token launcher, moved out of onboarding. Optional, later.
  const tokenCard =
    id && synced && hasName && PAID_FEATURES_ENABLED && !hasRoom ? (
      <div
        className="flex items-center gap-3 w-[92%] mt-4 rounded-2xl px-4 py-3 cursor-pointer"
        style={{ background: 'var(--bw-surface)', border: '1px solid var(--bw-line, #3a2f0c)' }}
        onClick={() => setLaunching(true)}
        role="button"
        aria-label="Launch your tokens"
        data-testid="launch-tokens-card"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--bw-tint, #2a2410)' }}
        >
          <Coins size={16} color="var(--bw-accent-hi)" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold" style={{ color: 'var(--bw-accent-hi)' }}>
            {importSym ? handleCardTitle(true, importSym) : 'Launch your tokens'}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            Optional: a personal token on your own launch curve. Your rooms are free without one.
          </div>
        </div>
      </div>
    ) : null;
  const roomChooser = chooser ? (
    <div className="w-[92%] mt-2 rounded-2xl p-2" style={{ background: 'var(--bw-surface)' }} role="menu">
      {chooser.map((r) => (
        <button
          key={r.ticker}
          type="button"
          onClick={() => goRoom(r.ticker)}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm text-white bg-transparent border-0"
        >
          <span>${r.alias}&apos;s room</span>
          {r.primary ? (
            <span className="text-[11px]" style={{ color: 'var(--bw-accent-hi)' }}>
              Primary
            </span>
          ) : null}
        </button>
      ))}
    </div>
  ) : null;
  if (!id || !synced || !shouldShowCard(handleComplete(hasName, nameRooms.length > 0), dismissed, open))
    return (
      <>
        {tokenCard}
        {linkCard}
      </>
    );
  return (
    <>
      <div
        className="relative flex items-center gap-3 w-[92%] mt-4 rounded-2xl px-4 py-3 cursor-pointer"
        style={{ background: 'var(--bw-surface)', border: '1px solid var(--bw-line, #3a2f0c)' }}
        onClick={() => (hasName ? void openNameRoom() : setOpen(true))}
        role="button"
        aria-label={hasName ? 'Open your $name room' : 'Get your $name'}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--bw-tint, #2a2410)' }}
        >
          {hasName ? (
            <MessageCircle size={16} color="var(--bw-accent-hi)" />
          ) : (
            <Sparkles size={16} color="var(--bw-accent-hi)" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold" style={{ color: 'var(--bw-accent-hi)' }}>
            {roomBusy ? 'Opening your room…' : handleCardTitle(hasName, null)}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
            {roomError ||
              (hasName ? 'Free. Invite guests or open it to visitors, your choice.' : handleCardText(hasName))}
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
      {roomChooser}
      {tokenCard}
      {linkCard}
    </>
  );
};
