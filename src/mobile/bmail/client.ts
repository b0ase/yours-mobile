/**
 * bMail over the wallet + message box. BRC-100 calls only (works with any BRC-100 wallet):
 *  - send: BRC-29 postage payment (createAction) + BRC-2 encrypt + messagebox sendMessage, one tap.
 *  - fetch: listMessages('bmail') → decode → verify postage (output to me ≥ claimed) → internalize → store → ack.
 *  - open: BRC-2 decrypt.
 */
import { MessageBoxClient } from '@bsv/message-box-client';
import { P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { MESSAGEBOX_URL } from '../../utils/constants';
import {
  BMAIL_BOX,
  BMAIL_PROTOCOL,
  BRC29_PROTOCOL,
  bytesToSealed,
  decodeEnvelope,
  encodeEnvelope,
  newMessageId,
  sealedToBytes,
  type Envelope,
  type Postage,
  type Sealed,
} from './envelope';
import type { Received, Sent } from './store';

const mbox = (wallet: WalletInterface) => new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_URL });

export const myKey = async (wallet: WalletInterface) =>
  (await wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();

const rand = () => Utils.toBase64([...crypto.getRandomValues(new Uint8Array(12))]);

/** Pay `sats` to `to` as a BRC-29 wallet payment; returns the envelope's postage record. */
export const payPostage = async (wallet: WalletInterface, to: string, sats: number, id: string): Promise<Postage> => {
  const derivationPrefix = rand();
  const derivationSuffix = rand();
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: to,
  });
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
  const r = await wallet.createAction({
    description: 'bMail postage',
    outputs: [{ lockingScript, satoshis: sats, outputDescription: `bMail stamp ${id.slice(0, 8)}` }],
    options: { randomizeOutputs: false },
  });
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the postage payment');
  return {
    txid: r.txid,
    sats,
    outputIndex: 0,
    beef: Utils.toHex(r.tx),
    derivationPrefix,
    derivationSuffix,
  };
};

export type SendArgs = {
  to: string;
  toLabel: string;
  sealed: Sealed;
  /** Total postage (stamp + reply-paid credit). 0 = unstamped. */
  sats: number;
  replyPaidSats: number;
  inReplyTo?: string;
  usesReplyCredit?: boolean;
};

export const sendMail = async (wallet: WalletInterface, a: SendArgs): Promise<Sent> => {
  const from = await myKey(wallet);
  const id = newMessageId();
  const { ciphertext } = await wallet.encrypt({
    plaintext: sealedToBytes(a.sealed),
    protocolID: BMAIL_PROTOCOL,
    keyID: id,
    counterparty: a.to,
  });
  const postage = a.sats > 0 ? await payPostage(wallet, a.to, a.sats, id) : undefined;
  const env: Envelope = { t: 'bmail', v: 1, id, from, to: a.to, at: Date.now(), sealed: Utils.toBase64(ciphertext) };
  if (postage) env.postage = postage;
  if (postage && a.replyPaidSats > 0) env.replyPaidSats = a.replyPaidSats;
  if (a.inReplyTo) env.inReplyTo = a.inReplyTo;
  if (a.usesReplyCredit) env.usesReplyCredit = true;
  // TODO(bmail pay-to-open): escrow the stamp instead of paying it outright (BMAIL.md §5.3).
  await mbox(wallet).sendMessage(
    { recipient: a.to, messageBox: BMAIL_BOX, body: encodeEnvelope(env), skipEncryption: true },
    MESSAGEBOX_URL,
  );
  return {
    id,
    to: a.to,
    toLabel: a.toLabel,
    at: env.at,
    subject: a.sealed.subject,
    body: a.sealed.body,
    sats: a.sats,
    replyPaidSats: env.replyPaidSats ?? 0,
    txid: postage?.txid,
    inReplyTo: a.inReplyTo,
  };
};

