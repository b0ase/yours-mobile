import { useEffect, useState } from 'react';
import { onMinted } from '../../mint/mint';
import { feedUrl, parseFeed, visibleReleases, type Release } from './releases';

/** Published releases from the indexer, newest first. Quiet on failure: the shelf just doesn't show. */
export function useReleases(): Release[] {
  const [list, setList] = useState<Release[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => onMinted(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    fetch(feedUrl(0), { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : []))
      .then((raw: unknown) => live && setList(visibleReleases(parseFeed(raw))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tick]);
  return list;
}
