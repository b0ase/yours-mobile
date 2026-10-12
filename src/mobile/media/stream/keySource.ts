import type { PrivateKey } from '@bsv/sdk';
import { unwrapKey } from './crypto';
import type { SessionPayer } from './payer';

/**
 * Where a segment key comes from. perSecond (pay each second) is live; owner (holds the album) and
 * perPlay (one payment per play) share the interface and come later.
 */
export type KeySourceKind = 'owner' | 'perSecond' | 'perPlay';
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

class NotYet implements KeySource {
  constructor(readonly kind: KeySourceKind) {}
  segmentKey(): Promise<Uint8Array> {
    return Promise.reject(new Error(`${this.kind} keys are not available yet`));
  }
}
export const ownerKeySource = (): KeySource => new NotYet('owner');
export const perPlayKeySource = (): KeySource => new NotYet('perPlay');
