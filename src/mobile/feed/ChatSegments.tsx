import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Phone } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { onTokenNav } from '../chat/nav';
import { onChatSegment, takeChatSegment } from '../chat/segmentNav';
import { FeedPage } from './FeedPage';

/**
 * Chat tab top switch: Rooms | Feed | Calls. Generic: add a segment by adding one entry to
 * SEGMENTS and one case in ChatTabs. Rooms is the existing token-rooms page (it renders the
 * header we pass it in place of its old "Rooms" title).
 */
export type ChatSegment = 'rooms' | 'feed' | 'calls';
export const SEGMENTS: { id: ChatSegment; label: string }[] = [
  { id: 'rooms', label: 'Rooms' },
  { id: 'feed', label: 'Feed' },
  { id: 'calls', label: 'Calls' },
];
const GOLD = '#FFD24D';

export const SegmentSwitch = ({ value, onChange }: { value: ChatSegment; onChange: (s: ChatSegment) => void }) => (
  <div
    role="tablist"
    className="flex rounded-full p-[3px]"
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
          className="rounded-full px-4 py-[6px] text-[13px] font-bold transition-colors"
          style={on ? { background: GOLD, color: '#1a1300' } : { color: '#8a8f98' }}
        >
          {s.label}
        </button>
      );
    })}
  </div>
);

// Calls is built separately: use src/mobile/calls/CallsList.tsx (export CallsList) once it exists.
const callsModules = import.meta.glob<{ CallsList?: ComponentType; default?: ComponentType }>('../calls/CallsList.tsx');
const callsLoader = Object.values(callsModules)[0];
const CallsList = callsLoader
  ? lazy(async () => {
      const m = await callsLoader();
      return { default: (m.CallsList ?? m.default ?? CallsPlaceholder) as ComponentType };
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

/** A non-Rooms segment: same top bar + switch, then its body. */
const SegmentShell = ({ header, children }: { header: ReactNode; children: ReactNode }) => (
  <div
    className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
    style={{ height: '100%', background: '#010101' }}
  >
    <TopNav />
    <div className="w-full pt-16 flex flex-col">
      <div className="flex items-center px-4 pb-2">{header}</div>
      {children}
    </div>
  </div>
);

export const ChatTabs = ({ rooms }: { rooms: (header: ReactNode) => ReactNode }) => {
  // Opens on Rooms (so a pending "Open room" hand-off is never missed) unless a top-bar
  // Feed / phone tap asked for a segment before this mounted (chat/segmentNav.ts).
  const [seg, setSeg] = useState<ChatSegment>(() => takeChatSegment() ?? 'rooms');
  const change = setSeg;
  // "Open room" from Wallet / Market must land in Rooms even if Feed or Calls was showing.
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
  if (seg === 'feed') return <FeedPage header={header} />;
  return (
    <SegmentShell header={header}>
      {CallsList ? (
        <Suspense fallback={null}>
          <CallsList />
        </Suspense>
      ) : (
        <CallsPlaceholder />
      )}
    </SegmentShell>
  );
};
