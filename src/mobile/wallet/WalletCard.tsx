import * as qr from 'qrcode';
import { cardArtQrSvg, cardPaymail, svgDataUri } from './cardBackQr';
import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Check, Copy, Loader2, PenLine, RefreshCw, ScanLine } from 'lucide-react';
import { myPayUri } from '../scan/payUri';
import { isBWalletX } from '../storeBuild';
import { cardFrontArtUri } from './cardFrontArt';

// Edition colour (owner, 10 Oct 2026): bWallet's card is yellow with black text, like its app icon; bWalletX keeps
// the black card that turns gold with the balance. One card, two palettes (.bw-wcard.is-yellow in mobile.css).
const YELLOW_CARD = !isBWalletX();

const ScanSheet = lazy(() => import('../scan/ScanSheet'));
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { formatUSD } from '../../utils/format';
import { fiatSymbol } from '../../utils/displayCurrency';
import { useDisplayCurrency } from '../../hooks/useDisplayCurrency';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AccountAvatar } from '../names/AccountAvatar';
import { useAvatar } from '../names/useAvatar';
import { HandleFlow } from '../names/HandleFlow';
import { useAccountNames } from '../names/accountNames';
import { identityRowText } from '../names/identityText';
import type { BalanceView } from './balanceLoad';
import { useBackedUp } from '../backup/useBackedUp';
import { ghostColorOf, onAgentsChange } from '../agents/agentAccounts';
import { PixelGhost } from '../agents/PixelGhost';
import { requestBackupThen } from '../backup/backupState';
import { useCardSignature } from '../signature/useCardSignature';
import { cardGoldLevel } from './cardGold';
import { keyFingerprint } from './identityLine';
import { useBchatFollow } from './useBchatFollow';
import { useChatIdentity } from './useChatIdentity';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { requestIdentityMap } from '../settings/signIns';
import { LiveTicker } from './live/LiveTicker';
import { noteBalance, useLive } from './live/liveBus';
import { displayedSats, refreshDelay } from './live/liveLogic';
import { useCountUp } from './live/useCountUp';
import { cardSats, memberSince, cardBsv, loadCardUnit, saveCardUnit, type CardUnit } from './walletCardText';

export type WalletCardProps = {
  /** Total in US dollars (BSV at the current rate, plus MNEE when enabled). */
  usd: number;
  /** BSV balance in satoshis. */
  sats: number;
  /** From balanceView(): spinner while loading, unknown when no balance is known yet. */
  view: BalanceView;
  syncing: boolean;
  failed: boolean;
  onRetry: () => void;
  receiveAddress: string;
  /** Manual refresh (icon on the card); also run quietly every minute and when the wallet comes back into view. */
  onRefresh?: (manual: boolean) => void;
  refreshing?: boolean;
  /** Balance hidden (privacy): the card shows a neutral gold so its colour does not reveal the balance. */
  balanceHidden?: boolean;
  /** USD per BSV, so an optimistic spend moves the dollar figure too (live/). 0 or absent: dollars follow the fetch. */
  rate?: number;
};

const SIG_HINT_KEY = 'bwallet.cardSigHintSeen';
const sigHintSeen = () => {
  try {
    return localStorage.getItem(SIG_HINT_KEY) === '1';
  } catch {
    return true;
  }
};
const markSigHintSeen = () => {
  try {
    localStorage.setItem(SIG_HINT_KEY, '1');
  } catch {
    /* private mode: the hint just shows again next time */
  }
};

/**
 * Wallet home balance as a premium membership card (not a payment card: no card number, chip, date
 * or network logo). Front: b mark, dollars first with sats below, the $handle where a cardholder name
 * would go. Tap to flip: receive QR, and a signature strip with the identity key fingerprint.
 * Replaces WalletIdentity + the "Total balance" header. Styles in src/mobile/mobile.css (.bw-wcard*).
 */
