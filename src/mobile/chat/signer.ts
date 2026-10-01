import { signBsm, type OneSatContext } from '@1sat/actions';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { PublicKey } from '@bsv/sdk';
import type { ChatSigner } from './api';

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
});
