/**
 * Inscribe a user PoWNote exactly as bit-sign rendered it (userNotes.ts), signed with SIGMA, then link the signing
 * key to the bChatX account so /api/bmint/register can see "signed by your wallet".
 *
 * Signing model (no raw key ever leaves the wallet):
 *   @1sat/actions inscribe({ signWithBAP: true }) appends a zeroed SIGMA tape to the inscription output; the common
 *   apply step (applyInscribeSigma) makes a 2-sat noSend anchor output, spends it as vin 0, and seals the tape with
 *   BRC-100 createSignature({ protocolID: [1,'sigma'], keyID: 'identity-N', counterparty: 'self',
 *   hashToDirectlySign: BSM magic hash }). That is a Sigma BSM signature by the BAP signing key, a key the wallet
 *   derives from the identity key (BRC-42). It is NOT the root identity key itself: BRC-100 never signs with the
 *   root key directly. It needs a published BAP identity (Settings › Identity); without one we stop with a message.
 *
 * The 1% bWallet mint fee is added to the inscription transaction only (never to the anchor transaction).
 */
import { BAP_BASKET, BAP_KEY_ID, BAP_PROTOCOL_ID, inscribe, type OneSatContext } from '@1sat/actions';
import { P2PKH, PublicKey, Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { mintFeeAddress } from '../../mint/mint';
import { meterFees } from '../../mint/mintMedia';
import { addressProofMessage } from '../../chat/tokenRooms';
import { BMINT_API, svgToBase64, type Rendered } from './userNotes';

export const NO_BAP_IDENTITY = 'Publish your identity first (Settings › Identity): your note is signed with it.';

/** The current BAP signing key id ("identity-N", N ≥ 1), or null when no identity is published. */
export async function bapSigningKeyId(wallet: WalletInterface): Promise<string | null> {
  const res = await wallet.listOutputs({ basket: BAP_BASKET, tags: ['type:id'], includeTags: true, limit: 100 });
  let max = 0;
  for (const o of res.outputs) {
    const t = o.tags?.find((x) => x.startsWith('seq:'));
    const n = t ? Number.parseInt(t.slice(4), 10) : 0;
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max >= 1 ? `${BAP_KEY_ID}-${max}` : null;
}

/**
 * A context whose wallet adds the mint fee output to the createAction that carries the 1-sat inscription
 * (skipping the Sigma anchor action, which has none). Once only.
 */
export function withNoteFee(ctx: OneSatContext, feeSats: number, address = mintFeeAddress()): OneSatContext {
  if (!address || feeSats <= 0) return ctx;
  let done = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction') {
        return (args: CreateActionArgs, originator?: string) => {
          const outs = args.outputs ?? [];
          if (done || !outs.some((o) => o.satoshis === 1 && hasOrdEnvelope(o.lockingScript)))
            return target.createAction(args, originator);
          done = true;
          const fee = {
            lockingScript: new P2PKH().lock(address).toHex(),
            satoshis: feeSats,
            outputDescription: 'bWallet mint fee',
          };
          return target.createAction({ ...args, outputs: [...outs, fee] }, originator);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/**
 * Send now, never "later": @1sat/actions' Sigma step asks for acceptDelayedBroadcast, which queues the sends for a
 * monitor the web wallet does not run, so the note was signed but never posted (31 Oct 2026, $b0asex's first note).
 * The 2-sat anchor stays noSend and goes out with the note via sendWith.
 */
export function withBroadcastNow(ctx: OneSatContext): OneSatContext {
  const now = <T extends { options?: object }>(args: T): T => ({
    ...args,
    options: { ...(args.options ?? {}), acceptDelayedBroadcast: false },
  });
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction')
        return (args: CreateActionArgs, originator?: string) => target.createAction(now(args), originator);
      if (prop === 'signAction')
        return (args: Parameters<WalletInterface['signAction']>[0], originator?: string) =>
          target.signAction(now(args), originator);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/** 1Sat inscription outputs start with the ord envelope: OP_FALSE OP_IF. */
const hasOrdEnvelope = (hex: string) => /^0063/i.test(hex);

export type MintedNote = { txid: string; origin: string; networkSats: number | null };

/** Inscribe the rendered note (exact SVG + exact MAP) with SIGMA. Output 0 is the inscription. */
export async function inscribeUserNote(ctx: OneSatContext, note: Rendered, feeSats: number): Promise<MintedNote> {
  if (!(await bapSigningKeyId(ctx.wallet as WalletInterface))) throw new Error(NO_BAP_IDENTITY);
  const meter = meterFees(ctx);
  const res = await inscribe.execute(withBroadcastNow(withNoteFee(meter.ctx, feeSats)), {
    base64Content: svgToBase64(note.svg),
    contentType: 'image/svg+xml',
    map: { ...note.map },
    signWithBAP: true,
  });
  if (!res.txid || res.error) throw new Error(res.error || 'Mint failed');
  return { txid: res.txid, origin: `${res.txid}_0`, networkSats: meter.total() };
}

/**
 * Prove the BAP signing key to bit-sign (POST /api/bitsign/wallet/addresses), so its address is one of the handle's
 * linked addresses. The wallet signs a plain text proof with that key; nothing is spent and no key is exported.
 */
export async function proveSigningKey(
  wallet: WalletInterface,
  handle: string,
  token: string,
  f: typeof fetch = fetch,
): Promise<string> {
  const keyID = await bapSigningKeyId(wallet);
  if (!keyID) throw new Error(NO_BAP_IDENTITY);
  const args = { protocolID: BAP_PROTOCOL_ID, keyID, counterparty: 'self' as const };
  const { publicKey } = await wallet.getPublicKey({ ...args, forSelf: true });
  const message = addressProofMessage(handle, Date.now());
  const { signature } = await wallet.createSignature({ ...args, data: Utils.toArray(message, 'utf8') });
  const res = await f(`${BMINT_API}/api/bitsign/wallet/addresses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'omit',
    body: JSON.stringify({ message, proofs: [{ pubkey_hex: publicKey, signature: Utils.toHex(signature) }] }),
  });
  if (!res.ok) throw new Error(`Could not link your signing key (error ${res.status})`);
  return PublicKey.fromString(publicKey).toAddress();
}
