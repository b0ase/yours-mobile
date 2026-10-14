import { P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction } from '@bsv/sdk';
import { OneSatServices } from '@1sat/wallet-browser';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import type { Account } from '../../services/types/chromeStorage.types';
import { decrypt } from '../../utils/crypto';
import { broadcastRaw } from '../pots/potSend';
import { STORE_BUILD } from '../storeBuild';
import {
  candidateKeys,
  httpTwetchClient,
  keyForLink,
  notAcceptedNote,
  registerBody,
  twetchHeaders,
  twetchImageScript,
  twetchPostScript,
  TWETCH_POSTS_PATH,
  verifyTwetchAccount,
  type TwetchClient,
  type TwetchLink,
  type VerifyResult,
} from './twetch';

/**
 * Storage + chain side of "Also on Twetch". Keys are decrypted in memory for one action (as potSend does
 * for pots) and dropped; nothing but the TwetchLink (user id, public key, path, name) is stored.
 */

/** Cross-posting to Twetch is a bWalletX feature; the store edition doesn't post to third-party services. */
export const twetchCrosspostEnabled = (store = STORE_BUILD) => !store;

type AccountKeys = { mnemonic?: string; walletWif?: string; identityWif?: string };

const accountById = (store: ChromeStorageService, id: string) =>
  store.getAllAccounts().find((a) => a.addresses.identityAddress === id) ?? null;

async function accountKeys(store: ChromeStorageService, acct: Account): Promise<AccountKeys> {
  if (!acct.encryptedKeys) throw new Error('This account’s keys aren’t on this device');
  const passKey = await store.getPassKey();
  if (!passKey) throw new Error('Unlock the wallet first');
  return JSON.parse(await decrypt(acct.encryptedKeys, passKey)) as AccountKeys;
}

export const twetchLinkOf = (store: ChromeStorageService, id: string): TwetchLink | null =>
  accountById(store, id)?.twetch ?? null;

/** Look the account's keys up on Twetch; store the link when one verifies. */
export async function linkTwetch(
  store: ChromeStorageService,
  id: string,
  client: TwetchClient = httpTwetchClient(),
): Promise<VerifyResult> {
  const acct = accountById(store, id);
  if (!acct) throw new Error('Account not found');
  const k = await accountKeys(store, acct);
  const res = await verifyTwetchAccount(client, candidateKeys(k.mnemonic, k));
  if (res.ok) await store.updateNested('accounts', { [id]: { twetch: res.link } as unknown as Account });
  return res;
}

export async function unlinkTwetch(store: ChromeStorageService, id: string): Promise<void> {
  await store.updateNested('accounts', { [id]: { twetch: null } as unknown as Account });
}

// ── posting ──────────────────────────────────────────────────────────────────

export type Coin = { txid: string; vout: number; sats: number; rawTx: number[] };

/** Where coins and broadcasting come from (tests pass fakes). */
export interface TwetchChain {
  coins(address: string): Promise<Coin[]>;
  broadcast(rawTx: string): Promise<void>;
}

let services: OneSatServices | null = null;
const svc = () => (services ??= new OneSatServices('main'));

export const oneSatChain: TwetchChain = {
  async coins(address) {
    for await (const ev of svc().owner.getTxos(address, { refresh: true, limit: 1 })) {
      if (ev.type === 'done' || ev.type === 'error') break;
    }
    const utxos = (await svc().txo.search(`own:${address}`, { unspent: true, sats: true, limit: 0 })) ?? [];
    const out: Coin[] = [];
    for (const u of utxos.sort((a, b) => (b.satoshis ?? 0) - (a.satoshis ?? 0)).slice(0, 8)) {
      const [txid, vout] = u.outpoint.split(/[._]/);
      const sats = u.satoshis ?? 0;
      if (!txid || !Number.isFinite(+vout) || sats <= 1) continue; // never spend 1-sat outputs (ordinals)
      const raw = await svc().beef.getRawTx(txid);
      if (raw.length) out.push({ txid, vout: parseInt(vout, 10), sats, rawTx: [...raw] });
    }
    return out;
  },
  broadcast: broadcastRaw,
};

