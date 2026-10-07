import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Ban,
  Bell,
  BellRing,
  Bookmark,
  Coins,
  Download,
  Heart,
  FileText,
  Globe,
  Mail,
  Newspaper,
  PlayCircle,
  Sparkles,
  Trash2,
  Zap,
  LockKeyhole,
  BadgeCheck,
  Bot,
  ScanLine,
  EyeOff,
  PiggyBank,
} from 'lucide-react';
import { ChangePassword } from './ChangePassword';
import { ConnectSocial } from './ConnectSocial';
import { AgentsScreen } from '../agents/AgentsScreen';
import { WalletNames } from './WalletNames';
import {
  B_AGENT_DESC,
  MY_TOKENS_DESC,
  MY_TOKENS_NOTE,
  isBWalletX,
  languageSettingsEnabled,
  potsEnabled,
  socialLoginEnabled,
  SUBSCRIPTIONS_DESC,
} from '../storeBuild';
import { CATEGORIES, CATEGORY_LABELS } from '../notify/notify';
import { askNotifyPermissionOnce } from '../notify/engine';
import { useBackClose } from '../backStack';
import { INDEX_AUTOPAY_USD, ONE_CLICK_LIMITS, PAID_LIKE_OPTIONS, type DefaultFeed } from './prefs';
import { MAX_PER_MINUTE } from './oneClick';
import { usePrefs } from './usePrefs';
import { AgentSettings } from './AgentSettings';
import { PushSettings } from '../push/PushSettings';
import { onPushState, pushEnabled, setPushEnabled } from '../push/register';
import { loadSession } from '../chat/api';
import { TesterSettings } from '../testers/TesterSettings';
import { testersEnabled } from '../testers/checkin';
import { PairedSitesList } from '../pair/PairedSitesList';
import { IS_EXTENSION } from '../extension';

const PairSheet = lazy(() => import('../pair/PairSheet'));
const PotsScreen = lazy(() => import('../pots/PotsScreen'));
import { TermsScreen } from '../ugc/UgcSheets';
import { SUPPORT_EMAIL } from '../ugc/ugc';
import { DeleteAccountScreen } from '../account/DeleteAccountScreen';
import { HdSweepScreen } from '../sweep/HdSweepScreen';
import { hasRate, money, useBsvUsd } from '../money/money';
import {
  loadBlocks,
  loadBookmarks,
  loadMuteNames,
  loadMutes,
  mutedAccounts,
  removeBlock,
  removeMute,
  type HiddenAccount,
} from '../feed/store';
import type { FeedPost } from '../feed/post';
import { FILTER_NOTE, isSlur, safeName } from '../feed/language';
import { bookmarkClient, syncBookmarks, toggleSyncedBookmark } from '../feed/bookmarkSync';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ownTokens, recheckPendingIndexing } from '../tokens/pendingIndexing';
import { setupLabel, useRoomSetup } from '../tokens/useRoomSetup';
import type { OwnToken } from '../tokens/indexFund';

/**
 * Settings → Feed / Payments / Privacy (mobile). Rendered inside upstream Settings' main page via the
 * vite.config.mobile.ts text patch, reusing its Section / SettingRow / Divider so it looks native.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

type RowProps = {
  icon: ReactNode;
  label: string;
  description?: string;
  right?: ReactNode;
  onClick?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  danger?: boolean;
};
type Props = {
  Section: ComponentType<{ title: string; children: ReactNode }>;
  Row: ComponentType<RowProps>;
  Divider: ComponentType;
  /**
   * Settings is split into "This account" (keys, names, tokens: differ per account) and "All accounts (wallet)"
   * (device / app preferences). 'notify' is the Notifications row at the top of "All accounts". Unset renders all.
   */
  part?: 'account' | 'wallet' | 'notify';
};

const FEEDS: { id: DefaultFeed; label: string }[] = [
  { id: 'foryou', label: 'For you' },
  { id: 'latest', label: 'Latest' },
  { id: 'following', label: 'Following' },
];

