import { useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Ban, Bell, Bookmark, Newspaper, PlayCircle, Sparkles, Zap } from 'lucide-react';
import { CATEGORIES, CATEGORY_LABELS } from '../notify/notify';
import { askNotifyPermissionOnce } from '../notify/engine';
import { useBackClose } from '../backStack';
import { INDEX_AUTOPAY_USD, ONE_CLICK_LIMITS, type DefaultFeed } from './prefs';
import { MAX_PER_MINUTE } from './oneClick';
import { usePrefs } from './usePrefs';
import { AgentSettings } from './AgentSettings';
import { hasRate, money, useBsvUsd } from '../money/money';
import {
  loadBlocks,
  loadBookmarks,
  loadMuteNames,
  loadMutes,
  mutedAccounts,
  removeBlock,
  removeMute,
  toggleBookmark,
  type HiddenAccount,
} from '../feed/store';
import type { FeedPost } from '../feed/post';

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
  <div className="flex gap-1.5" role="radiogroup" aria-label={label} onClick={(e) => e.stopPropagation()}>
    {options.map((o) => (
      <button
        key={String(o.id)}
        role="radio"
        aria-checked={o.id === value}
        onClick={() => onChange(o.id)}
        className="rounded-full px-2.5 py-1 text-[11px] font-bold"
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
  return (
    <Screen title="Bookmarks" onBack={onBack}>
      {items.length ? (
        <>
          {items.map((p) => (
            <ListRow
              key={p.txid}
              title={p.author.name}
              sub={p.text || `${p.media?.length ?? 0} attachment(s)`}
              action="Remove"
              onAction={() => setItems((b) => toggleBookmark(b, p))}
            />
          ))}
          <Note>To read, like or reply, open Bookmarks from the bookmark button on the Feed.</Note>
        </>
      ) : (
        <Note>Nothing saved yet. Tap ··· on a post, then Save to bookmarks.</Note>
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

export const FeedSettings = ({ Section, Row, Divider }: Props) => {
  const [prefs, setPrefs] = usePrefs();
  const [screen, setScreen] = useState<'bookmarks' | 'hidden' | null>(null);
  const rate = useBsvUsd();
  // Limits are stored and enforced in sats; shown in USD at the live rate (sats when the rate is unknown).
  const limits = ONE_CLICK_LIMITS.map((v) => ({ id: v, label: money(v, rate) }));
  return (
    <>
      <Section title="Feed">
        <Row
          icon={<Newspaper size={16} />}
          label="Default feed"
          description="What the Feed opens to"
          right={
            <Pills
              label="Default feed"
              options={FEEDS}
              value={prefs.defaultFeed}
              onChange={(v) => setPrefs({ defaultFeed: v })}
            />
          }
          isFirst
        />
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
          isLast
        />
      </Section>
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
          isLast={!prefs.oneClick}
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
              right={
                <Pills
                  label="One-click limit"
                  options={limits}
                  value={prefs.oneClickLimit}
                  onChange={(v) => setPrefs({ oneClickLimit: v })}
                />
              }
              isLast
            />
          </>
        )}
      </Section>
      <Section title="Token indexing">
        <Row
          icon={<Zap size={16} />}
          label="One-tap indexing fee"
          description={
            prefs.indexAutoPayUsd
              ? `Your own tokens' indexing fee pays on one tap when under $${prefs.indexAutoPayUsd.toFixed(2)}`
              : "Always confirm your tokens' indexing fee"
          }
          right={
            <Pills
              label="One-tap indexing limit"
              options={INDEX_AUTOPAY_USD.map((v) => ({ id: v, label: v ? `$${v.toFixed(2)}` : 'Off' }))}
              value={prefs.indexAutoPayUsd}
              onChange={(v) => setPrefs({ indexAutoPayUsd: v })}
            />
          }
          isFirst
          isLast
        />
      </Section>
      <Section title="Notifications">
        {CATEGORIES.map((c, i) => (
          <div key={c}>
            {i > 0 && <Divider />}
            <Row
              icon={<Bell size={16} />}
              label={CATEGORY_LABELS[c].label}
              description={CATEGORY_LABELS[c].description}
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
              isFirst={i === 0}
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
      <AgentSettings Section={Section} Row={Row} Divider={Divider} />
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
      {screen === 'bookmarks' && <BookmarksScreen onBack={() => setScreen(null)} />}
      {screen === 'hidden' && <HiddenScreen onBack={() => setScreen(null)} />}
    </>
  );
};
