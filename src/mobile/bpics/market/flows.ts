/**
 * bPics market flows: list a photo (one mint tx, one approval), buy one, claim chain photos. Each takes its
 * dependencies so flows.test.ts runs them against mocks; the screens pass the real wallet, mintMedia and client.
 * Nothing here broadcasts on its own: every spend goes through the wallet's createAction / sendBsv approval.
 */
import { Utils } from '@bsv/sdk';
import type { MintMediaInput, MintMediaResult } from '../../mint/mintMedia';
import { deriveContentKey, newNonce, openPhoto, openRelease, sealPhoto, wrapForEscrow } from './crypto';
import {
  SEALED_CONTENT_TYPE,
  SEALED_MAP,
  buildPhotoMap,
  claimMessage,
  purchaseRequests,
  validatePhoto,
  type MarketItem,
  type PhotoForm,
} from './listing';
import type { BpicsClient } from './api';

type KeyWallet = Parameters<typeof deriveContentKey>[0] & Parameters<typeof wrapForEscrow>[0];

export type ListDeps = {
  wallet: KeyWallet;
  mint: (m: MintMediaInput) => Promise<MintMediaResult>;
  client: Pick<BpicsClient, 'escrowKey' | 'register'>;
};
export type ListInput = {
  form: PhotoForm;
  /** The reduced, watermarked public preview (preview.ts), JPEG. */
  previewBase64: string;
  /** The original file's bytes, sealed before minting. */
  full: Uint8Array;
  who: { pay: string; paymail: string; idKey: string };
  feeSats: number;
};
export type Listed = { itemId: string; txid: string; registered: boolean; note: string | null };

/** Seal → one mint (preview vout 0 + sealed vout 1) → wrap the key to the escrow → register for review. */
export async function listPhoto(d: ListDeps, x: ListInput): Promise<Listed> {
  const bad = validatePhoto(x.form, x.full.length);
  if (bad) throw new Error(bad);
  const nonce = newNonce();
  const key = await deriveContentKey(d.wallet, nonce);
  const sealed = await sealPhoto(key, x.full);
  const minted = await d.mint({
    base64Content: x.previewBase64,
    contentType: 'image/jpeg',
    title: x.form.title.trim(),
    description: '',
    collection: { kind: 'none' },
    feeSats: x.feeSats,
    map: buildPhotoMap(x.form, x.who, nonce),
    poster: { base64Content: Utils.toBase64(Array.from(sealed)), contentType: SEALED_CONTENT_TYPE, map: SEALED_MAP },
  });
  const itemId = minted.outpoint;
  // The photo is on chain and yours either way; registration only puts it in the review queue.
  try {
    const escrowKey = await d.client.escrowKey();
    if (!escrowKey) return { itemId, txid: minted.txid, registered: false, note: 'bPics sales are not open yet.' };
    await d.client.register(itemId, await wrapForEscrow(d.wallet, key, itemId, escrowKey));
    return { itemId, txid: minted.txid, registered: true, note: null };
  } catch (e) {
    return {
      itemId,
      txid: minted.txid,
      registered: false,
      note: e instanceof Error ? e.message : 'Could not list it yet.',
    };
  }
}

export type BuyDeps = {
  wallet: Parameters<typeof openRelease>[0];
  identityKey: string;
  /** sendBsv.execute with the purchase requests: one approval sheet. Returns the txid. */
  pay: (requests: ReturnType<typeof purchaseRequests>) => Promise<string>;
  client: Pick<BpicsClient, 'unlock'>;
  fetchSealed: (outpoint: string) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
};

/** Pay the photographer, wait for bit-sign to see it, open the key, decrypt the full photo. */
export async function buyPhoto(d: BuyDeps, item: MarketItem, opts: { retries?: number } = {}) {
  if (!item.payAddress || !item.priceSats) throw new Error('This photo is not for sale.');
  const txid = await d.pay(
    purchaseRequests({ id: item.id, pay_address: item.payAddress, price_sats: item.priceSats }, d.identityKey),
  );
  const photo = await unlockPhoto(d, item, txid, opts);
  return { txid, photo };
}

/** Fetch the key for a purchase already paid (retry until bit-sign sees the tx), then open the photo. */
export async function unlockPhoto(
  d: Omit<BuyDeps, 'pay' | 'identityKey'>,
  item: MarketItem,
  txid: string,
  opts: { retries?: number } = {},
) {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let got: { wrapped: string; escrowKey: string } | null = null;
  for (let i = 0; i <= (opts.retries ?? 6) && !got; i++) {
    if (i) await sleep(5_000);
    got = await d.client.unlock(item.id, txid);
  }
  if (!got) throw new Error('Paid. The photo unlocks once the payment is seen: open it again from Bought in a minute.');
  const key = await openRelease(d.wallet, got.wrapped, item.id, got.escrowKey);
  const sealedOutpoint = `${item.id.slice(0, 64)}_1`;
  return openPhoto(key, await d.fetchSealed(sealedOutpoint));
}

/** The photographer opens their own full-resolution photo from chain: no server (key from the seed). */
export async function openOwnPhoto(wallet: KeyWallet, nonceHex: string, sealed: Uint8Array) {
  return openPhoto(await deriveContentKey(wallet, nonceHex), sealed);
}

export type ClaimDeps = {
  identityKey: string;
  sign: (address: string, message: string) => Promise<string>;
  client: Pick<BpicsClient, 'claim'>;
  now?: () => Date;
};

/** Prove the posting address (BSM signature by its key, bound to this identity) and list its photos. */
export async function claimChainPhotos(d: ClaimDeps, address: string, origins: string[]) {
  const issuedAt = (d.now?.() ?? new Date()).toISOString();
  const signature = await d.sign(address, claimMessage(address, d.identityKey, issuedAt));
  const r = await d.client.claim({ address, issued_at: issuedAt, signature, origins });
  return { listed: r?.listed ?? [], refused: r?.refused ?? [] };
}
