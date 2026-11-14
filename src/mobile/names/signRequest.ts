/**
 * Requests signed for the bWallet paymail server and the Store (site/lib/paymail.js verifySigned): BRC-43 protocol
 * [2,'bwallet paymail'], keyID '1', counterparty 'anyone', over signedMessage(action, fields). Split out of paymail.ts
 * (13 Nov 2026) so a module that only signs doesn't load the paymail client and its build-time config.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Utils } from '@bsv/sdk';

export const SIGN_PROTOCOL: [2, string] = [2, 'bwallet paymail'];
export const SIGN_KEY_ID = '1';

export const signedMessage = (action: string, fields: Record<string, string>) => {
  const keys = Object.keys(fields).sort();
  return ['bwallet-paymail', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
};

/**
 * Actions our paymail server (site/lib/paymail.js verifySigned) checks with the request's own fields, whose signature
 * is not kept as a standing proof: these carry a random nonce, and the server refuses one it has seen (b-Aware
 * 26 Oct 2026, N3-6). 'ord', 'bind' and 'release' signatures are stored and re-checked later over fixed fields, and
 * other services build their own field lists, so those don't get one (the server still refuses an exact replay).
 */
export const NONCE_ACTIONS: ReadonlySet<string> = new Set([
  'register',
  'names-add',
  'names-primary',
  'names-remove',
  'delete',
  'unlink',
  'set-name',
  'inbox',
  'history',
  'ack',
  'apps-get',
  'apps-put',
  'release-cancel',
  'offer-register',
  'offer-receipts',
  'prove',
  'prove-gist',
]);

const newNonce = () => Utils.toHex([...crypto.getRandomValues(new Uint8Array(16))]);

export const signRequest = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  action: string,
  fields: Record<string, string>,
  now = Date.now(),
) => {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const timestamp = now;
  if (NONCE_ACTIONS.has(action) && fields.nonce === undefined) fields = { ...fields, nonce: newNonce() };
  const all = { ...fields, identityKey, timestamp: String(timestamp) };
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(signedMessage(action, all), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
};
