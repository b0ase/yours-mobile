import type { PrivateKey } from '@bsv/sdk';
import { unwrapKey } from './crypto';
import type { SessionPayer } from './payer';
import type { SponsorStatus } from './api';
import { PayToPlay, type SponsoredPayer } from './sponsor';

/**
 * Where a segment key comes from. sponsored (a sponsor's pot pays each second) and perSecond (pay each second)
 * are live and share the MSE playback path; owner (holds the album) and
 * perPlay (one payment per play) share the interface and come later.
 */
export type KeySourceKind = 'owner' | 'sponsored' | 'perSecond' | 'perPlay';
export interface KeySource {
  readonly kind: KeySourceKind;
  segmentKey(trackId: string, segment: number): Promise<Uint8Array>;
}

export class PerSecondKeySource implements KeySource {
  readonly kind = 'perSecond' as const;
  constructor(
    private payer: SessionPayer,
    private sessionKey: PrivateKey,
  ) {}
  async segmentKey(trackId: string, segment: number) {
    const r = await this.payer.pay(trackId, segment);
    return unwrapKey(this.sessionKey, r.wrappedKey, r.protocolID, r.keyID, r.serverIdentityKey);
  }
}

export class SponsoredKeySource implements KeySource {
  readonly kind = 'sponsored' as const;
  constructor(
    private payer: SponsoredPayer,
    private sessionKey: PrivateKey,
    /** Tracks this pot pays for; any other track throws PayToPlay without a request. */
    private covers: (trackId: string) => boolean = () => true,
  ) {}
  async segmentKey(trackId: string, segment: number) {
    if (!this.covers(trackId)) throw new PayToPlay(trackId);
    const r = await this.payer.pay(trackId, segment);
    return unwrapKey(this.sessionKey, r.wrappedKey, r.protocolID, r.keyID, r.serverIdentityKey);
  }
}

/** The engine's choice: sponsored first (free to the listener), then perSecond. */
export const pickKeySource = (opts: { sponsored?: KeySource | null; perSecond?: KeySource | null }): KeySource | null =>
  opts.sponsored ?? opts.perSecond ?? null;

/**
 * Whether the pot pays for this track (owner, 12 Oct 2026: first-12 tracks 1–6 sponsored, 7–12 pay to play).
 * Needs a funded pot; a server without the per-track lists sponsors every track.
 */
export const isSponsoredTrack = (s: SponsorStatus | null | undefined, trackId: string) => {
  if (!s?.sponsored) return false;
  if (s.payToPlayTracks?.includes(trackId)) return false;
  return s.sponsoredTracks ? s.sponsoredTracks.includes(trackId) : true;
};

/** The key source for one track: sponsored when the pot covers it, else pay each second. */
export const trackSourceKind = (s: SponsorStatus | null | undefined, trackId: string): 'sponsored' | 'perSecond' =>
  isSponsoredTrack(s, trackId) ? 'sponsored' : 'perSecond';

class NotYet implements KeySource {
  constructor(readonly kind: KeySourceKind) {}
  segmentKey(): Promise<Uint8Array> {
    return Promise.reject(new Error(`${this.kind} keys are not available yet`));
  }
}
export const ownerKeySource = (): KeySource => new NotYet('owner');
export const perPlayKeySource = (): KeySource => new NotYet('perPlay');
