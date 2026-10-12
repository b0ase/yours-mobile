import { Utils, type PrivateKey } from '@bsv/sdk';
import { StreamHttpError, type SponsoredKeyResponse } from './api';

/**
 * Sponsored listening: the bMusic server's pot pays each second for the listener (1 sat to the artist + fee).
 * The listener only signs each request with the session key (also the BRC-2 recipient of the segment key).
 * Paced to one request per second (the server allows about 1 per 0.7 s). 429 backs off and retries; 502
 * retries the same segment up to 3 times; 410 (pot empty, capped or closed) ends sponsorship: the caller
 * switches to the paid flow from the same segment.
 */
export const SPONSOR_PACE_MS = 1000;
export const SPONSOR_502_TRIES = 3;
export const SPONSOR_429_TRIES = 6;

export const sponsoredMessage = (trackId: string, segment: number) => `sponsored:${trackId}:${segment}`;
export const signSponsored = (key: PrivateKey, trackId: string, segment: number) =>
  key.sign(Utils.toArray(sponsoredMessage(trackId, segment), 'utf8')).toDER('hex') as string;

/** The pot has run out (410): continue with the paid flow. */
export class SponsorEnded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SponsorEnded';
  }
}

export type SponsorStats = { seconds: number; payments: number; lastTxid: string | null; recent: number[] };
export type SponsorSnapshot = {
  status: 'ready' | 'paying' | 'ended' | 'error';
  error: string | null;
  stats: SponsorStats;
};

export type SponsorDeps = {
  key: PrivateKey;
  post: (body: { trackId: string; segment: number; listener: string; sig: string }) => Promise<SponsoredKeyResponse>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onChange?: (s: SponsorSnapshot) => void;
};

export class SponsoredPayer {
  status: SponsorSnapshot['status'] = 'ready';
  error: string | null = null;
  stats: SponsorStats = { seconds: 0, payments: 0, lastTxid: null, recent: [] };
  private lastAt = -Infinity;
  private paid = new Set<string>();
  private readonly listener: string;

  constructor(private deps: SponsorDeps) {
    this.listener = deps.key.toPublicKey().toString();
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  snapshot(): SponsorSnapshot {
    return { status: this.status, error: this.error, stats: { ...this.stats, recent: [...this.stats.recent] } };
  }
  private emit() {
    this.deps.onChange?.(this.snapshot());
  }

  /** One request at a least SPONSOR_PACE_MS after the previous one. */
  private async paced<T>(fn: () => Promise<T>) {
    const wait = this.lastAt + SPONSOR_PACE_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastAt = this.now();
    return fn();
  }

  async pay(trackId: string, segment: number): Promise<SponsoredKeyResponse> {
    if (this.status === 'ended') throw new SponsorEnded(this.error ?? 'Sponsored plays have run out');
    this.status = 'paying';
    const sig = signSponsored(this.deps.key, trackId, segment);
    let bad = 0;
    let busy = 0;
    for (;;) {
      try {
        const r = await this.paced(() => this.deps.post({ trackId, segment, listener: this.listener, sig }));
        const tag = `${trackId}:${segment}`;
        // A re-request re-issues the key; the pot did not pay again, so it is not counted again.
        if (!this.paid.has(tag)) {
          this.paid.add(tag);
          const now = this.now();
          this.stats = {
            seconds: this.stats.seconds + 1,
            payments: this.stats.payments + 1,
            lastTxid: r.txid || this.stats.lastTxid,
            recent: [...this.stats.recent.filter((t) => now - t < 10_000), now],
          };
        }
        this.status = 'ready';
        this.error = null;
        this.emit();
        return r;
      } catch (e) {
        const status = e instanceof StreamHttpError ? e.status : 0;
        if (status === 410) {
          this.status = 'ended';
          this.error = e instanceof Error ? e.message : String(e);
          this.emit();
          throw new SponsorEnded(this.error);
        }
        if (status === 429 && ++busy < SPONSOR_429_TRIES) {
          await this.sleep(SPONSOR_PACE_MS * 2 ** busy);
          continue;
        }
        if (status === 502 && ++bad < SPONSOR_502_TRIES) {
          await this.sleep(SPONSOR_PACE_MS * 2 ** bad);
          continue;
        }
        this.status = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        this.emit();
        throw e;
      }
    }
  }

  /** After an error (not 'ended'): try again from the same segment. */
  resync() {
    if (this.status !== 'error') return;
    this.status = 'ready';
    this.error = null;
    this.emit();
  }
}
