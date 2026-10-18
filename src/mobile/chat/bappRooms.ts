/**
 * bApp rooms: chatrooms owned by a bApp (bRadio Lounge, bMovies, bMusicX…), listed under the Chat tab's
 * "bApps" filter and kept out of "Rooms". Rooms carry no app/brand marker in their metadata (checked
 * ticker_rooms, 18 Oct 2026), so this one list is the source of truth. Add a bApp's room ticker here.
 * The Help Desk (LOUNGE) is not a bApp room: it stays the pinned card above every filter.
 */
export const BAPP_ROOM_TICKERS: readonly string[] = ['BRADIO', 'BMOVIES', 'BMUSIC', 'BMUSICX'];

export const isBappRoom = (ticker: string | null | undefined): boolean =>
  BAPP_ROOM_TICKERS.includes((ticker ?? '').replace(/^\$/, '').toUpperCase());
