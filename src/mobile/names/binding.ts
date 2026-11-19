import { ProtoWallet, Utils } from '@bsv/sdk';
import { SIGN_KEY_ID, SIGN_PROTOCOL, signedMessage } from './paymail';

/**
 * Signed name bindings (docs/NAME-BINDINGS.md, owner 17 Oct 2026). A bWalletX name's owner signs
 * "alias -> my identity key, version seq"; the paymail server serves it with the pki answer. Any wallet checks it
 * here without trusting our server: a name quietly repointed in our database has no valid binding for its new key.
 */
export type NameBinding = { alias: string; identityKey?: string; seq: number; timestamp: string; signature: string };
/**
 * 'mismatch': the host answered with ANOTHER name's binding and no forward record (28 Oct 2026: boase@ served as
 * b0asex@). Not proof of tampering, but nothing says the owner of the typed name chose that wallet: never paid.
 */
export type BindingStatus = 'signed' | 'unsigned' | 'bad' | 'changed' | 'mismatch';
type Handover = { from?: string; releaseSignature?: string; releaseTimestamp?: string };

const verifyBy = async (key: string, action: string, fields: Record<string, string>, sig: string) => {
  const { valid } = await new ProtoWallet('anyone').verifySignature({
    data: Utils.toArray(signedMessage(action, fields), 'utf8'),
    signature: Utils.toArray(sig, 'hex'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: key,
  });
  return valid;
};

/** The old owner's signed release that a handed-over name carries: "alias -> this key, seq". */
export async function checkRelease(alias: string, pubkey: string, seq: number, h: Handover | undefined) {
  if (!h?.from || !h.releaseSignature || !h.releaseTimestamp) return false;
  try {
    const fields = {
      alias: alias.toLowerCase(),
      to: pubkey,
      seq: String(seq),
      identityKey: h.from,
      timestamp: h.releaseTimestamp,
    };
    return await verifyBy(h.from, 'release', fields, h.releaseSignature);
  } catch {
    return false;
  }
}

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
    if (!valid) return 'bad';
    // A handed-over name carries its old owner's release: it must check out too.
    const h = (b as { handover?: Handover }).handover;
    if (h && !(await checkRelease(alias, pubkey, x.seq as number, h))) return 'bad';
    return 'signed';
  } catch {
    return 'bad';
  }
}

/**
 * A forward the typed name's owner signed (b-Aware 312, 18 Nov 2026): "from -> to, until expiresAt". The signer is the
 * key bound to the TYPED name, shown by that name's own signed binding (`fromBinding`) riding with the forward, so a
 * host can't make one up and an attacker's own key can't speak for someone else's name. Returns the target alias only
 * when all of it checks out and it hasn't expired; anything else is no forward.
 */
export async function checkForward(
  alias: string,
  fw: unknown,
  shape: (alias: string, fw: unknown) => string | undefined,
  now = Date.now(),
): Promise<string | undefined> {
  const to = shape(alias, fw);
  if (!to) return undefined;
  const f = fw as {
    from?: unknown;
    expiresAt?: unknown;
    identityKey?: unknown;
    timestamp?: unknown;
    signature?: unknown;
    fromBinding?: unknown;
  };
  const key = typeof f.identityKey === 'string' ? f.identityKey : '';
  if (!key || typeof f.signature !== 'string' || !f.signature || !['string', 'number'].includes(typeof f.timestamp))
    return undefined;
  if (f.expiresAt !== null && f.expiresAt !== undefined) {
    const at = typeof f.expiresAt === 'number' ? f.expiresAt : Date.parse(String(f.expiresAt));
    if (!Number.isFinite(at) || at <= now) return undefined;
  }
  try {
    // The signer must be the key the typed name is bound to, and not a key change this wallet hasn't accepted.
    const binding = f.fromBinding as { handover?: Handover } | undefined;
    if ((await checkBinding(alias, key, binding)) !== 'signed') return undefined;
    if (keyChange(alias, key, 'signed', binding?.handover?.from) !== 'signed') return undefined;
    const fields = {
      from: String(f.from).split('@')[0].toLowerCase(),
      to,
      expiresAt: f.expiresAt === null || f.expiresAt === undefined ? '' : String(f.expiresAt),
      identityKey: key,
      timestamp: String(f.timestamp),
    };
    return (await verifyBy(key, 'forward', fields, f.signature)) ? to : undefined;
  } catch {
    return undefined;
  }
}

const SEEN_KEY = 'bwallet.names.seenKeys';
const readSeen = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
/** Remember this key for the name: when the payer confirms a payment to it, or deliberately trusts a new key. */
export const trustCurrentKey = (alias: string, key: string) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [alias.toLowerCase()]: key.toLowerCase() }));
  } catch {
    /* private mode: nothing remembered */
  }
};

/**
 * BRC-169 4.4: never silently accept a new key for a name this wallet has paid before. A change is fine only
 * with a valid two-party handover from the key we knew; otherwise it's 'changed' and Send stops.
 */
export function keyChange(alias: string, pubkey: string, status: BindingStatus, handoverFrom?: string): BindingStatus {
  const a = alias.toLowerCase();
  const key = pubkey.toLowerCase();
  const seen = readSeen()[a];
  if (seen && seen !== key && !(status === 'signed' && handoverFrom?.toLowerCase() === seen)) return 'changed';
  return status;
}