const WalletCardInner = ({
  usd,
  sats,
  view,
  syncing,
  failed,
  onRetry,
  receiveAddress,
  onRefresh,
  refreshing = false,
  balanceHidden = false,
  rate = 0,
}: WalletCardProps) => {
  // Live balance (owner, 8 Oct 2026: "see my balance ticking down as I pay … or ticking up as I'm paid").
  // Spends the wallet just signed come off at once; the next fetch reconciles (live/liveBus.ts).
  const fx = useDisplayCurrency();
  const live = useLive();
  const sessionsOpen = Object.keys(live.sessions).length;
  const known = view === 'amount';
  useEffect(() => {
    if (known) noteBalance(sats);
  }, [sats, known]);
  const pendingSats = sats - displayedSats(sats, live.pending);
  const shownSats = known ? sats - pendingSats : sats;
  const count = useCountUp(shownSats, known);
  const animSats = known ? count.value : sats;
  const animUsd = rate > 0 ? usd + ((animSats - sats) * rate) / 100_000_000 : usd;

  // Quiet refresh: every 5 s while something is happening (a spend, a live session, just opened), else every
  // 20 s; never while hidden (balances otherwise only loaded once: owner, 4 Oct 2026). Battery/rate: the fast
  // lane lasts two minutes after the last activity, and each refresh is skipped while one is in flight.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const activityRef = useRef(live.lastActivityAt);
  activityRef.current = live.lastActivityAt;
  const sessionsRef = useRef(sessionsOpen);
  sessionsRef.current = sessionsOpen;
  useEffect(() => {
    if (!onRefresh) return;
    let timer: number | null = null;
    const visible = () => document.visibilityState === 'visible';
    const plan = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      const d = refreshDelay({
        visible: visible(),
        lastActivityAt: activityRef.current,
        now: Date.now(),
        liveSessions: sessionsRef.current,
      });
      if (d !== null)
        timer = window.setTimeout(() => {
          refreshRef.current?.(false);
          plan();
        }, d);
    };
    const quiet = () => {
      if (visible()) refreshRef.current?.(false);
      plan();
    };
    plan();
    document.addEventListener('visibilitychange', quiet);
    window.addEventListener('focus', quiet);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', quiet);
      window.removeEventListener('focus', quiet);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onRefresh]);
  // After a spend, fetch once shortly after so the card settles on the real number (fee included).
  useEffect(() => {
    if (!live.pending.length) return;
    const t = window.setTimeout(() => refreshRef.current?.(false), 1_500);
    return () => window.clearTimeout(t);
  }, [live.pending.length]);
  const { chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [flipped, setFlipped] = useState(false);
  const [unit, setUnit] = useState<CardUnit>(loadCardUnit);
  const pickUnit = (u: CardUnit) => (e: MouseEvent) => {
    e.stopPropagation();
    setUnit(u);
    saveCardUnit(u);
  };
  const [handleOpen, setHandleOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses.identityAddress;
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const avatar = useAvatar(id);
  // Agent accounts wear a ghost in their colour (agents/PixelGhost); re-read when agent settings change.
  const [ghost, setGhost] = useState(() => ghostColorOf(id));
  useEffect(() => {
    setGhost(ghostColorOf(id));
    return onAgentsChange(() => setGhost(ghostColorOf(id)));
  }, [id]);
  const { kyc } = useKyc();
  const verified = kycValid(kyc, Date.now());
  const t = identityRowText(names.displayName, names.paymail, names.handle);
  // No account creation time is stored today; memberSince() returns '' and the line is omitted.
  const since = memberSince((account as { createdAt?: number } | undefined)?.createdAt);

  // The front's art: the account's bAvatar (bWalletX only; bWallet keeps its yellow card). Cached per key.
  const frontArt = useMemo(
    () => cardFrontArtUri(account?.pubKeys?.identityPubKey, YELLOW_CARD),
    [account?.pubKeys?.identityPubKey],
  );

  // The back's QR: the account's bAvatar art QR (its paymail), else the plain receive QR below.
  const artQr = useMemo(
    () => (flipped ? svgDataUri(cardArtQrSvg(account?.pubKeys?.identityPubKey, names.paymail, 512)) : ''),
    [flipped, account?.pubKeys?.identityPubKey, names.paymail],
  );

  useEffect(() => {
    if (!flipped || !receiveAddress || artQr) return;
    // BIP21 so other wallets (and another bWallet's Scan) read it as a payment code.
    qr.toDataURL(
      myPayUri(receiveAddress),
      { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } },
      (err, url) => {
        if (!err) setQrUrl(url);
      },
    );
  }, [flipped, receiveAddress, artQr]);

  const copy = (text: string) => (e: MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => addSnackbar('Copied', 'success'))
      .catch(() => undefined);
  };
  const [turning, setTurning] = useState(false);
  // Swap faces at the midpoint of the 2D turn (CSS .is-turning).
  const backedUp = useBackedUp();
  const [hintSeen, setHintSeen] = useState(sigHintSeen);
  const turn = () => {
    if (turning) return;
    if (!hintSeen) {
      markSigHintSeen();
      setHintSeen(true);
    }
    setTurning(true);
    setTimeout(() => setFlipped((f) => !f), 220);
    setTimeout(() => setTurning(false), 440);
  };
  // The back is the receive QR: not backed up → the Backup step first (src/mobile/backup).
  const flip = () => (flipped ? turn() : requestBackupThen(chromeStorageService, turn));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  };
  const sig = useCardSignature(id);
  // `$handle · 02cbe7…6ed8` under the name: which chat identity this account is using (identityLine.ts).
  const chat = useChatIdentity(id);
  // bChatX follows this wallet account (owner, 10 Oct 2026): the card shows $handle + fingerprint only;
  // mismatches are fixed quietly here and choice/privacy live in Settings › bChatX (bchatFollow.ts).
  useBchatFollow(id, chat, names.paymail);
  const fingerprint = keyFingerprint(chat.identityKey);
  // Long-press the identity line: Settings › Identity map. Tap still copies the key.
  const selectTab = useContext(BottomMenuContext)?.handleSelect;
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const openIdMap = () => {
    longPressed.current = true;
    selectTab?.(asMenuItem('settings'));
    requestIdentityMap();
  };
  const idLinePress = {
    onTouchStart: () => {
      clearPress();
      longPressed.current = false;
      pressTimer.current = window.setTimeout(openIdMap, 550);
    },
    onTouchEnd: clearPress,
    onTouchMove: clearPress,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearPress();
      openIdMap();
    },
  };
  useEffect(() => clearPress, []);
  // More golden as the BSV balance grows (cardGold.ts); drives --gold in mobile.css.
  const gold = cardGoldLevel(sats / 100_000_000, {
    hidden: balanceHidden,
    known: view !== 'unknown' && view !== 'spinner',
  });

  return (
    <div className="bw-wcard-wrap">
      <div
        className={`bw-wcard${YELLOW_CARD ? ' is-yellow' : ''}${turning ? ' is-turning' : ''}`}
        style={{ ['--gold' as string]: YELLOW_CARD ? '0' : gold.toFixed(3) }}
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show card front' : 'Show receive QR and identity'}
        onClick={flip}
        onKeyDown={onKey}
      >
        {/* ── Front ── */}
        <div className={`bw-wcard-face bw-wcard-front${frontArt ? ' has-art' : ''}`} aria-hidden={flipped}>
          {frontArt && (
            <>
              <img className="bw-wcard-art" src={frontArt} alt="" decoding="async" draggable={false} />
              <span className="bw-wcard-art-shade" aria-hidden="true" />
            </>
          )}
          {ghost && (
            <span className="bw-wcard-ghost">
              <PixelGhost color={ghost} size={34} title="Agent account" />
            </span>
          )}
          <div className="bw-wcard-head">
            <div className="bw-wcard-top">
              <div className="bw-wcard-holder">
                <AccountAvatar src={avatar} size={31} id={id} />
                {t.tag ? (
                  <>
                    <span className="bw-wcard-handle">{t.tag}</span>
                    {verified && (
                      <span
                        aria-label="Verified identity"
                        title="Verified identity"
                        style={{ color: 'var(--bw-wcard-ok, #2ecc71)' }}
                      >
                        <Check size={13} strokeWidth={3} />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={copy(t.copy)}
                      aria-label={`Copy ${t.copy}`}
                      className="bw-wcard-icon"
                    >
                      <Copy size={15} color="var(--bw-wcard-muted, #98A2B3)" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="bw-wcard-getname"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHandleOpen(true);
                    }}
                  >
                    Get your $name
                  </button>
                )}
              </div>
              <div className="bw-wcard-tr">
                {/* Scan to pay (owner, 9 Oct 2026): 44px target, gold-ring icon like the top bar. */}
                <button
                  type="button"
                  aria-label="Scan to pay"
                  title="Scan to pay"
                  className="bw-wcard-scan"
                  onClick={(e) => {
                    e.stopPropagation();
                    setScanOpen(true);
                  }}
                >
                  <span>
                    <ScanLine size={16} />
                  </span>
                </button>
              </div>
            </div>
            {fingerprint && (
              <div className="bw-wcard-idline">
                {/* Fingerprint only: not selectable, not copyable (the full key is on the back). */}
                <span
                  className="bw-wcard-idtext bw-wcard-fingerprint"
                  {...idLinePress}
                  aria-label={`Identity key fingerprint ${fingerprint}. Long-press for the identity map`}
                >
                  {fingerprint}
                </span>
              </div>
            )}
          </div>
          <div className="bw-wcard-centre">
            {view === 'spinner' ? (
              <Loader2 size={28} className="animate-spin" color="var(--bw-wcard-muted, #8e8e89)" />
            ) : view === 'unknown' ? (
              <span
                className="bw-wcard-usd"
                title="Balance unavailable"
                style={{ color: 'var(--bw-wcard-muted, #8e8e89)' }}
              >
                —
              </span>
            ) : (
              <>
                <span
                  key={`flash-${count.flashKey}`}
                  className={`bw-wcard-usd${unit === 'bsv' ? ' is-bsv' : ''}${count.dir && count.flashKey ? ` bw-live-flash-${count.dir}` : ''}`}
                  title={syncing ? 'Syncing…' : 'Balance'}
                  style={(() => {
                    // Same size as the $ balance; long amounts shrink to stay on one line.
                    const len = (unit === 'usd' ? formatUSD(animUsd) : cardBsv(animSats)).length;
                    return len > 11
                      ? { fontSize: `clamp(18px, ${Math.min(10, 120 / len).toFixed(2)}vw, 42px)` }
                      : undefined;
                  })()}
                >
                  {unit === 'usd' ? formatUSD(animUsd) : cardBsv(animSats)}
                  {syncing && (
                    <Loader2 size={16} className="animate-spin bw-wcard-sync" color="var(--bw-wcard-muted, #8e8e89)" />
                  )}
                  {onRefresh && !syncing && (
                    <button
                      type="button"
                      aria-label="Refresh balance"
                      title="Refresh balance"
                      disabled={refreshing}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRefresh(true);
                      }}
                      className="bw-wcard-sync bg-transparent border-0 p-1 cursor-pointer"
                      style={{ color: 'var(--bw-wcard-muted, #8e8e89)', lineHeight: 0 }}
                    >
                      <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
                    </button>
                  )}
                </span>
                <span className="bw-wcard-sats">{unit === 'usd' ? cardSats(animSats) : formatUSD(animUsd)}</span>
                <LiveTicker hidden={balanceHidden} />
              </>
            )}
            {!hintSeen && !sig.svgPath && (
              <span className="bw-wcard-sighint">
                <PenLine size={11} aria-hidden="true" />
                Flip the card to add your signature
              </span>
            )}
            {failed && (
              <button
                type="button"
                className="bw-wcard-retry"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
              >
                <RefreshCw size={12} aria-hidden="true" />
                Still syncing. Tap to retry.
              </button>
            )}
          </div>
          <div className="bw-wcard-bottom">
            <div className="bw-wcard-bl">
              <div className="bw-wcard-addrline">
                <div className="bw-wcard-addrslot">
                  {receiveAddress && !backedUp && (
                    <div className="bw-wcard-addrrow">
                      <span className="bw-wcard-addr">Back up to show your address</span>
                    </div>
                  )}
                  {receiveAddress && backedUp && (
                    <div className="bw-wcard-addrrow">
                      {/* Copy sits LEFT of the address (owner, 11 Oct 2026), well away from the $/BSV switch. */}
                      <button
                        type="button"
                        onClick={copy(receiveAddress)}
                        aria-label="Copy BSV address"
                        className="bw-wcard-icon bw-wcard-copyicon"
                      >
                        <Copy size={14} color="var(--bw-wcard-muted, #98A2B3)" aria-hidden="true" />
                      </button>
                      <span className="bw-wcard-addr" aria-label="Your BSV address">
                        {receiveAddress}
                      </span>
                    </div>
                  )}
                </div>
                {/* $/BSV switch: same row as the address, right (owner, 9 Oct 2026). */}
                <div className="bw-wcard-unit" role="group" aria-label="Balance unit">
                  {(['usd', 'bsv'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      aria-pressed={unit === u}
                      className={unit === u ? 'is-on' : undefined}
                      onClick={pickUnit(u)}
                    >
                      {u === 'usd' ? fiatSymbol(fx) : 'BSV'}
                    </button>
                  ))}
                </div>
              </div>
              {since && (
                <div className="bw-wcard-since">
                  <span>MEMBER SINCE</span>
                  <b>{since}</b>
                </div>
              )}
            </div>
          </div>
          {/* A plain pen, right-centre (owner, 10 Oct 2026): flips to the back, where the signature lives. */}
          <button
            type="button"
            className="bw-wcard-penflip"
            aria-label="Show the back of the card"
            title="Show the back of the card"
            tabIndex={flipped ? -1 : 0}
            onClick={(e) => {
              e.stopPropagation();
              flip();
            }}
          >
            <PenLine size={20} aria-hidden="true" />
          </button>
        </div>

        {/* ── Back ── */}
        <div className="bw-wcard-face bw-wcard-back" aria-hidden={!flipped}>
          {/* Magnetic strip: the identity key lives here (owner, 10 Oct 2026), with a small copy icon. */}
          <div className="bw-wcard-stripe">
            {chat.identityKey && (
              <div className="bw-wcard-stripe-key">
                <span className="bw-wcard-stripe-text">
                  <span className="bw-wcard-stripe-label">IDENTITY KEY</span>
                  <span className="bw-wcard-stripe-hex">{chat.identityKey}</span>
                </span>
                <button
                  type="button"
                  className="bw-wcard-stripe-copy"
                  onClick={copy(chat.identityKey)}
                  aria-label="Copy identity key"
                  title="Copy identity key"
                  tabIndex={flipped ? 0 : -1}
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
          <div className="bw-wcard-backbody">
            <div className={`bw-wcard-qr${artQr ? ' is-art' : ''}`}>
              {artQr ? (
                <img src={artQr} alt={`QR code for ${cardPaymail(names.paymail)}`} />
              ) : qrUrl ? (
                <img src={qrUrl} alt="Receive QR code" />
              ) : (
                <div className="bw-wcard-qr-empty" />
              )}
            </div>
            <div className="bw-wcard-backinfo">
              <span className="bw-wcard-sig-cap">AUTHORISED SIGNATURE{sig.svgPath ? '' : ' · tap to sign'}</span>
              <div
                className={`bw-wcard-sig${sig.svgPath ? ' has-drawn' : ''}`}
                role="img"
                aria-label={
                  sig.svgPath ? 'Your drawn signature. Tap Edit to change it.' : 'Signature strip. Tap to sign.'
                }
                {...sig.pressHandlers}
                onClick={(e) => {
                  e.stopPropagation();
                  sig.open();
                }}
              >
                {sig.svgPath ? (
                  <svg
                    className="bw-wcard-sig-drawn"
                    viewBox={sig.viewBox}
                    preserveAspectRatio="xMinYMid meet"
                    aria-hidden="true"
                  >
                    <path d={sig.svgPath} fill="#1b2a5a" />
                  </svg>
                ) : (
                  <span className="bw-wcard-sig-empty">Sign here</span>
                )}
                <button
                  type="button"
                  className="bw-wcard-sig-pen"
                  aria-label={sig.svgPath ? 'Change signature' : 'Draw signature'}
                  title={sig.svgPath ? 'Change signature' : 'Draw signature'}
                  onClick={(e) => {
                    e.stopPropagation();
                    sig.open();
                  }}
                >
                  <PenLine size={13} color="#5a6380" aria-hidden="true" />
                  <span>{sig.svgPath ? 'Edit' : 'Sign'}</span>
                </button>
              </div>
            </div>
          </div>
          {/* Same plain pen, same spot as the front (owner, 11 Oct 2026): flips back to the front. On Android the
              back's copy targets used to swallow every tap, so this is the reliable way home. */}
          <button
            type="button"
            className="bw-wcard-penflip bw-wcard-penflip-back"
            aria-label="Show the front of the card"
            title="Show the front of the card"
            tabIndex={flipped ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              flip();
            }}
          >
            <PenLine size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* History moved to the wallet's top row (wallet/BuyBsv.tsx BsvPriceBar, owner round 6). */}
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
      {sig.ui}
      {scanOpen && (
        <Suspense fallback={null}>
          <ScanSheet receiveAddress={receiveAddress} onClose={() => setScanOpen(false)} />
        </Suspense>
      )}
    </div>
  );
};

/** If the card ever throws while rendering, show a plain fallback card (balance + retry) instead of nothing. */
class WalletCardBoundary extends Component<
  { children: ReactNode; usd: number; sats: number; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[WalletCard] render failed', error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { usd, sats, onRetry } = this.props;
    return (
      <div className="bw-wcard-wrap">
        <div className="bw-wcard" role="group" aria-label="Wallet balance">
          <div className="bw-wcard-face bw-wcard-front">
            <div className="bw-wcard-centre">
              <span className="bw-wcard-usd">{Number.isFinite(usd) ? `$${usd.toFixed(2)}` : '—'}</span>
              <span className="bw-wcard-sats">
                {Number.isFinite(sats) ? `${Math.round(sats).toLocaleString('en-US')} sats` : ''}
              </span>
              <button
                type="button"
                className="bw-wcard-retry"
                onClick={() => {
                  this.setState({ failed: false });
                  onRetry();
                }}
              >
                Tap to reload the card
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export const WalletCard = (p: WalletCardProps) => (
  <WalletCardBoundary usd={p.usd} sats={p.sats} onRetry={p.onRetry}>
    <WalletCardInner {...p} />
  </WalletCardBoundary>
);
