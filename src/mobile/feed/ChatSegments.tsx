import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Phone } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { onTokenNav } from '../chat/nav';
import { onChatSegment, takeChatSegment } from '../chat/segmentNav';

/**
 * Chat tab top switch: Chatrooms | DMs | Calls (Feed is its own bottom-bar tab). Generic: add a
 * segment by adding one entry to SEGMENTS and one case in ChatTabs. Chatrooms (id 'rooms') is the
 * token-rooms page; DMs is the 1:1 list + contacts (chat/DmsPage.tsx). Each renders the header
 * we pass it.
 */
export type ChatSegment = 'rooms' | 'dms' | 'calls';
const SEGMENTS: { id: ChatSegment; label: string }[] = [
  { id: 'rooms', label: 'Chatrooms' },
  { id: 'dms', label: 'DMs' },
  { id: 'calls', label: 'Calls' },
];
const GOLD = '#FFD24D';

export const SegmentSwitch = ({ value, onChange }: { value: ChatSegment; onChange: (s: ChatSegment) => void }) => (
  <div
    role="tablist"
    className="flex w-full rounded-full p-[3px]"
    style={{ background: '#121316', border: '1px solid #1f2127' }}
  >
    {SEGMENTS.map((s) => {
      const on = s.id === value;
      return (
        <button
          key={s.id}
          role="tab"
          aria-selected={on}
          onClick={() => onChange(s.id)}
          className="flex-1 rounded-full px-4 py-[7px] text-[13px] font-bold transition-colors"
          style={on ? { background: GOLD, color: '#1a1300' } : { color: '#8a8f98' }}
        >
          {s.label}
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
    style={{ height: '100%', background: '#010101' }}
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
  const [seg, setSeg] = useState<ChatSegment>(() => takeChatSegment() ?? 'rooms');
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
  const header = <SegmentSwitch value={seg} onChange={change} />;
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
