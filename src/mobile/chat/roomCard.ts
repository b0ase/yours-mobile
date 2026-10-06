import { useCallback, useEffect, useState } from 'react';
import { type BchatClient } from './api';
import { parseRoomCard, type OpenRoomCard } from './openRooms';

/** Long-press (touch) or right-click (desktop) on a message bubble. */
export const longPress = (fn: () => void) => {
  let timer: number | undefined;
  const clear = () => window.clearTimeout(timer);
  return {
    onTouchStart: () => {
      clear();
      timer = window.setTimeout(fn, 500);
    },
    onTouchEnd: clear,
    onTouchMove: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      fn();
    },
  };
};

/** Fetch an open room's card (role, members, invite code). Null until loaded or on failure. */
export const useRoomCard = (client: BchatClient, ticker: string | null) => {
  const [card, setCard] = useState<OpenRoomCard | null>(null);
  const reload = useCallback(() => {
    if (!ticker) return setCard(null);
    client
      .openRoomCard(ticker)
      .then((d) => setCard(parseRoomCard(d)))
      .catch(() => setCard(null));
  }, [client, ticker]);
  useEffect(reload, [reload]);
  return { card, reload };
};
