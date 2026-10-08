/**
 * The Chat tab's room filters: All | Spaces. Spaces lists the token rooms you're in that have a space
 * on, live first with a LIVE badge; tapping one opens the room, where the Live now banner joins it.
 * bWalletX only: ChatPage mounts this behind BSPACES_ENABLED, so the store bundle drops it.
 */
import { Radio } from 'lucide-react';
import type { BchatClient } from '../chat/api';
import { audienceCount, audienceLine, roomsWithSpaces, stageOf } from './model';
import { MAX_ROOMS, useRoomSpaces } from './roomSpaces';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const PANEL = '#121316';
const CLIP = 'overflow-hidden text-ellipsis whitespace-nowrap';

export type RoomFilter = 'all' | 'spaces';
const CHIPS: [RoomFilter, string][] = [
  ['all', 'All'],
  ['spaces', 'Spaces'],
];

/** Chips scroll sideways on their own if more are added; the page never overflows. */
export const RoomFilterChips = ({ value, onChange }: { value: RoomFilter; onChange: (f: RoomFilter) => void }) => (
  <div className="w-full max-w-full overflow-x-auto px-4 pb-2" style={{ scrollbarWidth: 'none' }}>
    <div className="flex w-max gap-2" role="tablist">
      {CHIPS.map(([k, label]) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
          className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold"
          style={
            value === k
              ? { background: GOLD, color: '#1a1300' }
              : { background: PANEL, color: '#fff', border: `1px solid ${LINE}` }
          }
        >
          {label}
        </button>
      ))}
    </div>
  </div>
);

export interface SpaceRoomItem {
  key: string;
  ticker: string;
  title: string;
}

export const SpacesRoomList = ({
  client,
  me,
  items,
  onOpen,
}: {
  client: BchatClient;
  me: string;
  items: SpaceRoomItem[];
  onOpen: (key: string) => void;
}) => {
  const states = useRoomSpaces(
    client,
    items.map((i) => i.ticker),
    me,
    true,
  );
  if (items.length === 0)
    return (
      <p className="px-4 pt-4 text-xs" style={{ color: MUTED }}>
        Spaces happen in token rooms. Join a token room to see its spaces here.
      </p>
    );
  if (!states)
    return (
      <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
        Checking your rooms for spaces…
      </div>
    );
  const rows = roomsWithSpaces(items.filter((i) => states[i.ticker]).map((i) => ({ ...i, state: states[i.ticker] })));
  return (
    <>
      {rows.length === 0 && (
        <p className="px-4 pt-4 text-xs" style={{ color: MUTED }}>
          No spaces on in your rooms right now. This list refreshes every 30 seconds.
        </p>
      )}
      <ul className="w-full">
        {rows.map(({ key, title, state }) => (
          <li key={key}>
            <button
              onClick={() => onOpen(key)}
              className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
              style={{ borderBottom: `1px solid ${LINE}` }}
            >
              <span
                className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center"
                style={{ background: '#D92D20' }}
              >
                <Radio size={18} color="#fff" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`text-[15px] font-semibold text-white ${CLIP}`}>{state.space?.title || title}</span>
                  <span
                    className="shrink-0 rounded px-1 py-[1px] text-[9px] font-bold tracking-wide"
                    style={{ background: '#D92D20', color: '#fff' }}
                  >
                    LIVE
                  </span>
                </span>
                <span className={`block text-[12px] ${CLIP}`} style={{ color: MUTED }}>
                  {title} ·{' '}
                  {stageOf(state)
                    .slice(0, 2)
                    .map((p) => `$${p.handle}`)
                    .join(', ')}{' '}
                  · {audienceLine(audienceCount(state))}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > MAX_ROOMS && (
        <p className="px-4 pt-3 text-[11px]" style={{ color: MUTED }}>
          Checked your {MAX_ROOMS} most recent token rooms.
        </p>
      )}
    </>
  );
};
