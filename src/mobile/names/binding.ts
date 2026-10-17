import { ProtoWallet, Utils } from '@bsv/sdk';
import { SIGN_KEY_ID, SIGN_PROTOCOL, signedMessage } from './paymail';

/**
 * Signed name bindings (docs/NAME-BINDINGS.md, owner 17 Oct 2026). A bWalletX name's owner signs
 * "alias -> my identity key, version seq"; the paymail server serves it with the pki answer. Any wallet checks it
 * here without trusting our server: a name quietly repointed in our database has no valid binding for its new key.
 */
export type NameBinding = { alias: string; identityKey?: string; seq: number; timestamp: string; signature: string };
export type BindingStatus = 'signed' | 'unsigned' | 'bad';

export async function checkBinding(alias: string, pubkey: string | undefined, b: unknown): Promise<BindingStatus> {
  if (!b || typeof b !== 'object') return 'unsigned';
  const x = b as Partial<NameBinding>;
  if (!pubkey || !x.signature || !x.timestamp || !Number.isInteger(x.seq)) return 'bad';
  if (String(x.alias).toLowerCase() !== alias.toLowerCase()) return 'bad';
  if (x.identityKey && x.identityKey.toLowerCase() !== pubkey.toLowerCase()) return 'bad';
  try {
    const fields = { alias: alias.toLowerCase(), seq: String(x.seq), identityKey: pubkey, timestamp: x.timestamp };
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(signedMessage('bind', fields), 'utf8'),
      signature: Utils.toArray(x.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: pubkey,
    });
    return valid ? 'signed' : 'bad';
  } catch {
    return 'bad';
  }
}
