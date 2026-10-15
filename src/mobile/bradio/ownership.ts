/**
 * Which podcast NFTs this wallet holds, and a signer for the ownership proof (podcasts.ts fetchOwnedAudio).
 * The NFT's output is locked to a P1SAT-derived key; its customInstructions name the protocolID / keyID
 * (else the 1Sat default: P1SAT, keyID = outpoint). The proof is a DER signature (hex) by that same key
 * (counterparty self), with its compressed public key (hex), so the server can match it to the output.
 * An NFT in an OrdLock listing (tag `ordlock`) isn't P2PKH to that key, so the server refuses it: we don't sign.
 */
import { listOrdinals, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { Utils, type WalletProtocol } from '@bsv/sdk';
import { normOutpoint, PodcastListedError, type OwnerSigner } from './podcasts';

type Out = { outpoint: string; tags?: string[]; customInstructions?: string };

/** Listed for sale: the current outpoint is locked by an OrdLock, not P2PKH to our key. */
export const isListed = (o: Out): boolean => !!o.tags?.some((t) => t === 'ordlock' || t.startsWith('ordlock:'));

export const originOf = (o: Out): string => {
  const t = o.tags?.find((x) => x.startsWith('origin:'));
  return normOutpoint(t ? t.slice(7) : o.outpoint);
};

export const keyOf = (o: Out): { protocolID: WalletProtocol; keyID: string } => {
  try {
    const ci = JSON.parse(o.customInstructions || 'null') as { protocolID?: WalletProtocol; keyID?: string } | null;
    if (ci?.protocolID && typeof ci.keyID === 'string') return { protocolID: ci.protocolID, keyID: ci.keyID };
  } catch {
    /* not JSON */
  }
  return { protocolID: P1SAT_PROTOCOL as WalletProtocol, keyID: o.outpoint.replace('_', '.') };
};

const listAll = async (ctx: OneSatContext): Promise<Out[]> => {
  const out: Out[] = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const r = await listOrdinals.execute(ctx, { limit: 500, offset });
    out.push(...(r.outputs as Out[]));
    if (r.outputs.length < 500) break;
  }
  return out;
};

/** Origins of every ordinal in the wallet (`txid_vout`). Empty on failure. */
export const ownedOrigins = async (ctx: OneSatContext | undefined): Promise<Set<string>> => {
  if (!ctx) return new Set();
  try {
    return new Set((await listAll(ctx)).map(originOf));
  } catch {
    return new Set();
  }
};

/**
 * Signs with the key locking the NFT's current outpoint (origin `origin`): 1Sat P1SAT derivation from that output's
 * customInstructions. createSignature({data}) hashes with sha256 then signs (DER) — what the server verifies.
 * Throws when the wallet doesn't hold it, PodcastListedError when it is listed for sale.
 */
export const ownerSigner =
  (ctx: OneSatContext, origin: string): OwnerSigner =>
  async (message) => {
    const want = normOutpoint(origin);
    const o = (await listAll(ctx)).find((x) => originOf(x) === want);
    if (!o) throw new Error('This podcast NFT is not in your wallet.');
    if (isListed(o)) throw new PodcastListedError();
    const k = keyOf(o);
    const { publicKey } = await ctx.wallet.getPublicKey({ ...k, forSelf: true });
    const { signature } = await ctx.wallet.createSignature({
      data: Utils.toArray(message, 'utf8'),
      ...k,
      counterparty: 'self',
    });
    return { pubKey: publicKey, sig: Utils.toHex(signature) };
  };
