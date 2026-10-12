/**
 * Big transactions need longer to upload than the broadcaster client allows.
 *
 * vexvoid.com, 12 Oct 2026: a 4.2 MB video mint (a ~9.8 MB payload on the site's side) was posted as atomic BEEF to
 * 1sat-stack's /1sat/arcade/tx, which accepts up to 100 MB (GET /1sat/arcade/policy: maxtxsizepolicy 100000000).
 * The client's fixed 30 s timeout (OneSatServices, BaseClient) covers the upload AND the stack's wait for a network
 * verdict, so a big upload on a slow line was cut off. That is reported as NETWORK_ERROR -> serviceError, the
 * toolbox queued the send ('sending'), and signAction threw "network is slow". A later Monitor retry got it mined.
 *
 * Fix: before each postBeef, scale the broadcaster's timeout with the payload size. Size is not the limit (100 MB
 * policy; wallet mints stay far below it); a send that still gets no verdict is queued and, if it never lands,
 * cancelled with its inputs released (stuckSends.ts).
 */

export const BASE_TIMEOUT_MS = 30_000;
/** Allow for a slow uplink: ~0.5 Mbit/s (16 s per MB) on top of the base wait. */
export const MS_PER_MB = 16_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;

export function broadcastTimeoutMs(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return BASE_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.round(BASE_TIMEOUT_MS + (bytes / 1_000_000) * MS_PER_MB));
}

type BeefLike = { toBinary: () => number[] | Uint8Array };
type PostBeef = (beef: BeefLike, txids: string[], logger?: unknown) => Promise<unknown>;
type StackServices = { postBeef: PostBeef; arcade?: { timeout?: number } };

/**
 * Wrap services.postBeef so each broadcast's timeout fits its size. Returns false when the services object has
 * no arcade client to tune (left untouched).
 */
export function sizeAwareBroadcast(services: unknown, log: (m: string) => void = console.log): boolean {
  const s = services as StackServices | null;
  if (!s || typeof s.postBeef !== 'function' || !s.arcade || typeof s.arcade.timeout !== 'number') return false;
  const arcade = s.arcade;
  const original = s.postBeef.bind(s);
  let inFlight = 0;
  s.postBeef = async (beef, txids, logger) => {
    let bytes = 0;
    try {
      bytes = beef.toBinary().length;
    } catch {
      /* unknown size: base timeout */
    }
    const timeout = broadcastTimeoutMs(bytes);
    if (timeout > BASE_TIMEOUT_MS) log(`[broadcast] ${bytes} bytes: timeout ${Math.round(timeout / 1000)} s`);
    inFlight++;
    arcade.timeout = Math.max(arcade.timeout ?? BASE_TIMEOUT_MS, timeout);
    try {
      return await original(beef, txids, logger);
    } finally {
      if (--inFlight === 0) arcade.timeout = BASE_TIMEOUT_MS;
    }
  };
  return true;
}
