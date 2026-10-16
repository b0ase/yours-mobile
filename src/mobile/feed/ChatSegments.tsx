import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Phone } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { onTokenNav } from '../chat/nav';
import { onChatSegment, takeChatSegment } from '../chat/segmentNav';
import { useCalls } from '../calls/useCalls';
import { useChatSplitBadges } from '../tabs/useTabBadges';
import {
  badgeLabel,
  badgeText,
  initCallsSeen,
  markCallsSeen,
  missedCallsSince,
  readCallsSeen,
} from '../tabs/tabBadges';

/**
 * Chat tab top switch: DMs | Chatrooms | Calls (DMs on the left, Chatrooms still opens first; owner, 16 Oct 2026).
 * Each filter carries its unread badge: DMs, room messages, missed calls.
 * Feed is its own bottom-bar tab. Generic: add a
 * segment by adding one entry to SEGMENTS and one case in ChatTabs. Chatrooms (id 'rooms') is the
 * token-rooms page; DMs is the 1:1 list + contacts (chat/DmsPage.tsx). Each renders the header
 * we pass it.
 */
export type ChatSegment = 'rooms' | 'dms' | 'calls';
const SEGMENTS: { id: ChatSegment; label: string }[] = [
  { id: 'dms', label: 'DMs' },
  { id: 'rooms', label: 'Chatrooms' },
  { id: 'calls', label: 'Calls' },
];
/** The filter the Chat tab opens on (group chats), whatever sits on the left. */
const DEFAULT_SEGMENT: ChatSegment = 'rooms';
export type SegmentBadges = Partial<Record<ChatSegment, number>>;

/** Unread counts for the three filters (tabs/tabBadges.ts): DMs, rooms, missed calls since Calls was opened. */
const useSegmentBadges = (seg: ChatSegment): SegmentBadges => {
  const { dms, rooms } = useChatSplitBadges();
  const { recent, ready } = useCalls();
  useEffect(() => {
    if (ready) initCallsSeen();
  }, [ready]);
  // Looking at Calls clears its badge (and keeps it clear while new records load there).
  useEffect(() => {
    if (seg === 'calls') markCallsSeen();
  }, [seg, recent]);
  return { dms, rooms, calls: seg === 'calls' ? 0 : missedCallsSince(recent, readCallsSeen()) };
};
const GOLD = 'var(--bw-accent-hi)';

export const SegmentSwitch = ({
  value,
  onChange,
  badges = {},
}: {
  value: ChatSegment;
  onChange: (s: ChatSegment) => void;
  badges?: SegmentBadges;
}) => (
  <div
    role="tablist"
    className="flex w-full rounded-full p-[3px]"
    style={{ background: '#121316', border: '1px solid #1f2127' }}
  >
    {SEGMENTS.map((s) => {
      const on = s.id === value;
      const n = badges[s.id] ?? 0;
      return (
        <button
          key={s.id}
          role="tab"
          aria-selected={on}
          aria-label={badgeLabel(s.label, n)}
          onClick={() => onChange(s.id)}
          className="flex-1 flex items-center justify-center gap-[6px] rounded-full px-3 py-[7px] text-[13px] font-bold transition-colors"
          style={on ? { background: GOLD, color: '#1a1300' } : { color: '#8a8f98' }}
        >
          {s.label}
          {n > 0 && (
            <span
              data-testid={`seg-badge-${s.id}`}
              className="bw-unread-badge min-w-[18px] h-[18px] px-[5px] rounded-full text-[11px] font-bold leading-[18px] text-center"
              style={{ background: '#E5242B', color: '#FFFFFF' }}
            >
              {badgeText(n)}
            </span>
          )}
        </button>
      );
    })}
  </div>
);

// Calls is built separately: use src/mobile/calls/CallsList.tsx (export CallsList) once it exists.
const callsModules = import.meta.glob<{
  CallsList?: ComponentType<{ bottomInset?: string }>;
  default?: ComponentType<{ bottomInset?: string }>;
}>('../calls/CallsList.tsx');
const callsLoader = Object.values(callsModules)[0];
const CallsList = callsLoader
  ? lazy(async () => {
      const m = await callsLoader();
      return { default: (m.CallsList ?? m.default ?? CallsPlaceholder) as ComponentType<{ bottomInset?: string }> };
    })
  : null;

function CallsPlaceholder() {
  return (
    <div className="px-6 pt-16 flex flex-col items-center text-center gap-3">
      <div
        className="h-16 w-16 rounded-2xl flex items-center justify-center"
        style={{ background: 'linear-gradient(145deg,#2a2208,#0d0b04)', border: '1px solid #3a2f0c' }}
      >
        <Phone size={28} color={GOLD} />
      </div>
      <p className="text-sm font-semibold text-white">Calls coming soon</p>
    </div>
  );
}

/** The switch's own full-width row, directly under the top bar; identical on every segment. */
export const SegmentRow = ({ children }: { children: ReactNode }) => <div className="w-full px-4 pb-3">{children}</div>;

/** Segment title on the left, that segment's actions on the right (sits below SegmentRow). */
export const SegmentTitle = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex items-center justify-between px-4 pb-2">
    <h1 className="text-[22px] font-bold text-white">{title}</h1>
    <div className="flex items-center gap-1">{children}</div>
  </div>
);

/** The Calls segment: same top bar + switch, then its body. */
const SegmentShell = ({ header, children }: { header: ReactNode; children: ReactNode }) => (
  <div
    className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto"
    style={{ height: '100%', background: 'var(--bw-bg)' }}
  >
    <TopNav />
    <div className="w-full pt-16 flex flex-col">
      <SegmentRow>{header}</SegmentRow>
      <SegmentTitle title="Calls" />
      {children}
    </div>
  </div>
);

export const ChatTabs = ({
  rooms,
  dms,
}: {
  rooms: (header: ReactNode) => ReactNode;
  dms: (header: ReactNode) => ReactNode;
}) => {
  // Opens on Chatrooms (so a pending "Open room" hand-off is never missed) unless a
  // segment was requested before this mounted (chat/segmentNav.ts).
  const [seg, setSeg] = useState<ChatSegment>(() => takeChatSegment() ?? DEFAULT_SEGMENT);
  const change = setSeg;
  // "Open room" from Wallet / Market must land in Chatrooms even if Calls was showing.
  useEffect(() => onTokenNav(() => setSeg('rooms')), []);
  useEffect(
    () =>
      onChatSegment(() => {
        const next = takeChatSegment();
        if (next) setSeg(next);
      }),
    [],
  );
  const badges = useSegmentBadges(seg);
  const header = <SegmentSwitch value={seg} onChange={change} badges={badges} />;
  if (seg === 'rooms') return <>{rooms(header)}</>;
  if (seg === 'dms') return <>{dms(header)}</>;
  return (
    <SegmentShell header={header}>
      {CallsList ? (
        <Suspense fallback={null}>
          <CallsList bottomInset="calc(3.75rem + env(safe-area-inset-bottom, 0px))" />
        </Suspense>
      ) : (
        <CallsPlaceholder />
      )}
    </SegmentShell>
  );
};
