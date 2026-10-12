import type { WalletProtocol } from '@bsv/sdk';

/** bMusic server (bitcoin-music). Configurable until the deploy URL is fixed. */
export const BMUSIC_URL: string = (import.meta.env.VITE_BMUSIC_URL || 'https://bitcoin-music.vercel.app').replace(
  /\/$/,
  '',
);
export const ALBUM_PATH = '/bmusic/streams/first-12';

export type StreamTrack = {
  n: number;
  trackId: string;
  title: string;
  segments: number;
  durations: number[];
  seconds: number;
};
export type Manifest = {
  v: number;
  albumId: string;
  title: string;
  artist?: string;
  satsPerSegment: number;
  segmentSeconds: number;
  endpoint: string;
  keyProtocol: WalletProtocol;
  mime: string;
  paths: { init: string; segment: string };
  tracks: StreamTrack[];
};
export type PayTo = {
  segment: number;
  sats: number;
  lockingScript: string;
  address: string;
  derivationPrefix?: string;
  derivationSuffix?: string;
  senderIdentityKey?: string;
};
export type KeyResponse = {
  txid: string;
  wrappedKey: string;
  protocolID: WalletProtocol;
  keyID: string;
  serverIdentityKey: string;
  next: PayTo | null;
};

/** A non-200 from the stream endpoint, with the server's real reason. */
export class StreamHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`${status}: ${message}`);
  }
}

type Fetch = typeof fetch;

const json = async <T>(r: Response): Promise<T> => {
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new StreamHttpError(r.status, body.error ?? r.statusText);
  return body as T;
};

export const albumUrl = (rel: string, base = BMUSIC_URL) => `${base}${ALBUM_PATH}/${rel}`;
export const initPath = (m: Manifest, trackId: string) => m.paths.init.replace('<trackId>', trackId);
export const segmentPath = (m: Manifest, trackId: string, n: number) =>
  m.paths.segment.replace('<trackId>', trackId).replace('<n>', String(n));

export const fetchManifest = (f: Fetch = fetch, base = BMUSIC_URL) =>
  f(albumUrl('manifest.json', base)).then((r) => json<Manifest>(r));

export const fetchBytes = async (url: string, f: Fetch = fetch) => {
  const r = await f(url);
  if (!r.ok) throw new StreamHttpError(r.status, r.statusText);
  return new Uint8Array(await r.arrayBuffer());
};

export const getPayTo = (trackId: string, segment: number, f: Fetch = fetch, base = BMUSIC_URL) =>
  f(`${base}/api/bmusic/stream/payto?trackId=${encodeURIComponent(trackId)}&segment=${segment}`).then((r) =>
    json<PayTo>(r),
  );

export const postSegment = (
  body: { trackId: string; segment: number; rawTx: string; listener: string; sig: string },
  f: Fetch = fetch,
  base = BMUSIC_URL,
) =>
  f(`${base}/api/bmusic/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<KeyResponse>(r));
