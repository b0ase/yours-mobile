/** The Chat tab's filter choice, remembered per device (SpacesFilter.tsx draws the chips). */
// Rooms = your chats, token rooms and groups; Spaces = live Spaces; bApps = app-owned rooms (chat/bappRooms.ts).
// Owner, 18 Oct 2026 (replaces All | Rooms | Spaces). Rooms is the default.
export type RoomFilter = 'rooms' | 'spaces' | 'bapps';
const FILTERS: readonly RoomFilter[] = ['rooms', 'spaces', 'bapps'];
const FILTER_KEY = 'bw.chat.roomFilter';
/** The last filter picked on this device; Rooms when unset or storage is blocked. */
export const loadRoomFilter = (): RoomFilter => {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return FILTERS.includes(v as RoomFilter) ? (v as RoomFilter) : 'rooms';
  } catch {
    return 'rooms';
  }
};
export const saveRoomFilter = (f: RoomFilter): void => {
  try {
    localStorage.setItem(FILTER_KEY, f);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
};
