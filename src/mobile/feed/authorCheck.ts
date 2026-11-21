import { OP, Script, Transaction, Utils } from '@bsv/sdk';
import { AIP_ALGORITHM, AIP_PREFIX, aipMessage, bsmVerifyAddress } from '../twetch/twetchPost';
import { verifyFwetchTx } from './fwetch';
import type { Source } from './sources';
import { planPayment, type PayKind, type PayPlan } from './tip';

/**
 * Feed tips pay the post's author address (tip.ts payDestination). That address comes from an indexer or a
 * platform API (bmap, Twetch, the bChat indexer), which could name anyone (b-Aware row 111, cluster
 * baware:unverified-payee). Before a tip or paid like is built, the post's own transaction is read, checked to hash
 * to its txid, and its AIP signature must recover to the address being paid. Fwetch posts carry their own
 * signature format (fwetch.ts verifyFwetchTx). Anything that cannot be checked is not paid.
 */

export const AUTHOR_UNCHECKED = "Couldn't check this post's signature, so the tip wasn't sent. Try again in a moment.";
export const AUTHOR_NOT_SIGNED =
  "This post isn't signed by the address it would pay, so the tip wasn't sent. Nothing was paid.";

const AIP = Utils.toArray(AIP_PREFIX, 'utf8');
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The pushes after OP_RETURN (a parsed script keeps them as one data blob on the OP_RETURN chunk). */
const returnPushes = (script: Script): number[][] | null => {
  const chunks = script.chunks;
  const ret = chunks.findIndex((c) => c.op === OP.OP_RETURN);
  if (ret < 0) return null;
  const tail = chunks[ret].data?.length ? Script.fromBinary(chunks[ret].data!).chunks : chunks.slice(ret + 1);
  return tail.map((c) => c.data ?? []);
};

/** Does the raw tx `hex` hash to `txid` and carry an AIP signature by `address` over its own data? */
export const aipSignedBy = (hex: string, txid: string, address: string): boolean => {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(hex);
    if (tx.id('hex') !== txid.toLowerCase()) return false;
  } catch {
    return false;
  }
  for (const out of tx.outputs) {
    const pushes = returnPushes(out.lockingScript);
    if (!pushes) continue;
    for (let i = 0; i + 3 < pushes.length; i++) {
      if (!same(pushes[i], AIP)) continue;
      if (Utils.toUTF8(pushes[i + 1]) !== AIP_ALGORITHM || Utils.toUTF8(pushes[i + 2]) !== address) continue;
      const raw = pushes[i + 3];
      // @1sat applyBapAip pushes the 65 compact bytes; Twetch and bmap-era clients push them as base64 text.
      const sig = raw.length === 65 ? Utils.toBase64(raw) : Utils.toUTF8(raw);
      if (bsmVerifyAddress(aipMessage(pushes.slice(0, i)), sig, address)) return true;
    }
  }
  return false;
};

export type FetchHex = (txid: string) => Promise<string>;

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
export const fetchTxHex: FetchHex = async (txid) => {
  const r = await fetch(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`tx ${r.status}`);
  const hex = (await r.text()).trim();
  if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('not a tx');
  return hex;
};

/** txid|address → signed. A mined tx never changes, so only real answers are kept (never network failures). */
const checked = new Map<string, boolean>();

type PostRef = { txid: string; source: Source; author: { address: string } };

/** null when the post's own signature proves `author.address`; otherwise why it is not paid. */
export const checkPostAuthor = async (post: PostRef, fetchHex: FetchHex = fetchTxHex): Promise<string | null> => {
  const key = `${post.txid}|${post.author.address}`;
  let ok = checked.get(key);
  if (ok === undefined) {
    let hex: string;
    try {
      hex = await fetchHex(post.txid);
    } catch {
      return AUTHOR_UNCHECKED;
    }
    ok =
      post.source === 'fwetch'
        ? (await verifyFwetchTx(hex, post.txid)) === post.author.address
        : aipSignedBy(hex, post.txid, post.author.address);
    if (checked.size > 2_000) checked.clear();
    checked.set(key, ok);
  }
  return ok ? null : AUTHOR_NOT_SIGNED;
};

/** planPayment, only after the post's signature proves the address it pays. Throws, never pays, otherwise. */
export const checkedPayment = async (
  kind: PayKind,
  post: PostRef,
  sats: number,
  fetchHex: FetchHex = fetchTxHex,
): Promise<PayPlan> => {
  // Treechat / no address: planPayment's own reason first, without a network read.
  planPayment(kind, post, sats);
  const why = await checkPostAuthor(post, fetchHex);
  if (why) throw new Error(why);
  return planPayment(kind, post, sats);
};
