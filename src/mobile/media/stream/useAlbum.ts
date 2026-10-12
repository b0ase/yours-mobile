import { useEffect, useState } from 'react';
import { albumUrl, fetchManifest, getSponsored, type Manifest, type SponsorStatus } from './api';
import { albumView, type AlbumView } from './album';
import { HEADLINE_ALBUM } from '../featured/featured';

export const SPONSOR_ALBUM_ID = 'first-12';

/** One manifest fetch per page load, shared by the banner, the track list and the album page. */
let manifestP: Promise<Manifest> | null = null;
export const loadManifest = () => (manifestP ??= fetchManifest().catch((e) => ((manifestP = null), Promise.reject(e))));

export const viewOf = (m: Manifest): AlbumView =>
  albumView(
    m,
    {
      title: HEADLINE_ALBUM.title,
      artist: HEADLINE_ALBUM.artist,
      cover: HEADLINE_ALBUM.cover,
      headlineTitle: HEADLINE_ALBUM.headline.title,
    },
    albumUrl('manifest.json'),
  );

export function useManifest() {
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadManifest()
      .then((x) => live && setM(x))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  return { m, error, view: m ? viewOf(m) : null };
}

/** The sponsor pot; refreshed every `everyMs` when given (the live gauge). Null until known or on error. */
export function useSponsor(everyMs?: number) {
  const [s, setS] = useState<SponsorStatus | null>(null);
  const [known, setKnown] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      getSponsored(SPONSOR_ALBUM_ID)
        .then((x) => live && setS(x))
        .catch(() => {
          /* unknown = not sponsored; the paid flow still works */
        })
        .finally(() => live && setKnown(true));
    void load();
    const i = everyMs ? setInterval(load, everyMs) : null;
    return () => {
      live = false;
      if (i) clearInterval(i);
    };
  }, [everyMs]);
  return [s, setS, known] as const;
}

export const sponsorName = (s: SponsorStatus) => (s.sponsor.toLowerCase() === 'vexvoid' ? 'VexVoid' : s.sponsor);