const Pills = <T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) => (
  <div
    className="grid grid-flow-col auto-cols-fr gap-1.5 w-full"
    role="radiogroup"
    aria-label={label}
    onClick={(e) => e.stopPropagation()}
  >
    {options.map((o) => (
      <button
        key={String(o.id)}
        role="radio"
        aria-checked={o.id === value}
        onClick={() => onChange(o.id)}
        className="rounded-full px-1 py-1.5 text-[11px] font-bold whitespace-nowrap text-center"
        style={
          o.id === value
            ? { background: GOLD, color: '#1a1300' }
            : { background: PANEL, color: MUTED, border: `1px solid ${LINE}` }
        }
      >
        {o.label}
      </button>
    ))}
  </div>
);

const Toggle = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={(e) => {
      e.stopPropagation();
      onChange(!on);
    }}
    className="relative h-6 w-11 rounded-full transition-colors"
    style={{ background: on ? GOLD : LINE }}
  >
    <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: on ? 22 : 2 }} />
  </button>
);

const Screen = ({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) => {
  useBackClose(true, onBack);
  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: '#010101' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">{title}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 pb-24">{children}</div>
    </div>,
    document.body,
  );
};

const Heading = ({ children }: { children: ReactNode }) => (
  <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
    {children}
  </p>
);

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs" style={{ color: MUTED }}>
    {children}
  </p>
);

const ListRow = ({
  title,
  sub,
  action,
  onAction,
}: {
  title: string;
  sub?: string;
  action: string;
  onAction: () => void;
}) => (
  <div
    className="mb-2 flex items-center gap-3 rounded-xl px-3 py-3"
    style={{ background: PANEL, border: `1px solid ${LINE}` }}
  >
    <div className="min-w-0 flex-1 overflow-hidden">
      <p className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-white">{title}</p>
      {sub && (
        <p className="mt-0.5 line-clamp-2 text-xs" style={{ color: MUTED }}>
          {sub}
        </p>
      )}
    </div>
    <button
      onClick={onAction}
      className="shrink-0 rounded-full px-3 py-1 text-xs font-bold"
      style={{ border: `1px solid ${GOLD}`, color: GOLD }}
    >
      {action}
    </button>
  </div>
);

const BookmarksScreen = ({ onBack }: { onBack: () => void }) => {
  const [items, setItems] = useState<FeedPost[]>(loadBookmarks);
  useEffect(() => {
    void syncBookmarks(bookmarkClient()).then(setItems);
  }, []);
  return (
    <Screen title="Bookmarks" onBack={onBack}>
      {items.length ? (
        <>
          {items.map((p) => (
            <ListRow
              key={p.txid}
              title={safeName(p.author.name)}
              sub={isSlur(p.text) ? 'Post hidden: offensive language' : p.text || `${p.media?.length ?? 0} attachment(s)`}
              action="Remove"
              onAction={() => {
                setItems((b) => toggleSyncedBookmark(b, p));
                void syncBookmarks(bookmarkClient()).then(setItems);
              }}
            />
          ))}
          <Note>To read, like or reply, open Bookmarks from the bookmark button on the Feed.</Note>
        </>
      ) : (
        <Note>Nothing saved yet. Tap the bookmark on a post to save it.</Note>
      )}
    </Screen>
  );
};