/**
 * Check the postage: the BEEF's tx has the claimed txid, and its output pays ≥ claimed sats to the BRC-29 key
 * only I can derive from the sender's key. Then internalize it (the wallet validates and keeps the coins).
 * Returns verified sats (0 when anything fails).
 */
export const verifyPostage = async (
  wallet: WalletInterface,
  env: Envelope,
): Promise<{ sats: number; note?: string }> => {
  const p = env.postage;
  if (!p) return { sats: 0 };
  try {
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(p.beef, 'hex'));
    if (tx.id('hex') !== p.txid) return { sats: 0, note: 'Postage txid does not match' };
    const out = tx.outputs[p.outputIndex];
    if (!out || (out.satoshis ?? 0) < p.sats) return { sats: 0, note: 'Postage output is smaller than claimed' };
    const { publicKey } = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
      counterparty: env.from,
      forSelf: true,
    });
    const want = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
    if (out.lockingScript.toHex() !== want) return { sats: 0, note: 'Postage is not paid to you' };
    try {
      await wallet.internalizeAction({
        tx: Utils.toArray(p.beef, 'hex'),
        outputs: [
          {
            outputIndex: p.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: p.derivationPrefix,
              derivationSuffix: p.derivationSuffix,
              senderIdentityKey: env.from,
            },
          },
        ],
        description: 'bMail postage received',
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // Already internalized on an earlier fetch is fine; anything else means the payment is not good.
      if (!/already|duplicate|exists/i.test(m)) return { sats: 0, note: `Postage not accepted: ${m}`.slice(0, 160) };
    }
    return { sats: out.satoshis ?? 0 };
  } catch (e) {
    return { sats: 0, note: e instanceof Error ? e.message.slice(0, 160) : 'Bad postage' };
  }
};

/** Fetch new mail, verify postage, return items to store plus relay ids to acknowledge afterwards. */
export const fetchMail = async (
  wallet: WalletInterface,
  ctx: { me: string; sent: Sent[]; known: Set<string> },
): Promise<{ items: Received[]; ack: string[] }> => {
  const client = mbox(wallet);
  const msgs = await client.listMessages({ messageBox: BMAIL_BOX, host: MESSAGEBOX_URL });
  const items: Received[] = [];
  const ack: string[] = [];
  for (const m of msgs) {
    const env = decodeEnvelope(m.body);
    // Not bMail, or the relay-authenticated sender is not who the envelope claims: drop it.
    if (!env || env.from !== String(m.sender).toLowerCase() || env.to !== ctx.me) {
      ack.push(m.messageId);
      continue;
    }
    if (ctx.known.has(env.id)) {
      ack.push(m.messageId);
      continue;
    }
    const v = await verifyPostage(wallet, env);
    const mine = env.inReplyTo ? ctx.sent.find((s) => s.id === env.inReplyTo && s.to === env.from) : undefined;
    const replyCredit = !!(env.usesReplyCredit && mine && mine.replyPaidSats > 0);
    items.push({
      id: env.id,
      from: env.from,
      at: Math.min(env.at, Date.now()),
      verifiedSats: replyCredit ? Math.max(v.sats, mine?.replyPaidSats ?? 0) : v.sats,
      replyCredit,
      env,
      relayId: m.messageId,
      verifyNote: v.note,
    });
    ack.push(m.messageId);
  }
  return { items, ack };
};

export const acknowledge = async (wallet: WalletInterface, ids: string[]) => {
  if (ids.length) await mbox(wallet).acknowledgeMessage({ messageIds: ids, host: MESSAGEBOX_URL });
};

export const openMail = async (wallet: WalletInterface, env: Envelope): Promise<Sealed> => {
  const { plaintext } = await wallet.decrypt({
    ciphertext: Utils.toArray(env.sealed, 'base64'),
    protocolID: BMAIL_PROTOCOL,
    keyID: env.id,
    counterparty: env.from,
  });
  // TODO(bmail receipts): for Certified / pay-to-open mail, sign + broadcast an open receipt here (BMAIL.md §5.2).
  return bytesToSealed(plaintext);
};
