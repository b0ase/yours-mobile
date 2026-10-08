/**
 * Which of my token rooms have a space on. bit-sign has no list endpoint yet (plan Phase 2:
 * GET /spaces/live), so this asks each room's existing GET rooms/[ticker]/space, capped and a few at
 * a time. Used by the Chat tab's Spaces filter (and the same pattern as SpacesPage).
 */
import { useEffect, useState } from 'react';
import type { BchatClient } from '../chat/api';
import { parseSpaceState, type SpaceState } from './model';

export const MAX_ROOMS = 25;
const PARALLEL = 5;
const POLL_MS = 30_000;

export async function inBatches<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/** ticker → state for up to MAX_ROOMS tickers; null while the first pass loads. Polls while enabled. */
export const useRoomSpaces = (
  client: BchatClient,
  tickers: string[],
  me: string,
  enabled: boolean,
): Record<string, SpaceState> | null => {
  const [states, setStates] = useState<Record<string, SpaceState> | null>(null);
  const key = tickers.slice(0, MAX_ROOMS).join(',');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const list = key ? key.split(',') : [];
    const load = async () => {
      const got = await inBatches(list, PARALLEL, async (t) => {
        const state = parseSpaceState(await client.space(t).catch(() => null), me);
        return [t, state] as const;
      });
      if (live) setStates(Object.fromEntries(got));
    };
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client, key, me, enabled]);
  return states;
};
