import type { PrivateKey } from '@bsv/sdk';
import { unwrapKey } from './crypto';
import type { SessionPayer } from './payer';
import type { SponsoredPayer } from './sponsor';

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
  ) {}
  async segmentKey(trackId: string, segment: number) {
    const r = await this.payer.pay(trackId, segment);
    return unwrapKey(this.sessionKey, r.wrappedKey, r.protocolID, r.keyID, r.serverIdentityKey);
  }
}

/** The engine's choice: sponsored first (free to the listener), then perSecond. */
export const pickKeySource = (opts: { sponsored?: KeySource | null; perSecond?: KeySource | null }): KeySource | null =>
  opts.sponsored ?? opts.perSecond ?? null;

class NotYet implements KeySource {
  constructor(readonly kind: KeySourceKind) {}
  segmentKey(): Promise<Uint8Array> {
    return Promise.reject(new Error(`${this.kind} keys are not available yet`));
  }
}
export const ownerKeySource = (): KeySource => new NotYet('owner');
export const perPlayKeySource = (): KeySource => new NotYet('perPlay');
