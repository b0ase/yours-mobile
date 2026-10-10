import { signBsm, type OneSatContext } from '@1sat/actions';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { PublicKey, Utils } from '@bsv/sdk';
import type { ChatSigner } from './api';
import { lookupPaymail, PAYMAIL_ALIAS_RE } from '../names/paymail';

/**
 * The in-app wallet as a bChat signer: the same BRC-100 identity key and BSM
 * signature bChat's web sign-in requests over window.CWI, called directly on
 * the wallet's own context (normal wallet approval rules apply).
 */
export const walletSigner = (ctx: OneSatContext): ChatSigner => ({
  address: async () => {
    const { publicKey } = await ctx.wallet.getPublicKey({
      protocolID: MESSAGE_SIGNING_PROTOCOL,
      keyID: 'identity',
      forSelf: true,
    });
    return PublicKey.fromString(publicKey).toAddress();
  },
  sign: async (message) => {
    const res = await signBsm.execute(ctx, { message });
    if (res.error) throw new Error(res.error);
    if (!res.address || !res.pubKey || !res.sig) throw new Error('The wallet returned an incomplete signature.');
    return { address: res.address, pubKey: res.pubKey, sig: res.sig };
  },
  // A new bChat account takes the plain paymail name this wallet's owner chose; a verified .x / .gmail
  // name is not a handle (and a .gmail one would publish the address), so those wait for "Choose your handle".
  handle: async () => {
    const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
    const alias = (await lookupPaymail((u, i) => fetch(u, i), publicKey).catch(() => null))?.split('@')[0] ?? '';
    return PAYMAIL_ALIAS_RE.test(alias) ? alias : null;
  },
  // Must match bit-sign src/lib/adopt-wallet-name.ts (adoptMessage, ADOPT_PROTOCOL, ADOPT_KEY_ID).
  identityProof: async (nonce) => {
    const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
    const { signature } = await ctx.wallet.createSignature({
      data: Utils.toArray(`bit-sign|adopt-wallet-name|v1|nonce=${nonce}`, 'utf8'),
      protocolID: [2, 'bitsign handle claim'],
      keyID: '1',
      counterparty: 'anyone',
    });
    return { identity_key: publicKey, identity_signature: Utils.toHex(signature) };
  },
});