const HiddenScreen = ({ onBack }: { onBack: () => void }) => {
  const [mutes, setMutes] = useState<string[]>(loadMutes);
  const [blocks, setBlocks] = useState<HiddenAccount[]>(loadBlocks);
  const muted = mutedAccounts(mutes, loadMuteNames());
  return (
    <Screen title="Blocked & muted" onBack={onBack}>
      <Heading>Blocked</Heading>
      {blocks.length ? (
        blocks.map((b) => (
          <ListRow
            key={b.address}
            title={b.name}
            sub="Posts and replies hidden everywhere, including their profile"
            action="Unblock"
            onAction={() => setBlocks((x) => removeBlock(x, b))}
          />
        ))
      ) : (
        <Note>Nobody blocked.</Note>
      )}
      <Heading>Muted</Heading>
      {muted.length ? (
        muted.map((m) => (
          <ListRow
            key={m.keys.join()}
            title={m.name}
            sub="Hidden in the feed and threads"
            action="Unmute"
            onAction={() => setMutes((x) => removeMute(x, ...m.keys))}
          />
        ))
      ) : (
        <Note>Nobody muted.</Note>
      )}
    </Screen>
  );
};

/** One own token: "Room open" or "Not set up" + the shared setup flow (useRoomSetup). */
const MyTokenRow = ({ token, onDone }: { token: OwnToken; onDone: () => void }) => {
  const s = useRoomSetup(token.tokenId, token.ticker, { onDone });
  const state =
    s.status === undefined
      ? 'Checking…'
      : s.status === null
        ? 'The indexer didn’t answer. Try again later.'
        : s.open
          ? 'Room open'
          : s.waiting
            ? 'Setting up… (usually under a minute)'
            : 'Not set up';
  return (
    <div className="mb-2 rounded-xl px-3 py-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-white">
            ${token.ticker}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: s.open ? GOLD : MUTED }}>
            {state}
          </p>
          {s.needs && s.freeNote && (
            <p className="mt-0.5 text-xs" style={{ color: GOLD }}>
              {s.freeNote}
            </p>
          )}
        </div>
        {s.needs && s.total && (
          <button
            onClick={s.start}
            disabled={s.busy}
            className="shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-40"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          >
            {setupLabel(s.total.totalSats, s.rate)}
          </button>
        )}
      </div>
      {s.msg && (
        <p className="mt-2 text-xs" style={{ color: MUTED }}>
          {s.msg}
        </p>
      )}
      {s.sheet}
    </div>
  );
};

/** Settings › My tokens: every own token (incl. ones whose Wallet card got "Not now"). */
const MyTokensScreen = ({ onBack }: { onBack: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const tokens = ownTokens(identityAddress);
  return (
    <Screen title="My tokens" onBack={onBack}>
      {tokens.length ? (
        <>
          {tokens.map((t) => (
            <MyTokenRow
              key={t.tokenId}
              token={t}
              onDone={() => void recheckPendingIndexing(apiContext, identityAddress)}
            />
          ))}
          <Note>{MY_TOKENS_NOTE}</Note>
        </>
      ) : (
        <Note>Tokens you mint in bWallet show here.</Note>
      )}
    </Screen>
  );
};

/**
 * Settings main page: one Notifications row. The switch is push on/off for this device (the same master switch
 * as the Notifications page); tapping the row opens that page (categories, previews, quiet hours).
 */
const NotificationsRow = ({
  Row,
  Toggle: T,
  onOpen,
}: {
  Row: ComponentType<RowProps>;
  Toggle: typeof Toggle;
  onOpen: () => void;
}) => {
  const [on, setOn] = useState(pushEnabled());
  const [busy, setBusy] = useState(false);
  useEffect(() => onPushState(() => setOn(pushEnabled())), []);
  const flip = async (v: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await setPushEnabled(v, loadSession());
      // Blocked by the phone / browser: the Notifications page says why and how to fix it.
      if (v && !ok) onOpen();
    } catch {
      onOpen();
    } finally {
      setOn(pushEnabled());
      setBusy(false);
    }
  };
  return (
    <Row
      icon={<BellRing size={16} />}
      label="Notifications"
      description="Rooms, DMs and payments; previews, quiet hours"
      right={<T label="Notifications" on={on} onChange={(v) => void flip(v)} />}
      onClick={onOpen}
      isFirst
      isLast
    />
  );
};