export type TwetchPostInput = {
  text: string;
  image?: { bytes: number[]; mime: string } | null;
  /** Replying to a Twetch post: its txid (MAP reply) and Twetch id (replyPostId). */
  reply?: { txid: string; twetchId?: number | null } | null;
};

/** Build + sign the Twetch post tx paid from the Twetch key's own address. Pure apart from `coins`. */
export async function buildTwetchTx(
  key: PrivateKey,
  post: TwetchPostInput,
  coins: Coin[],
  satsPerKb: number,
): Promise<{ rawTx: string; txid: string; fee: number }> {
  const from = key.toPublicKey().toAddress();
  const tx = new Transaction();
  tx.addOutput({ lockingScript: twetchPostScript(post.text, key, post.reply?.txid ?? null), satoshis: 0 });
  if (post.image) tx.addOutput({ lockingScript: twetchImageScript(post.image.bytes, post.image.mime), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(from), change: true });
  const imageBytes = post.image?.bytes.length ?? 0;
  const need = Math.ceil(((600 + imageBytes + post.text.length) * satsPerKb) / 1000) + 2;
  let added = 0;
  for (const c of coins) {
    tx.addInput({
      sourceTransaction: Transaction.fromBinary(c.rawTx),
      sourceOutputIndex: c.vout,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
    added += c.sats;
    if (added >= need + 200) break;
  }
  if (added < need)
    throw new Error(`Your Twetch address ${from} needs a little BSV to pay for the post (about ${need} sats).`);
  await tx.fee(new SatoshisPerKilobyte(satsPerKb));
  await tx.sign();
  const change = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0);
  return { rawTx: tx.toHex(), txid: tx.id('hex'), fee: added - change };
}

export type TwetchPostResult =
  | { status: 'posted'; txid: string; twetchId: number | null }
  /** On chain, but Twetch's API refused to list it. Not retried: the tx is already out. */
  | { status: 'not-accepted'; txid: string; note: string }
  /** Nothing was broadcast (no coins, key mismatch, network down…). */
  | { status: 'failed'; note: string };

/**
 * Sign + broadcast + register one Twetch post for `id` (the account the post is made as). Never throws:
 * the bChat post already succeeded, so a Twetch problem becomes a note, never a lost post.
 */
export async function postToTwetch(
  store: ChromeStorageService,
  id: string,
  post: TwetchPostInput,
  deps: { client?: TwetchClient; chain?: TwetchChain; now?: () => number } = {},
): Promise<TwetchPostResult> {
  const client = deps.client ?? httpTwetchClient();
  const chain = deps.chain ?? oneSatChain;
  const now = deps.now ?? Date.now;
  let built: { rawTx: string; txid: string; fee: number };
  let key: PrivateKey;
  let link: TwetchLink;
  try {
    const acct = accountById(store, id);
    if (!acct?.twetch) throw new Error('This account isn’t linked to Twetch');
    link = acct.twetch;
    const k = await accountKeys(store, acct);
    key = keyForLink(link, k.mnemonic, k);
    const coins = await chain.coins(key.toPublicKey().toAddress());
    built = await buildTwetchTx(key, post, coins, store.getCustomFeeRate());
    await chain.broadcast(built.rawTx);
  } catch (e) {
    return { status: 'failed', note: `Posted; not sent to Twetch (${e instanceof Error ? e.message : String(e)})` };
  }
  try {
    const body = registerBody({
      userId: link.userId,
      text: post.text,
      rawTx: built.rawTx,
      paidSats: built.fee,
      replyPostId: post.reply?.twetchId ?? null,
    });
    const r = await client.registerPost(twetchHeaders(key, link.userId, 'POST', TWETCH_POSTS_PATH, body, now()), body);
    if (r.ok) return { status: 'posted', txid: built.txid, twetchId: r.id };
    return { status: 'not-accepted', txid: built.txid, note: notAcceptedNote(r.reason) };
  } catch (e) {
    return {
      status: 'not-accepted',
      txid: built.txid,
      note: notAcceptedNote(e instanceof Error ? e.message : String(e)),
    };
  }
}
