import { useCallback, useEffect, useState } from 'react';
import type { WalletOutput } from '@bsv/sdk';
import { listOrdinals } from '@1sat/actions';
import { onMinted } from '../mint/mint';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getOutputName, getTagValue } from '../../utils/format';
import { isMediaOutput, kindOf, type MediaKind } from './media';
import { playQueue } from './player';
import { safety } from '../market/safety';
import { cachedMeta, resolveMeta } from './resolveMeta';

/** One of the wallet's non-fungible inscriptions, streamed from ORDFS. */
export type MediaItem = {
  output: WalletOutput;
  name: string;
  type?: string;
  kind: MediaKind;
  url: string;
  flagged: boolean;
};

const PAGE = 50;

/** listOrdinals with two quick retries: a phone waking or switching networks often fails once. */
const listWithRetry = async (ctx: Parameters<typeof listOrdinals.execute>[0], limit: number, offset: number) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await listOrdinals.execute(ctx, { limit, offset });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
};

/** What the user sees when loading fails (the raw error goes to the console). */
export const mediaErrorText = (e: unknown) => {
  console.warn('[media] listOrdinals failed:', e);
  return "Couldn't load your NFTs. Check your connection and pull down to try again.";
};

/**
 * The wallet's media inscriptions, paged from listOrdinals. Shared by Wallet › NFTs (MediaSection)
 * and the Media page (MediaPage). A new mint restarts the list from the top.
 */
export const useWalletMedia = () => {
  const { apiContext } = useServiceContext();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const toItem = useCallback(
    (o: WalletOutput): MediaItem => {
      // NFTs from other sites/markets can lack these tags: fall back to the indexer (resolveMeta.ts).
      const meta = cachedMeta(o.outpoint);
      const type = getTagValue(o.tags, 'type') || meta?.type;
      const origin = getTagValue(o.tags, 'origin') || meta?.origin || o.outpoint;
      const tagged = getOutputName(o, '');
      return {
        output: o,
        name: tagged || meta?.name || 'Inscription',
        type,
        kind: kindOf(type),
        // Your own items are never hidden; ones the Market filter would block are blurred (tap to reveal).
        flagged: safety().check({ ids: [o.outpoint, origin], texts: [getOutputName(o, '')] }).blocked,
        url: `${apiContext.services!.ordfs.getContentUrl(origin)}?outpoint=${o.outpoint}`,
      };
    },
    [apiContext],
  );

  // Repair: look up NFTs missing their type or origin, then redraw them with their real image.
  useEffect(() => {
    const missing = items
      .filter((i) => !getTagValue(i.output.tags, 'type') || !getTagValue(i.output.tags, 'origin'))
      .filter((i) => !cachedMeta(i.output.outpoint))
      .map((i) => i.output.outpoint);
    if (!missing.length) return;
    let live = true;
    void resolveMeta(missing).then((n) => {
      if (live && n) setItems((prev) => prev.map((i) => toItem(i.output)));
    });
    return () => {
      live = false;
    };
  }, [items, toItem]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const { outputs } = await listWithRetry(apiContext, PAGE, offset);
      setError('');
      setItems((prev) => [...prev, ...outputs.filter(isMediaOutput).map(toItem)]);
      setOffset((n) => n + outputs.length);
      setHasMore(outputs.length === PAGE);
    } catch (e) {
      setError(mediaErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [apiContext, offset, hasMore, loading, toItem]);

  useEffect(() => {
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => onMinted(() => setReloadKey((k) => k + 1)), []);
  useEffect(() => {
    if (!reloadKey) return;
    setLoading(true);
    listWithRetry(apiContext, PAGE, 0)
      .then(({ outputs }) => {
        setError('');
        setItems(outputs.filter(isMediaOutput).map(toItem));
        setOffset(outputs.length);
        setHasMore(outputs.length === PAGE);
      })
      .catch((e) => setError(mediaErrorText(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /** Re-reads the first page (pull to refresh). */
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { items, hasMore, loading, error, loadMore, reload };
};

/** Queues every music item in `list` and starts at `item`. */
export const playMusic = (list: MediaItem[], item: MediaItem) => {
  const music = list.filter((i) => i.kind === 'music');
  playQueue(
    music.map((i) => ({ id: i.output.outpoint, title: i.name, url: i.url })),
    Math.max(0, music.indexOf(item)),
  );
};
