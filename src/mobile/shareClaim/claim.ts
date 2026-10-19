import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { canonicalBytes } from './canonical';
import type { CheckedInvite } from './invite';

/**
 * Lock key: BRC-42 from the seed, protocol [1,'npg share'], keyID = inviteId, counterparty 'self'.
 * One lockPubKey per invite, used for every tranche of that invite (each tranche gets its own output, same keys).
 * Recoverable from the seed alone given the inviteId (see recovery.ts).
 */
export const LOCK_PROTOCOL: WalletProtocol = [1, 'npg share'];
export const CLAIM_PROTOCOL: WalletProtocol = [1, 'npg share claim'];

type KeyWallet = Pick<WalletInterface, 'getPublicKey'>;
type SignWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

export async function lockPubKeyFor(wallet: KeyWallet, inviteId: string): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ protocolID: LOCK_PROTOCOL, keyID: inviteId, counterparty: 'self' });
  return publicKey.toLowerCase();
}

/** The exact bytes the claim signature covers. */
export const claimSignedBytes = (inviteId: string, identityKey: string, lockPubKey: string) =>
  canonicalBytes({ inviteId, identityKey: identityKey.toLowerCase(), lockPubKey: lockPubKey.toLowerCase() });

export type ClaimBody = { inviteId: string; identityKey: string; lockPubKey: string; signature: string };

/** Signs a claim for given keys (the NPG test vector checks these bytes and this signature exactly). */
export async function signClaim(
  wallet: Pick<WalletInterface, 'createSignature'>,
  inviteId: string,
  identityKey: string,
  lockPubKey: string,
): Promise<ClaimBody> {
  const id = identityKey.toLowerCase();
  const lock = lockPubKey.toLowerCase();
  // Mirrors the NPG server: the lock key must never be the identity key.
  if (id === lock) throw new Error('The lock key must differ from the identity key');
  const { signature } = await wallet.createSignature({
    data: claimSignedBytes(inviteId, id, lock),
    protocolID: CLAIM_PROTOCOL,
    keyID: inviteId,
    counterparty: 'anyone',
  });
  return { inviteId, identityKey: id, lockPubKey: lock, signature: Utils.toHex(signature) };
}

export async function buildClaim(wallet: SignWallet, inviteId: string): Promise<ClaimBody> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  return signClaim(wallet, inviteId, publicKey, await lockPubKeyFor(wallet, inviteId));
}

export type ClaimResult = {
  /** Set once the company has moved the tokens into the locks (TODO(owner): who moves them is undecided). */
  txid?: string;
  /** Other inviteIds this identity has claimed (helps recovery on a new device). */
  claims?: { inviteId: string; company?: string }[];
};

/** POST the signed claim to the invite's claimUrl (already checked to be on the pinned company host). */
export async function postClaim(inv: CheckedInvite, body: ClaimBody, f: typeof fetch = fetch): Promise<ClaimResult> {
  const r = await f(inv.claimUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 503) throw new Error('The company has not set up share claims yet');
  if (r.status === 409) throw new Error('One of these tranches is not on chain yet; try again later');
  if (!r.ok) {
    const msg = await r
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => null);
    throw new Error(msg || `The company server answered ${r.status}`);
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const out: ClaimResult = {};
  if (typeof j.txid === 'string' && /^[0-9a-f]{64}$/i.test(j.txid)) out.txid = j.txid.toLowerCase();
  if (Array.isArray(j.claims))
    out.claims = j.claims
      .filter((c): c is { inviteId: string; company?: string } => !!c && typeof c.inviteId === 'string')
      .map((c) => ({ inviteId: c.inviteId, company: typeof c.company === 'string' ? c.company : undefined }));
  return out;
}
