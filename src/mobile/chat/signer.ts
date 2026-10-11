import { signBsm, type OneSatContext } from '@1sat/actions';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { PublicKey, Utils } from '@bsv/sdk';
import type { ChatSigner } from './api';
import { listPaymails } from '../names/paymail';
import { getPaymail } from '../names/accountName';
import { pickHandleAlias } from '../names/handlePrompt';
import { getChatAccount } from './chatAccount';
import { WALLET_ADDRESS_KEY_ID, WALLET_ADDRESS_PROTOCOL, walletAddressMessage } from './walletAddress';

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
  // Every name the wallet owns counts, not just the main one (a main b0asex.x still has a plain b0asex), and a
  // failed lookup falls back to the account's cached paymail, so an owned handle is never asked for again.
  handle: async () => {
    const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
    const names = await listPaymails((u, i) => fetch(u, i), publicKey).catch(() => []);
    return pickHandleAlias(names, getPaymail(getChatAccount() ?? undefined));
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
  // Must match bit-sign src/lib/bwallet-address.ts: lets bChatX show this wallet's real balance.
  proveAddress: async (address, handle) => {
    const { signature } = await ctx.wallet.createSignature({
      data: Utils.toArray(walletAddressMessage(address, handle), 'utf8'),
      protocolID: WALLET_ADDRESS_PROTOCOL,
      keyID: WALLET_ADDRESS_KEY_ID,
      counterparty: 'anyone',
    });
    return Utils.toHex(signature);
  },
});