export const FeedSettings = ({ Section, Row, Divider, part }: Props) => {
  const acct = !part || part === 'account';
  const wal = !part || part === 'wallet';
  const notif = !part || part === 'notify';
  const [prefs, setPrefs] = usePrefs();
  const [screen, setScreen] = useState<
    | 'bookmarks'
    | 'hidden'
    | 'terms'
    | 'delete'
    | 'sweep'
    | 'tokens'
    | 'paired'
    | 'scan'
    | 'password'
    | 'social'
    | 'agents'
    | 'pots'
    | 'notifications'
    | 'feed'
    | 'payments'
    | 'indexing'
    | 'bagent'
    | 'websites'
    | null
  >(null);
  const rate = useBsvUsd();
  // bWalletX extension: take window.CWI over another wallet (src/brand/cwi.ts, content.ts). Reloads apply it.
  const [takeCwi, setTakeCwiState] = useState(true);
  useEffect(() => {
    if (IS_EXTENSION)
      chrome.storage?.local.get('bwalletxTakeCwi', (r) => setTakeCwiState(r?.bwalletxTakeCwi !== false));
  }, []);
  const setTakeCwi = (v: boolean) => {
    setTakeCwiState(v);
    void chrome.storage?.local.set({ bwalletxTakeCwi: v });
  };
  // Limits are stored and enforced in sats; shown in USD at the live rate (sats when the rate is unknown).
  const limits = ONE_CLICK_LIMITS.map((v) => ({ id: v, label: money(v, rate) }));
  const paidLikes = PAID_LIKE_OPTIONS.map((v) => ({ id: v as number, label: money(v, rate) }));
  return (
    <>
      {acct && socialLoginEnabled() && (
        <Section title="Identity">
          <WalletNames />
          <Row
            icon={<BadgeCheck size={16} />}
            label="Connect X or Google"
            description="Get a verified name like yourname.x; it becomes the main name"
            onClick={() => setScreen('social')}
            isFirst
            isLast
          />
        </Section>
      )}
      {acct && (
        <Section title="Tokens">
          <Row
            icon={<Coins size={16} />}
            label="My tokens"
            description={MY_TOKENS_DESC}
            onClick={() => setScreen('tokens')}
            isFirst
            isLast
          />
        </Section>
      )}
      {acct && (
        <Section title="Account data">
          <Row
            icon={<Download size={16} />}
            label="Sweep into this account"
            description="Move coins, NFTs and tokens from bWalletX, Yours, SimplyCash or any wallet: paste its phrase or private key"
            onClick={() => setScreen('sweep')}
            isFirst
          />
          <Divider />
          <Row
            icon={<Trash2 size={16} />}
            label="Delete account data"
            description="Delete this account's paymail, $handle, bChat profile and messages"
            onClick={() => setScreen('delete')}
            isLast
            danger
          />
        </Section>
      )}
      {notif && (
        <Section title="Notifications">
          <NotificationsRow Toggle={Toggle} Row={Row} onOpen={() => setScreen('notifications')} />
        </Section>
      )}
      {wal && (
        <>
          <Section title="General">
            <Row
              icon={<Newspaper size={16} />}
              label="Feed"
              description="Default feed, autoplay, backgrounds, language"
              onClick={() => setScreen('feed')}
              isFirst
            />
            <Divider />
            <Row
              icon={<Zap size={16} />}
              label="Payments"
              description="One-click pay and paid likes"
              onClick={() => setScreen('payments')}
            />
            {potsEnabled() && (
              <>
                <Divider />
                <Row
                  icon={<PiggyBank size={16} />}
                  label="Subscriptions"
                  description={SUBSCRIPTIONS_DESC}
                  onClick={() => setScreen('pots')}
                />
              </>
            )}
            {isBWalletX() && (
              <>
                <Divider />
                <Row
                  icon={<Bot size={16} />}
                  label="Agent accounts"
                  description="Accounts your AI agents can use, with their own budget"
                  onClick={() => setScreen('agents')}
                />
              </>
            )}
            <Divider />
            <Row
              icon={<Sparkles size={16} />}
              label="b agent"
              description={B_AGENT_DESC}
              onClick={() => setScreen('bagent')}
            />
            <Divider />
            <Row
              icon={<Coins size={16} />}
              label="Token indexing"
              description="One-tap fee for your own tokens"
              onClick={() => setScreen('indexing')}
            />
            {IS_EXTENSION && (
              <>
                <Divider />
                <Row
                  icon={<Globe size={16} />}
                  label="Websites"
                  description="Which wallet sites connect to"
                  onClick={() => setScreen('websites')}
                />
              </>
            )}
            <Divider />
            <Row
              icon={<LockKeyhole size={16} />}
              label="Change password"
              description="One password unlocks every account"
              onClick={() => setScreen('password')}
              isLast
            />
          </Section>
          {testersEnabled() && (
            <Section title="Testing">
              <TesterSettings />
            </Section>
          )}
          <Section title="Privacy">
            <Row
              icon={<Bookmark size={16} />}
              label="Bookmarks"
              description="Posts you saved on this device"
              onClick={() => setScreen('bookmarks')}
              isFirst
            />
            <Divider />
            <Row
              icon={<Ban size={16} />}
              label="Blocked & muted"
              description="Unblock or unmute accounts"
              onClick={() => setScreen('hidden')}
              isLast
            />
          </Section>
          {
            <Section title="Connections">
              {/* One tap to the camera (owner, 6 Oct 2026: couldn't find how to link the CLI to an agent account). */}
              <Row
                icon={<ScanLine size={16} />}
                label={IS_EXTENSION ? 'Connect the CLI / an AI assistant' : 'Scan to connect'}
                description={
                  IS_EXTENSION
                    ? 'Pair the bWalletX CLI or an AI assistant (MCP): paste the link from bwalletx login'
                    : 'Pair the bWalletX CLI, an AI assistant (MCP) or a website: scan its QR code'
                }
                onClick={() => setScreen('scan')}
                isFirst
              />
              <Divider />
              <Row
                icon={<Globe size={16} />}
                label="Paired computers & websites"
                description="What's connected to this account, and what each may do"
                onClick={() => setScreen('paired')}
                isLast
              />
            </Section>
          }
          <Section title="Help & safety">
            <Row
              icon={<FileText size={16} />}
              label="Terms of use"
              isFirst
              description="Zero tolerance for objectionable content and abusive users"
              onClick={() => setScreen('terms')}
            />
            <Divider />
            <Row
              icon={<Mail size={16} />}
              label="Contact and reports"
              description={SUPPORT_EMAIL}
              onClick={() => (window.location.href = `mailto:${SUPPORT_EMAIL}`)}
              isLast
            />
          </Section>
        </>
      )}
      {screen === 'feed' && (
        <Screen title="Feed" onBack={() => setScreen(null)}>
          <Section title="Feed">
            <Row icon={<Newspaper size={16} />} label="Default feed" description="What the Feed opens to" isFirst />
            <div className="px-4 pb-3 pl-12">
              <Pills
                label="Default feed"
                options={FEEDS}
                value={prefs.defaultFeed}
                onChange={(v) => setPrefs({ defaultFeed: v })}
              />
            </div>
            <Divider />
            <Row
              icon={<PlayCircle size={16} />}
              label="Video autoplay"
              description={prefs.autoplay ? 'Videos play muted as you scroll' : 'Videos wait for a tap'}
              right={<Toggle label="Video autoplay" on={prefs.autoplay} onChange={(v) => setPrefs({ autoplay: v })} />}
            />
            <Divider />
            <Row
              icon={<Sparkles size={16} />}
              label="Animated backgrounds"
              description={
                prefs.animatedBackgrounds
                  ? 'Gold motion behind Wallet, Apps and Feed'
                  : 'Still images behind Wallet, Apps and Feed'
              }
              right={
                <Toggle
                  label="Animated backgrounds"
                  on={prefs.animatedBackgrounds}
                  onChange={(v) => setPrefs({ animatedBackgrounds: v })}
                />
              }
              isLast={!languageSettingsEnabled()}
            />
            {languageSettingsEnabled() && (
              <>
                <Divider />
                <Row
                  icon={<EyeOff size={16} />}
                  label="Filter strong language"
                  description={
                    prefs.filterStrong ? 'Swearing is blurred until you tap Show anyway' : 'Swearing is shown as posted'
                  }
                  right={
                    <Toggle
                      label="Filter strong language"
                      on={prefs.filterStrong}
                      onChange={(v) => setPrefs({ filterStrong: v })}
                    />
                  }
                  isLast
                />
              </>
            )}
          </Section>
          <div className="px-4 -mt-2 mb-3">
            <Note>
              {languageSettingsEnabled()
                ? 'Posts with slurs are blurred: tap Show anyway to read one. '
                : 'Posts with slurs are hidden and strong language is blurred in this edition. '}
              {FILTER_NOTE}
            </Note>
          </div>
        </Screen>
      )}
      {screen === 'payments' && (
        <Screen title="Payments" onBack={() => setScreen(null)}>
          <Section title="Payments">
            <Row
              icon={<Zap size={16} />}
              label="One-click pay"
              description={
                prefs.oneClick
                  ? `Tips and locks up to ${money(prefs.oneClickLimit, rate)}${hasRate(rate) ? ` (${prefs.oneClickLimit.toLocaleString()} sats)` : ''} skip the confirm (max ${MAX_PER_MINUTE} a minute)`
                  : 'Always confirm tips and locks'
              }
              right={<Toggle label="One-click pay" on={prefs.oneClick} onChange={(v) => setPrefs({ oneClick: v })} />}
              isFirst
            />
            {prefs.oneClick && (
              <>
                <Divider />
                <Row
                  icon={<Zap size={16} />}
                  label="Limit per action"
                  description={
                    hasRate(rate)
                      ? 'Anything above this asks first (USD at today’s BSV price)'
                      : 'Anything above this asks first (sats; USD price unavailable)'
                  }
                  isLast
                />
                <div className="px-4 pb-3 pl-12">
                  <Pills
                    label="One-click limit"
                    options={limits}
                    value={prefs.oneClickLimit}
                    onChange={(v) => setPrefs({ oneClickLimit: v })}
                  />
                </div>
              </>
            )}
            <Divider />
            <Row
              icon={<Heart size={16} />}
              label="Paid like"
              description={`Like + ${money(prefs.paidLikeSats, rate)}${hasRate(rate) ? ` (${prefs.paidLikeSats.toLocaleString()} sats)` : ''} to the author, from a post's Tip sheet`}
              isLast
            />
            <div className="px-4 pb-3 pl-12">
              <Pills
                label="Paid like amount"
                options={paidLikes}
                value={prefs.paidLikeSats}
                onChange={(v) => setPrefs({ paidLikeSats: v })}
              />
            </div>
          </Section>
        </Screen>
      )}
      {screen === 'indexing' && (
        <Screen title="Token indexing" onBack={() => setScreen(null)}>
          <Section title="Token indexing">
            <Row
              icon={<Zap size={16} />}
              label="One-tap indexing fee"
              isFirst
              description={
                prefs.indexAutoPayUsd
                  ? `Your own tokens' indexing fee pays on one tap when under $${prefs.indexAutoPayUsd.toFixed(2)}`
                  : "Always confirm your tokens' indexing fee"
              }
              isLast
            />
            <div className="px-4 pb-3 pl-12">
              <Pills
                label="One-tap indexing limit"
                options={INDEX_AUTOPAY_USD.map((v) => ({ id: v, label: v ? `$${v.toFixed(2)}` : 'Off' }))}
                value={prefs.indexAutoPayUsd}
                onChange={(v) => setPrefs({ indexAutoPayUsd: v })}
              />
            </div>
          </Section>
        </Screen>
      )}
      {screen === 'bagent' && (
        <Screen title="b agent" onBack={() => setScreen(null)}>
          <AgentSettings Section={Section} Row={Row} Divider={Divider} />
        </Screen>
      )}
      {screen === 'websites' && (
        <Screen title="Websites" onBack={() => setScreen(null)}>
          <Section title="Websites">
            <Row
              icon={<Globe size={16} />}
              label="Be the wallet websites connect to"
              description={
                takeCwi
                  ? 'Sites without a wallet picker connect to bWalletX, even with Yours installed'
                  : 'Another wallet (e.g. Yours) answers sites without a picker'
              }
              right={<Toggle label="Be the wallet websites connect to" on={takeCwi} onChange={setTakeCwi} />}
              isFirst
              isLast
            />
          </Section>
        </Screen>
      )}
      {screen === 'notifications' && (
        <Screen title="Notifications" onBack={() => setScreen(null)}>
          <PushSettings Toggle={Toggle} />
          <Section title="In the app">
            {CATEGORIES.map((c) => (
              <div key={c}>
                {c !== CATEGORIES[0] && <Divider />}
                <Row
                  icon={<Bell size={16} />}
                  label={CATEGORY_LABELS[c].label}
                  description={CATEGORY_LABELS[c].description}
                  isFirst={c === CATEGORIES[0]}
                  right={
                    <Toggle
                      label={CATEGORY_LABELS[c].label}
                      on={prefs.notify[c]}
                      onChange={(v) => {
                        setPrefs({ notify: { ...prefs.notify, [c]: v } });
                        if (v) void askNotifyPermissionOnce();
                      }}
                    />
                  }
                />
              </div>
            ))}
            <Divider />
            <Row
              icon={<Bell size={16} />}
              label="Your Twetch user number"
              description="From twetch.com/u/<number>: lets replies and likes on your Twetch posts reach you"
              right={
                <input
                  inputMode="numeric"
                  aria-label="Twetch user number"
                  placeholder="e.g. 13"
                  defaultValue={prefs.twetchUserId}
                  onBlur={(e) => setPrefs({ twetchUserId: e.target.value.replace(/\D/g, '') })}
                  className="w-20 rounded-lg px-2 py-1 text-sm text-white text-right outline-none"
                  style={{ background: PANEL, border: `1px solid ${LINE}` }}
                />
              }
              isLast
            />
          </Section>
        </Screen>
      )}
      {screen === 'terms' && <TermsScreen onBack={() => setScreen(null)} />}
      {screen === 'delete' && <DeleteAccountScreen onBack={() => setScreen(null)} />}
      {screen === 'sweep' && <HdSweepScreen onBack={() => setScreen(null)} />}
      {screen === 'bookmarks' && <BookmarksScreen onBack={() => setScreen(null)} />}
      {screen === 'hidden' && <HiddenScreen onBack={() => setScreen(null)} />}
      {screen === 'tokens' && <MyTokensScreen onBack={() => setScreen(null)} />}
      {screen === 'password' && <ChangePassword onClose={() => setScreen(null)} />}
      {screen === 'social' && <ConnectSocial onClose={() => setScreen(null)} />}
      {screen === 'agents' && <AgentsScreen onClose={() => setScreen(null)} />}
      {screen === 'paired' && (
        <Screen title="Paired websites" onBack={() => setScreen(null)}>
          <PairedSitesList onScan={() => setScreen('scan')} />
        </Screen>
      )}
      {screen === 'pots' && (
        <Suspense fallback={null}>
          <PotsScreen onClose={() => setScreen(null)} />
        </Suspense>
      )}
      {screen === 'scan' && (
        <Suspense fallback={null}>
          <PairSheet onClose={() => setScreen('paired')} />
        </Suspense>
      )}
    </>
  );
};
