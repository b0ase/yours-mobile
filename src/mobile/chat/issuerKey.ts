import { BigNumber, BSM, PublicKey, Signature, Utils } from '@bsv/sdk';
import type { WalletInterface } from '@bsv/sdk';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { ONESAT_PROTOCOL } from '@1sat/types';
import { ISSUER_KEY_ID, ISSUER_PROTOCOL } from '../issuer/issuer';
import type { Derivation } from './tokenRooms';

/**
 * Token room admin = the token's issuer. bit-sign resolves the issuer ADDRESS from chain (the
 * BSV-21 deploy+mint output's P2PKH address; a collection's mint funder) and asks for a BSM
 * signature by that address's key. This finds which of this wallet's BRC-42 keys controls it
 * and signs with it. No match (minted from another wallet, or a legacy Yours bsv/ord key the
 * BRC-100 wallet cannot sign with) = the claim is not offered.
 *
 * Only derivation PATHS are remembered (localStorage), never keys.
 */

type SigWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

const DEPLOY_KEYS = 'bwallet.deployKeys.v1';

/** Derivation of a token's deploy output, remembered at mint (the output is spent once tokens move). */
export function rememberDeployKey(tokenId: string, d: Derivation): void {
  try {
    const all = JSON.parse(localStorage.getItem(DEPLOY_KEYS) || '{}') as Record<string, Derivation>;
    all[tokenId.toLowerCase()] = d;
    localStorage.setItem(DEPLOY_KEYS, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function rememberedDeployKeys(): Derivation[] {
  try {
    return Object.values(JSON.parse(localStorage.getItem(DEPLOY_KEYS) || '{}') as Record<string, Derivation>);
  } catch {
    return [];
  }
}

/** The fixed keys every bWallet account has: identity (bChat sign-in), 1Sat deposit, issuer child. */
export const baseDerivations = (): Derivation[] => [
  { protocolID: MESSAGE_SIGNING_PROTOCOL as [0 | 1 | 2, string], keyID: 'identity', counterparty: 'self' },
  { protocolID: ONESAT_PROTOCOL as [0 | 1 | 2, string], keyID: '1sat 0', counterparty: 'self' },
  { protocolID: ISSUER_PROTOCOL, keyID: ISSUER_KEY_ID, counterparty: 'anyone' },
];

const argsOf = (d: Derivation) => ({ protocolID: d.protocolID, keyID: d.keyID, counterparty: d.counterparty });

/** The first derivation whose public key hashes to `address`, or null. */
export async function findKeyFor(
  wallet: SigWallet,
  address: string,
  candidates: Derivation[],
): Promise<Derivation | null> {
  if (!address) return null;
  for (const d of candidates) {
    try {
      const { publicKey } = await wallet.getPublicKey({ ...argsOf(d), forSelf: true });
      if (PublicKey.fromString(publicKey).toAddress() === address) return d;
    } catch {
      /* a key the wallet will not derive is skipped */
    }
  }
  return null;
}

/** Compact BSM signature (base64) over a UTF-8 message by the derived key `d`. */
export async function signBsmWith(wallet: SigWallet, d: Derivation, message: string): Promise<string> {
  const hash = BSM.magicHash(Utils.toArray(message, 'utf8'));
  const { signature } = await wallet.createSignature({ ...argsOf(d), hashToDirectlySign: Array.from(hash) });
  const { publicKey } = await wallet.getPublicKey({ ...argsOf(d), forSelf: true });
  const pub = PublicKey.fromString(publicKey);
  const sig = Signature.fromDER(signature);
  const recovery = sig.CalculateRecoveryFactor(pub, new BigNumber(hash));
  return sig.toCompact(recovery, true, 'base64') as string;
}
