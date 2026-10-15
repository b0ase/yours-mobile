import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { playQueue } from '../media/player';
import { ownedOrigins, ownerSigner } from './ownership';
import { fetchOwnedAudio, fetchPodcasts, type Podcast } from './podcasts';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/** Shown wherever podcasts are listed: recording is the host's choice. */
export const RECORDING_NOTE =
  'Podcasts are Spaces the host chose to record. Recording is off unless the host turns it on.';

/** The podcast catalogue (paged) and which of its NFTs this wallet holds. */
export const usePodcasts = () => {
  const { apiContext } = useServiceContext();
  const [items, setItems] = useState<Podcast[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void fetchPodcasts(f).then((p) => {
      if (!live) return;
      setItems(p.items);
      setCursor(p.cursor);
    });
    return () => {
      live = false;
    };
  }, [reload]);

  useEffect(() => {
    let live = true;
    void ownedOrigins(apiContext).then((o) => live && setOwned(o));
    return () => {
      live = false;
    };
  }, [apiContext, reload]);

  const more = useCallback(async () => {
    if (!cursor) return;
    const p = await fetchPodcasts(f, cursor);
    setItems((x) => [...(x ?? []), ...p.items]);
    setCursor(p.cursor);
  }, [cursor]);

  return { items, owned, more: cursor ? more : null, refresh: () => setReload((n) => n + 1) };
};

/**
 * Play a podcast in the app-wide mini player: the full recording when you hold its NFT (ownership proof),
 * else the public preview. Resolves to what played, or 'none' when there is nothing to play yet.
 */
export const playPodcast = async (
  p: Podcast,
  owned: boolean,
  ctx: ReturnType<typeof useServiceContext>['apiContext'],
  onExpand?: () => void,
): Promise<'full' | 'preview' | 'none'> => {
  const full = owned && ctx && p.nft ? await fetchOwnedAudio(f, p, ownerSigner(ctx, p.nft.origin)) : null;
  const url = full ?? p.previewUrl;
  if (!url) return 'none';
  playQueue(
    [
      {
        id: `podcast:${p.id}`,
        title: p.title,
        url,
        artwork: p.cover ?? undefined,
        subtitle: p.host ? `@${p.host}` : undefined,
        label: full ? undefined : 'Preview',
        album: 'bRadio',
        onExpand,
      },
    ],
    0,
  );
  return full ? 'full' : 'preview';
};
