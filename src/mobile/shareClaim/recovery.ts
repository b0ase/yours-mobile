import { PublicKey, type WalletInterface } from '@bsv/sdk';
import { lockPubKeyFor } from './claim';
import { isInviteId } from './invite';

/**
 * Recovery of share-lock keys from the seed (docs/SHARE-CLAIM.md "Recovery").
 * The lock key is BRC-42(seed, [1,'npg share'], keyID = inviteId, self), so it is rebuilt without our server
 * PROVIDED the inviteId is known. Ids come from (a) this device's claim records and (b) the company's claims list.
 * Limits: if both are lost, the inviteId cannot be guessed (256-bit), and the holder needs the company to re-send
 * it; the shares themselves are safe meanwhile (the company cannot move them alone either).
 */
export type RecoveredKey = { inviteId: string; company?: string; lockPubKey: string; lockAddress: string };

export async function recoverLockKeys(
  wallet: Pick<WalletInterface, 'getPublicKey'>,
  sources: { inviteId: string; company?: string }[][],
): Promise<RecoveredKey[]> {
  const byId = new Map<string, string | undefined>();
  for (const list of sources)
    for (const s of list) if (isInviteId(s.inviteId) && !byId.has(s.inviteId)) byId.set(s.inviteId, s.company);
  const out: RecoveredKey[] = [];
  for (const [inviteId, company] of byId) {
    const lockPubKey = await lockPubKeyFor(wallet, inviteId);
    out.push({ inviteId, company, lockPubKey, lockAddress: PublicKey.fromString(lockPubKey).toAddress() });
  }
  return out;
}
