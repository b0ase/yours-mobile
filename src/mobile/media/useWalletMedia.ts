import { useCallback, useEffect, useState } from 'react';
import type { WalletOutput } from '@bsv/sdk';
import { listOrdinals } from '@1sat/actions';
import { onMinted } from '../mint/mint';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getOutputName, getTagValue } from '../../utils/format';
import { isMediaOutput, kindOf, type MediaKind } from './media';
import { playQueue } from './player';
import { safety } from '../market/safety';

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
      const type = getTagValue(o.tags, 'type');
      const origin = getTagValue(o.tags, 'origin') || o.outpoint;
      return {
        output: o,
        name: getOutputName(o, 'Inscription'),
        type,
        kind: kindOf(type),
        // Your own items are never hidden; ones the Market filter would block are blurred (tap to reveal).
        flagged: safety().check({ ids: [o.outpoint, origin], texts: [getOutputName(o, '')] }).blocked,
        url: `${apiContext.services!.ordfs.getContentUrl(origin)}?outpoint=${o.outpoint}`,
      };
    },
    [apiContext],
  );

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const { outputs } = await listOrdinals.execute(apiContext, { limit: PAGE, offset });
      setItems((prev) => [...prev, ...outputs.filter(isMediaOutput).map(toItem)]);
      setOffset((n) => n + outputs.length);
      setHasMore(outputs.length === PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHasMore(false);
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
    listOrdinals
      .execute(apiContext, { limit: PAGE, offset: 0 })
      .then(({ outputs }) => {
        setItems(outputs.filter(isMediaOutput).map(toItem));
        setOffset(outputs.length);
        setHasMore(outputs.length === PAGE);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return { items, hasMore, loading, error, loadMore };
};

/** Queues every music item in `list` and starts at `item`. */
export const playMusic = (list: MediaItem[], item: MediaItem) => {
  const music = list.filter((i) => i.kind === 'music');
  playQueue(
    music.map((i) => ({ id: i.output.outpoint, title: i.name, url: i.url })),
    Math.max(0, music.indexOf(item)),
  );
};
