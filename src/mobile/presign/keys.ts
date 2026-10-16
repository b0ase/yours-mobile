/**
 * Pre-signed payments — key derivation (docs/PRESIGNED-PAYMENTS.md §1.3).
 *
 * Every key is BRC-42 derived, so the payer side is recoverable from the seed
 * alone and the service side from the service root alone:
 *   P = payer claim key   keyID `<setId>:<slot>`         counterparty = service identity
 *   S = service key       keyID `<setId>:<slot>`         counterparty = payer identity
 *   R = payer refund key  keyID `<setId>:<slot>:refund`  counterparty = self
 */
import { KeyDeriver, type PrivateKey, type PublicKey, type WalletProtocol } from '@bsv/sdk';

export const PRESIGN_PROTOCOL: WalletProtocol = [2, 'bwalletx presign'];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function slotKeyId(setId: string, index: number): string {
  if (!ID_RE.test(setId)) throw new Error('presign: setId must be 1-64 chars of [A-Za-z0-9_-]');
  if (!Number.isInteger(index) || index < 0 || index > 9999) throw new Error('presign: slot index out of range');
  return `${setId}:${index}`;
}

export function refundKeyId(setId: string, index: number): string {
  return `${slotKeyId(setId, index)}:refund`;
}

/** Payer side: private P and R plus the public S for one slot. */
export function payerSlotKeys(
  payerRoot: PrivateKey,
  serviceIdentity: PublicKey,
  setId: string,
  index: number,
): { P: PrivateKey; R: PrivateKey; S: PublicKey } {
  const d = new KeyDeriver(payerRoot);
  const keyId = slotKeyId(setId, index);
  return {
    P: d.derivePrivateKey(PRESIGN_PROTOCOL, keyId, serviceIdentity.toString()),
    R: d.derivePrivateKey(PRESIGN_PROTOCOL, refundKeyId(setId, index), 'self'),
    S: d.derivePublicKey(PRESIGN_PROTOCOL, keyId, serviceIdentity.toString(), false),
  };
}

/** Service side: private S plus the public P for one slot. */
export function serviceSlotKeys(
  serviceRoot: PrivateKey,
  payerIdentity: PublicKey,
  setId: string,
  index: number,
): { S: PrivateKey; P: PublicKey } {
  const d = new KeyDeriver(serviceRoot);
  const keyId = slotKeyId(setId, index);
  return {
    S: d.derivePrivateKey(PRESIGN_PROTOCOL, keyId, payerIdentity.toString()),
    P: d.derivePublicKey(PRESIGN_PROTOCOL, keyId, payerIdentity.toString(), false),
  };
}
