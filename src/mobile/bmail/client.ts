/**
 * bMail over the wallet + message box. BRC-100 calls only (works with any BRC-100 wallet):
 *  - send: BRC-29 postage payment (createAction) + BRC-2 encrypt + messagebox sendMessage, one tap.
 *  - fetch: listMessages('bmail') → skip what this device has → decode → store → check postage (output to me ≥
 *    claimed, one letter per stamp, the network has it, unspent) → internalize. Mail stays on the relay for the user's
 *    other devices; it is cleared after 30 days (fetchMail).
 *  - open: BRC-2 decrypt.
 */
import { MessageBoxClient } from '@bsv/message-box-client';
import { trackOwnAuthFetch } from '../../services/ownBackendKeys';
import { assertNotPaused } from '../config/killSwitch';
import {
  refusedBeforeBroadcast,
  releaseAfterHandoff,
  type ReleaseOpts,
  type UnsentWallet,
} from '../../services/unsentGuard';
import { Beef, P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import {
  BMAIL_BOX,
  BMAIL_PROTOCOL,
  BRC29_PROTOCOL,
  bytesToSealed,
  decodeEnvelope,
  encodeEnvelope,
  newMessageId,
  sealedToBytes,
  stampPrefix,
  type Envelope,
  type Postage,
  type Sealed,
} from './envelope';
import {
  RELAY_CONFIRM_MS,
  RELAY_KEEP_MS,
  addReceived,
  isTrustedSender,
  loadMail,
  loadRelaySeen,
  loadStamps,
  relayKey,
  saveRelaySeen,
  saveStamps,
  stampOutpoint,
  updateMail,
  type Received,
  type RelaySeen,
  type Sent,
} from './store';
import { replyCreditOk } from './route';
import { isPermanentInternalizeError } from '../../services/internalizeBackoff';
import { ARC_ACCEPTED, chainLookups } from '../../services/unsentGuard';
import { wocSpendLookup } from '../../services/spendCheck';
import { deadline } from '../../utils/abortTimeout';
import {
  LetterTooLargeError,
  TOO_LARGE_CONFIRMING,
  TOO_LARGE_TEXT,
  dropPending,
  isRefusal,
  letterKey,
  loadPending,
  putPending,
  relayLimit,
  trimPostageBeef,
  utf8Bytes,
  wocProof,
  type ProofFetcher,
} from './delivery';

/**
 * bMail's own relay (owner, 9 Oct 2026): messagebox.1sat.app refused recipients without a 1Sat account, so bMail
 * runs bitcoin-sv/message-box-server on our server, where any identity key can receive with no sign-up.
 * Override (testing / self-hosting): localStorage 'bwx.bmail.host' or globalThis.__BMAIL_HOST__, https only.
 */
export const BMAIL_DEFAULT_HOST = 'https://messagebox.bwalletx.com';
export const bmailHost = (): string => {
  const pick = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s/]+/.test(v) ? v.replace(/\/+$/, '') : '');
  let stored: string | null = null;
  try {
    stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('bwx.bmail.host');
  } catch {
    stored = null;
  }
  return pick(stored) || pick((globalThis as { __BMAIL_HOST__?: unknown }).__BMAIL_HOST__) || BMAIL_DEFAULT_HOST;
};

const mbox = (wallet: WalletInterface) => {
  const host = bmailHost();
  const client = new MessageBoxClient({ walletClient: wallet, host });
  // Its server is the wallet's own: no site may sign in to it as the user (services/ownBackendKeys.ts). The default
  // host's key is seeded; an override host's counts once this client has connected.
  trackOwnAuthFetch('bmail', (client as unknown as { authFetch?: unknown }).authFetch, host);
  return client;
};

/** One message as the relay lists it (the message box client's PeerMessage, as far as bMail reads it). */
export type RelayMessage = { messageId: string; sender: string; body: unknown; created_at?: unknown };
/** The relay calls bMail's fetch makes (tests pass a fake relay). */
export type MailRelay = { list: () => Promise<RelayMessage[]>; ack: (ids: string[]) => Promise<void> };
/** The relay takes at most this many ids in one acknowledge call; any more wait for the next fetch. */
export const ACK_MAX = 1000;
/** One clearing makes at most this many acknowledge calls (a refused batch is tried again in halves). */
const ACK_CALLS = 24;
/** Ids the message box client refuses to acknowledge (it throws before any request, for the whole batch). */
const ackable = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.trim() === id &&
  new TextEncoder().encode(id).length <= 256 &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f]/.test(id);
/**
 * A stored message as the server keeps it: the body itself, or { message, payment? } around it (the client's
 * parseMessageEnvelope). Only unwrapped here: nothing is decrypted and no payment is taken in.
 */
const plainBody = (body: unknown): unknown => {
  const parse = (x: unknown) => {
    if (typeof x !== 'string') return x;
    try {
      return JSON.parse(x) as unknown;
    } catch {
      return x;
    }
  };
  const outer = parse(body);
  if (outer && typeof outer === 'object' && !Array.isArray(outer) && Object.hasOwn(outer, 'message'))
    return parse((outer as { message: unknown }).message) ?? outer;
  return outer;
};
type RawPages = (host: string, box: string, o: Record<string, never>) => Promise<RelayMessage[]>;
/**
 * bMail's relay over the message box client. Listing reads the box page by page as the client itself does
 * (fetchMessagePages: its authenticated, identity-pinned request) and stops there: the client's listMessages would
 * also try to decrypt every body and take in every message-box payment, for every message, on every call, and
 * bMail's envelopes use neither. Should a later client drop that method, listMessages is used with payments off.
 * No limit is passed (every message is listed; what this device has is skipped by its ledger, see fetchMail).
 */
export const relayOf = (
  wallet: WalletInterface,
  client: MessageBoxClient = mbox(wallet),
  host = bmailHost(),
): MailRelay => ({
  list: async () => {
    const pages = (client as unknown as { fetchMessagePages?: RawPages }).fetchMessagePages;
    const msgs =
      typeof pages === 'function'
        ? await pages.call(client, host, BMAIL_BOX, {})
        : await client.listMessages({ messageBox: BMAIL_BOX, host, acceptPayments: false });
    return msgs.map((m) => ({ ...m, body: plainBody(m.body) }));
  },
  ack: async (ids) => {
    let calls = 0;
    const send = async (batch: string[]): Promise<void> => {
      if (!batch.length || calls++ >= ACK_CALLS) return;
      try {
        await client.acknowledgeMessage({ messageIds: batch, host });
      } catch {
        // One id the relay will not take must not hold up the rest: halves, down to the id itself.
        if (batch.length < 2) return;
        const mid = batch.length >> 1;
        await send(batch.slice(0, mid));
        await send(batch.slice(mid));
      }
    };
    await send([...new Set(ids.filter(ackable))].slice(0, ACK_MAX));
  },
});

export const myKey = async (wallet: WalletInterface) =>
  (await wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();

const rand = () => Utils.toBase64([...crypto.getRandomValues(new Uint8Array(12))]);

/**
 * Sign a BRC-29 postage payment of `sats` to `to`. With `noSend` (the default for bMail sends) the wallet signs it
 * but does not broadcast: sendMail broadcasts only after the relay has accepted the letter, so a refused letter
 * never costs a stamp.
 */
export const payPostage = async (
  wallet: WalletInterface,
  to: string,
  sats: number,
  id: string,
  opts: { noSend?: boolean; bind?: boolean } = {},
): Promise<Postage> => {
  // bMail binds the stamp to its letter: the key it pays is derived from the letter's id (envelope.ts `bound`).
  const derivationPrefix = opts.bind ? stampPrefix(id) : rand();
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
    options: { randomizeOutputs: false, ...(opts.noSend ? { noSend: true } : {}) },
  });
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the postage payment');
  return {
    txid: r.txid,
    sats,
    outputIndex: 0,
    beef: Utils.toHex(r.tx),
    derivationPrefix,
    derivationSuffix,
    ...(opts.bind ? { bound: true as const } : {}),
  };
};

export const ARC_URL = 'https://arc.gorillapool.io/v1/tx';
/** Post a stamp's BEEF to ARC (the sender's fallback broadcast, and the receiver's when nobody has seen the stamp). */
const arcPost = async (beefHex: string, fetchImpl: typeof fetch, signal?: AbortSignal) => {
  const beef = Beef.fromBinary(Utils.toArray(beefHex, 'hex')).toBinary();
  const res = await fetchImpl(ARC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(beef),
    ...(signal ? { signal } : {}),
  });
  const j = (await res.json().catch(() => ({}))) as { txStatus?: string; status?: number; detail?: string };
  return { res, txStatus: String(j.txStatus ?? ''), detail: j.detail };
};

/**
 * Broadcast a postage tx signed with noSend (after the relay accepted the letter). The wallet is asked to send it
 * now (acceptDelayedBroadcast: false; a delayed share waits on a monitor the web wallet may not run, which left
 * the 18 Oct Bureau stamps unbroadcast). If the wallet does not report it sent, the BEEF goes straight to ARC.
 */
export const broadcastPostage = async (
  wallet: WalletInterface,
  postage: Pick<Postage, 'txid' | 'beef'>,
  fetchImpl: typeof fetch = fetch,
): Promise<'wallet' | 'arc'> => {
  try {
    const r = await wallet.createAction({
      description: 'bMail postage',
      options: { sendWith: [postage.txid], acceptDelayedBroadcast: false },
    });
    const mine = r.sendWithResults?.find((x) => x.txid === postage.txid);
    if (mine && mine.status !== 'failed') return 'wallet';
  } catch (e) {
    console.warn('[bMail] wallet postage broadcast failed', e);
  }
  // The fallback sends a stamp signed earlier: the spending pause must hold here too (b-Aware 25 Oct 2026).
  await assertNotPaused('spending');
  const { res, txStatus, detail } = await arcPost(postage.beef, fetchImpl);
  const ok = res.ok && !/REJECTED|DOUBLE_SPEND/i.test(txStatus);
  if (!ok) throw new Error(`Postage broadcast failed: ${detail ?? (txStatus || res.status)}`);
  return 'arc';
};

/** Release a signed-but-never-broadcast stamp so its coins are spendable again. */
export const releasePostage = async (wallet: WalletInterface, txid: string) => {
  try {
    await wallet.abortAction({ reference: txid });
  } catch {
    /* already gone */
  }
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
  /** Postage already paid for this mail on an earlier attempt whose delivery failed: reuse it, do not pay twice. */
  postage?: Postage;
  /** Message id from that earlier attempt (keeps the postage stamp and the envelope id together). */
  id?: string;
  /** Called as soon as the stamp is signed, before delivery, so a caller can keep it if delivery then fails. */
  onPostagePaid?: (postage: Postage, id: string) => void | Promise<void>;
};

export type SendDeps = {
  /** Relay body limit in bytes (default: ask the relay, GET /limits). */
  limit?: number;
  /** Merkle proof lookup for trimming the postage BEEF (default WhatsOnChain; null = no lookup). */
  fetchProof?: ProofFetcher | null;
  /** fetch for the ARC fallback broadcast (tests). */
  broadcastFetch?: typeof fetch;
  /** Delivery (default: the message box client). */
  deliver?: (body: string) => Promise<unknown>;
  /** Chain checks for a guarded release after the relay refused (tests; default WhatsOnChain + 1Sat). */
  unsent?: Omit<ReleaseOpts, 'notBroadcast'>;
};

/**
 * Send one letter. Order (never lose a stamp): sign postage with noSend → trim + size-check the envelope against the
 * relay limit → deliver to the relay → only then broadcast the stamp. A pending record (local) keeps the stamp
 * while this runs; a retry of the same letter (same recipient/subject/body) reuses it instead of paying again.
 */
export const sendMail = async (wallet: WalletInterface, a: SendArgs, deps: SendDeps = {}): Promise<Sent> => {
  const from = await myKey(wallet);
  const host = bmailHost();
  const key = letterKey(a.to, a.sealed.subject, a.sealed.body);
  const prior = a.postage ? undefined : loadPending<Postage>(from).find((p) => p.key === key && p.to === a.to);
  // Reuse the earlier stamp even if the price moved since (e.g. the BSV rate): it is already signed for this letter.
  const reuse = prior;
  const id = a.id ?? reuse?.id ?? newMessageId();
  const { ciphertext } = await wallet.encrypt({
    plaintext: sealedToBytes(a.sealed),
    protocolID: BMAIL_PROTOCOL,
    keyID: id,
    counterparty: a.to,
  });
  let postage = a.postage ?? reuse?.postage;
  let state: 'signed' | 'broadcast' | 'given' = a.postage ? 'given' : (reuse?.state ?? 'signed');
  if (!postage && a.sats > 0) {
    postage = await payPostage(wallet, a.to, a.sats, id, { noSend: true, bind: true });
    state = 'signed';
    putPending(from, { key, id, to: a.to, postage, state, at: Date.now() });
    await a.onPostagePaid?.(postage, id);
  }
  const unbroadcast = state === 'signed' && !!postage;
  // handedOff: the envelope (with the stamp's rawtx) reached the relay; then only a guarded release (unsentGuard).
  const giveUp = async (handedOff?: { cause: unknown }) => {
    if (unbroadcast && postage) {
      if (handedOff)
        await releaseAfterHandoff(wallet as unknown as UnsentWallet, postage.txid, {
          ...deps.unsent,
          notBroadcast: refusedBeforeBroadcast(handedOff.cause) || isRefusal(handedOff.cause),
        });
      else await releasePostage(wallet, postage.txid);
    }
    if (state !== 'given') dropPending(from, key);
  };
  if (postage) {
    try {
      const fetchProof = deps.fetchProof === null ? undefined : (deps.fetchProof ?? wocProof());
      const beef = await trimPostageBeef(postage.beef, fetchProof);
      if (beef !== postage.beef) {
        postage = { ...postage, beef };
        if (state !== 'given') putPending(from, { key, id, to: a.to, postage, state, at: Date.now() });
      }
    } catch (e) {
      console.warn('[bMail] could not trim postage', e);
    }
  }
  const env: Envelope = { t: 'bmail', v: 1, id, from, to: a.to, at: Date.now(), sealed: Utils.toBase64(ciphertext) };
  if (postage) env.postage = postage;
  if (postage && a.replyPaidSats > 0) env.replyPaidSats = a.replyPaidSats;
  if (a.inReplyTo) env.inReplyTo = a.inReplyTo;
  if (a.usesReplyCredit) env.usesReplyCredit = true;
  const body = encodeEnvelope(env);
  const limit = deps.limit ?? (await relayLimit(host));
  const bytes = utf8Bytes(body);
  if (bytes > limit) {
    // The stamp alone is too big (its coins' unconfirmed ancestry): release it if unpaid; keep it if already paid.
    const stampBig = !!postage && utf8Bytes(body) - postage.beef.length < limit;
    if (state !== 'broadcast') await giveUp();
    throw new LetterTooLargeError(stampBig ? TOO_LARGE_CONFIRMING : TOO_LARGE_TEXT, bytes, limit);
  }
  // TODO(bmail pay-to-open): escrow the stamp instead of paying it outright (BMAIL.md §5.3).
  try {
    if (deps.deliver) await deps.deliver(body);
    else await mbox(wallet).sendMessage({ recipient: a.to, messageBox: BMAIL_BOX, body, skipEncryption: true }, host);
  } catch (e) {
    // A refusal (4xx) will not change on retry: release an unpaid stamp. Network/5xx: keep it for the retry.
    if (isRefusal(e) && state !== 'broadcast') await giveUp({ cause: e });
    if (/HTTP 413/.test(String((e as Error)?.message))) throw new LetterTooLargeError(TOO_LARGE_TEXT, bytes, limit);
    throw e;
  }
  if (unbroadcast && postage) {
    try {
      await broadcastPostage(wallet, postage, deps.broadcastFetch);
    } catch (e) {
      // Delivered: the recipient's wallet broadcasts the stamp when it accepts it, so the letter still counts.
      console.warn('[bMail] postage broadcast after delivery failed', e);
    }
  }
  if (state !== 'given') dropPending(from, key);
  return {
    id,
    to: a.to,
    toLabel: a.toLabel,
    at: env.at,
    subject: a.sealed.subject,
    body: a.sealed.body,
    sats: postage?.sats ?? 0,
    replyPaidSats: env.replyPaidSats ?? 0,
    txid: postage?.txid,
    inReplyTo: a.inReplyTo,
    ...(a.sealed.agreement !== undefined ? { agreement: a.sealed.agreement } : {}),
    ...(a.sealed.offer !== undefined ? { offer: a.sealed.offer } : {}),
    ...(a.sealed.ordinal ? { ordinal: a.sealed.ordinal } : {}),
    ...(a.sealed.note !== undefined ? { note: a.sealed.note } : {}),
  };
};

/** What bMail asks the network about a stamp (tests pass a fake). */
export type StampNet = {
  /** The network has this transaction, in a block or in the mempool. False: not known, or nobody could tell. */
  seen: (txid: string) => Promise<boolean>;
  /** Hand the stamp to the network: 'seen' (accepted, or already there), 'refused' (double spend, invalid), 'unclear'. */
  broadcast: (beefHex: string) => Promise<'seen' | 'refused' | 'unclear'>;
  /** Who spent the output ("txid_vout"): a txid, or null when unspent. Throws when it cannot tell. */
  spender: (outpoint: string) => Promise<string | null>;
};
/** A stamp handed to the network gets this long for an answer. */
const BROADCAST_TIMEOUT_MS = 15_000;
/**
 * The network, as the rest of the wallet reads it (services/unsentGuard.ts): seen = WhatsOnChain has the transaction
 * or ARC reports it accepted by the network (SEEN_ON_NETWORK, MINED…); ARC merely holding it is not seen. A stamp
 * nobody has seen is handed to ARC, as the sender's own fallback does: seen when ARC reports it accepted, refused
 * when ARC rejects it (REJECTED, DOUBLE_SPEND…, or its 46x "this transaction is not valid" answers).
 */
export const stampNet = (f: typeof fetch = (...a) => fetch(...a)): StampNet => ({
  seen: async (txid) => (await Promise.all(chainLookups(f).map((look) => look(txid)))).includes('seen'),
  broadcast: async (beefHex) => {
    const d = deadline(BROADCAST_TIMEOUT_MS);
    try {
      const { res, txStatus } = await arcPost(beefHex, f, d.signal);
      if (/REJECTED|DOUBLE_SPEND/i.test(txStatus) || (res.status >= 460 && res.status <= 475)) return 'refused';
      return res.ok && ARC_ACCEPTED.has(txStatus) ? 'seen' : 'unclear';
    } catch {
      return 'unclear';
    } finally {
      d.clear();
    }
  },
  spender: wocSpendLookup(undefined, f),
});

export type StampCheck = { sats: number; note?: string; pending?: boolean };
/** Shown on a letter whose stamp another letter used first. */
export const STAMP_USED = 'This stamp was already used for another letter';
const NOT_CHECKED = 'Postage not checked yet';

/**
 * What the envelope alone tells about its stamp (no wallet, no network): the BEEF holds the claimed transaction, its
 * output is at least the claimed amount, and a bound stamp (envelope.ts `bound`) names this letter. A string says
 * what is wrong for good.
 */
const readStamp = (env: Envelope): { tx: Transaction; sats: number; script: string } | string => {
  const p = env.postage;
  if (!p) return 'No postage';
  let tx: Transaction;
  try {
    tx = Transaction.fromAtomicBEEF(Utils.toArray(p.beef, 'hex'));
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 160) : 'Bad postage';
  }
  if (tx.id('hex') !== p.txid) return 'Postage txid does not match';
  const out = tx.outputs[p.outputIndex];
  if (!out || (out.satoshis ?? 0) < p.sats) return 'Postage output is smaller than claimed';
  if (p.bound && p.derivationPrefix !== stampPrefix(env.id)) return 'This stamp was made for another letter';
  return { tx, sats: out.satoshis ?? 0, script: out.lockingScript.toHex() };
};

/** Do the BEEF's merkle proofs match the block headers the wallet knows? Throws when the wallet cannot say. */
const proofsHold = (wallet: WalletInterface, beefHex: string): Promise<boolean> =>
  Beef.fromBinary(Utils.toArray(beefHex, 'hex')).verify({
    isValidRootForHeight: async (root, height) => {
      const { header } = await wallet.getHeaderForHeight({ height });
      return Utils.toHex(Utils.toArray(header, 'hex').slice(36, 68).reverse()) === root;
    },
    currentHeight: async () => (await wallet.getHeight({})).height,
  });

/**
 * Check the postage and take it in. A stamp counts as paid only when all of this holds, in this order:
 *  1. the envelope's own claims (readStamp), and the output pays the BRC-29 key only I can derive from the sender's;
 *  2. the BEEF is complete (every transaction proven or with its inputs in the BEEF);
 *  3. the network has the transaction (`net.seen`), or takes it when this wallet hands it over (`net.broadcast`).
 *     A stamp that was signed and never sent, or whose coins were spent elsewhere, stops here: nothing is taken in;
 *  4. the output is unspent, and then the wallet takes it in (internalizeAction, which checks the BEEF's proofs).
 *     An output already spent was spent by this account (only its key can), on another device: the letter is paid
 *     and no coin is added here.
 * Returns the verified sats. `pending`: a step could not be done (wallet locked or busy, network or chain lookup
 * down), which says nothing about the stamp; recheckPostage tries again. Anything else at 0 sats is final.
 * `internalize` false (the notifier's peek): step 1 only, read-only.
 */
export const verifyPostage = async (
  wallet: WalletInterface,
  env: Envelope,
  internalize = true,
  net: StampNet = stampNet(),
): Promise<StampCheck> => {
  const p = env.postage;
  if (!p) return { sats: 0 };
  const later = (why: unknown): StampCheck => ({
    sats: 0,
    note: `${NOT_CHECKED}: ${why instanceof Error ? why.message : String(why)}`.slice(0, 160),
    pending: true,
  });
  const stamp = readStamp(env);
  if (typeof stamp === 'string') return { sats: 0, note: stamp };
  try {
    const { publicKey } = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
      counterparty: env.from,
      forSelf: true,
    });
    const want = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
    if (stamp.script !== want) return { sats: 0, note: 'Postage is not paid to you' };
  } catch (e) {
    // The wallet could not derive the key (locked, busy): nothing was learnt about the stamp.
    return later(e);
  }
  if (!internalize) return { sats: stamp.sats };
  if (!Beef.fromBinary(Utils.toArray(p.beef, 'hex')).isValid()) return { sats: 0, note: 'Postage proof is incomplete' };
  try {
    if (!(await net.seen(p.txid))) {
      const sent = await net.broadcast(p.beef);
      // A refusal counts only if the network still does not have it (someone else may have sent it meanwhile).
      if (sent === 'refused' && !(await net.seen(p.txid)))
        return { sats: 0, note: 'The network refused this stamp (already spent, or not valid)' };
      if (sent !== 'seen' && !(await net.seen(p.txid))) return later('the network does not have the stamp yet');
    }
    // Spent already: by this account, on another device. Paid; the coin is not this device's to add.
    if (await net.spender(`${p.txid}_${p.outputIndex}`)) return { sats: stamp.sats };
  } catch (e) {
    return later(e);
  }
  const take = () =>
    wallet.internalizeAction({
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
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    // "…undergoing active changes": device sync wrote this same payment (taken in on another device of this wallet)
    // while the call ran. A second try finds it stored and merges. A payment this wallet already holds is merged by
    // the wallet without an error and without counting it twice, so no error text is read as "paid".
    await take().catch((e) => (/active changes/i.test(message(e)) ? take() : Promise.reject(e)));
  } catch (e) {
    // The wallet holds the transaction as failed/invalid: not good.
    if (isPermanentInternalizeError(e)) return { sats: 0, note: `Postage not accepted: ${message(e)}`.slice(0, 160) };
    // "must be valid AtomicBEEF": a forged proof, or the wallet's chain lookup is down. The block headers tell which.
    if (/valid AtomicBEEF/i.test(message(e)) && !(await proofsHold(wallet, p.beef).catch(() => true)))
      return { sats: 0, note: 'Postage proof is not valid' };
    return later(e);
  }
  return { sats: stamp.sats };
};

/**
 * The time of the newest block the wallet knows (unix ms). A clock nobody can set on this device: it can lag the real
 * time (by hours when blocks are slow or the wallet's headers are behind), which only keeps mail on the relay longer.
 */
const chainTime = async (wallet: WalletInterface): Promise<number> => {
  const { height } = await wallet.getHeight({});
  const { header } = await wallet.getHeaderForHeight({ height });
  const bytes = Utils.toArray(header, 'hex');
  if (bytes.length !== 80) throw new Error('No block header');
  return new Utils.Reader(bytes.slice(68, 72)).readUInt32LE() * 1000;
};

/** Is the wallet still on the account this refresh was started for? */
const sameAccount = (wallet: WalletInterface, me: string) =>
  myKey(wallet).then(
    (k) => k === me,
    () => false,
  );

/** A stamp that could not be checked is tried again at most this often, */
export const RECHECK_EVERY_MS = 10 * 60 * 1000;
/** at most this many times, and for RELAY_KEEP_MS from the first try; then it is unpaid for good. */
export const RECHECK_TRIES = 12;
/** At most this many letters are checked in one refresh, */
export const RECHECK_MAX = 20;
/** and this many of one sender's, so one sender's backlog cannot hold up another sender's letter. */
export const RECHECK_PER_SENDER = 5;

/** The letters to check now: senders take turns (longest-waiting sender first, its longest-waiting letter first). */
const recheckQueue = (received: Received[], now: number): Received[] => {
  const bySender = new Map<string, Received[]>();
  for (const r of received) {
    if (!r.recheck || (r.recheck.tries > 0 && now - r.recheck.last < RECHECK_EVERY_MS)) continue;
    bySender.set(r.from, [...(bySender.get(r.from) ?? []), r]);
  }
  const waited = (r: Received) => r.recheck?.last ?? 0;
  const lines = [...bySender.values()]
    .map((l) => l.sort((a, z) => waited(a) - waited(z)).slice(0, RECHECK_PER_SENDER))
    .sort((a, z) => waited(a[0]) - waited(z[0]));
  const out: Received[] = [];
  for (let turn = 0; turn < RECHECK_PER_SENDER; turn++) for (const l of lines) if (l[turn]) out.push(l[turn]);
  return out.slice(0, RECHECK_MAX);
};

/**
 * Stored letters whose postage is not checked yet (`recheck`; every stamped letter starts so): check from the stored
 * envelope (the relay ledger plays no part) and settle each one. Paid: the stamp is recorded as used by this letter
 * and verifiedSats is set, once, so it routes and shows as any paid letter. Of several letters showing one stamp, the
 * first found paid keeps it and the others are unstamped. Not good, or still unchecked after RECHECK_TRIES tries or RELAY_KEEP_MS: unpaid for good.
 * Still unknown: tried again on a later refresh.
 */
export const recheckPostage = async (
  wallet: WalletInterface,
  me: string,
  now = Date.now(),
  net: StampNet = stampNet(),
): Promise<void> => {
  const settle = (id: string, v: StampCheck) =>
    updateMail(me, (s) => ({
      ...s,
      received: s.received.map((x) => {
        if (x.id !== id || !x.recheck) return x;
        const { recheck, ...rest } = x;
        const tries = (recheck.tries ?? 0) + 1;
        if (v.pending && tries < RECHECK_TRIES)
          return { ...x, verifyNote: v.note, recheck: { first: Math.min(recheck.first, now), last: now, tries } };
        return { ...rest, verifiedSats: v.sats, verifyNote: v.pending ? 'Postage could not be checked' : v.note };
      }),
    }));
  for (const r of loadMail(me).received)
    if (r.recheck && now - Math.min(r.recheck.first, now) >= RELAY_KEEP_MS)
      settle(r.id, { sats: 0, note: 'Postage could not be checked' });
  // One stamp, one letter: a letter whose stamp has paid for another is unstamped, with nothing asked of anyone.
  const usedElsewhere = (r: Received, stamps = loadStamps(me)) =>
    !!r.env.postage && (stamps.get(stampOutpoint(r.env.postage)) ?? r.id) !== r.id;
  const settleUsed = () => {
    const stamps = loadStamps(me);
    for (const r of loadMail(me).received)
      if (r.recheck && usedElsewhere(r, stamps)) settle(r.id, { sats: 0, note: STAMP_USED });
  };
  settleUsed();
  for (const r of recheckQueue(loadMail(me).received, now)) {
    // The wallet may have switched account since the refresh began: its coins and this mail are then not one account's.
    if (!(await sameAccount(wallet, me))) return;
    if (usedElsewhere(r)) continue;
    const v = await verifyPostage(wallet, r.env, true, net);
    if (!(await sameAccount(wallet, me))) return;
    // The stamp is this letter's from here on: recorded before the letter shows as paid.
    if (v.sats > 0 && r.env.postage) saveStamps(me, loadStamps(me).set(stampOutpoint(r.env.postage), r.id));
    settle(r.id, v);
  }
  settleUsed();
};

/** At most this many new letters are taken in by one fetch; the rest wait for the next. */
export const TAKE_MAX = 200;

/**
 * When a message arrived, for the 30 days: the later of the relay's own time for it (`created_at`, set by the server,
 * used when it parses and is not ahead of this device's clock by more than two days) and this device's first sight of
 * it. Taking the later one means a wrong time on either side can only keep a message longer, never clear it early.
 */
const arrivedAt = (first: number, createdAt: unknown, now: number): number => {
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && t <= now + 2 * 24 * 60 * 60 * 1000 ? Math.max(first, t) : first;
};

/**
 * Which new letters to take in now, at most `max`: senders the user deals with first, then stamped letters, then
 * unstamped ones, then blocked senders; within each, senders take turns, each sender's newest first. Where the relay
 * gives no time for a message, a sender's letters are taken from both ends of the listing in turn, so the newest is
 * among the first whichever way the relay lists.
 */
const pickNew = <T extends { env: Envelope; at: number }>(
  cands: T[],
  rank: (env: Envelope) => number,
  max: number,
): T[] => {
  if (cands.length <= max) return cands;
  const out: T[] = [];
  for (const level of [0, 1, 2, 3]) {
    const bySender = new Map<string, T[]>();
    for (const c of cands)
      if (rank(c.env) === level) bySender.set(c.env.from, [...(bySender.get(c.env.from) ?? []), c]);
    const lines = [...bySender.values()].map((l) => {
      if (l.every((c) => Number.isFinite(c.at))) return [...l].sort((a, z) => z.at - a.at);
      const ends: T[] = [];
      for (let i = 0, j = l.length - 1; i <= j; i++, j--) ends.push(...(i === j ? [l[i]] : [l[j], l[i]]));
      return ends;
    });
    for (let turn = 0; lines.some((l) => l[turn]); turn++)
      for (const l of lines) {
        if (l[turn]) out.push(l[turn]);
        if (out.length >= max) return out;
      }
  }
  return out;
};

/**
 * Fetch the mail this device has not dealt with yet. Nothing is cleared from the relay just because this device
 * stored it: the user's other devices fetch the same box. `ack` holds only what is due:
 *  (a) any listed message, stored or refused, that arrived RELAY_KEEP_MS ago (arrivedAt), once two refreshes at
 *      least RELAY_CONFIRM_MS apart have both found it so. A clock that jumps ahead for one refresh, or a first
 *      sight recorded by a clock that was behind, therefore clears nothing at once; a mark made by a clock that has
 *      since gone back is dropped. The envelope's `at` is the sender's claim and plays no part. These are also listed
 *      in `aged` (relay id → when it arrived): syncMail clears them only if the newest block's time agrees;
 *  (b) a letter this device has erased (30 days in the Bin; `ctx.erased`, by relay id).
 * A message that fails the envelope checks is refused, remembered and skipped from then on, and goes by rule (a), so
 * a newer wallet on another device still gets its chance at it. `seen` is the ledger to keep: an entry for every
 * listed message this device has dealt with, so none is ever taken twice.
 *
 * At most TAKE_MAX new letters are taken per fetch (pickNew: the user's own correspondents and stamped letters
 * first); the others stay unlisted in the ledger and are taken by later fetches.
 *
 * Postage: a stamp pays for one letter. A letter showing a stamp that already paid for another (`ctx.stamps`, by
 * outpoint) is unstamped. Any other stamp that reads right is stored as not checked yet (worth nothing so far);
 * recheckPostage, run by syncMail straight after, asks the network and the wallet. Showing a stamp reserves nothing:
 * only the letter it is found to pay for holds it, so a copy of someone's stamp cannot take it from their letter.
 */
export const fetchMail = async (
  ctx: {
    me: string;
    sent: Sent[];
    known: Set<string>;
    creditsUsed?: Set<string>;
    stamps?: ReadonlyMap<string, string>;
    seen?: RelaySeen;
    erased?: ReadonlySet<string>;
    /** Senders the user deals with (contacts, trusted) and senders they blocked: who is taken first, who last. */
    trusted?: (from: string) => boolean;
    blocked?: (from: string) => boolean;
    now?: number;
  },
  relay: MailRelay,
): Promise<{ items: Received[]; ack: string[]; aged: Map<string, number>; seen: RelaySeen }> => {
  const now = ctx.now ?? Date.now();
  const creditsUsed = new Set(ctx.creditsUsed ?? []);
  const known = new Set(ctx.known);
  const msgs = await relay.list();
  const items: Received[] = [];
  const ack: string[] = [];
  const aged = new Map<string, number>();
  const seen: RelaySeen = new Map();
  const cands: { m: RelayMessage; key: string; env: Envelope; at: number }[] = [];
  for (const m of msgs) {
    const key = relayKey(m.messageId);
    const had = ctx.seen?.get(key);
    if (had) {
      // Dealt with on an earlier fetch: nothing is decoded or checked again.
      // A first-seen time ahead of the clock (the clock was wrong then) starts again from now.
      const first = Math.min(had.first, now);
      const arrived = arrivedAt(first, m.created_at, now);
      const old = now - arrived >= RELAY_KEEP_MS;
      const due = !old ? 0 : had.due && had.due <= now ? had.due : now;
      seen.set(key, { first, due });
      if (ctx.erased?.has(m.messageId)) ack.push(m.messageId);
      else if (due && now - due >= RELAY_CONFIRM_MS) {
        ack.push(m.messageId);
        aged.set(m.messageId, arrived);
      }
      continue;
    }
    const env = decodeEnvelope(m.body);
    // Not bMail, or the relay-authenticated sender is not who the envelope claims: refuse it. Or stored already
    // under another relay id (sent twice, or this device lost its ledger). Either way: remembered, not taken.
    if (!env || env.from !== String(m.sender).toLowerCase() || env.to !== ctx.me || known.has(env.id))
      seen.set(key, { first: now, due: 0 });
    else cands.push({ m, key, env, at: typeof m.created_at === 'string' ? Date.parse(m.created_at) : NaN });
  }
  const rank = (env: Envelope) => (ctx.blocked?.(env.from) ? 3 : ctx.trusted?.(env.from) ? 0 : env.postage ? 1 : 2);
  for (const { m, key, env } of pickNew(cands, rank, TAKE_MAX)) {
    seen.set(key, { first: now, due: 0 });
    // The same letter twice in one listing.
    if (known.has(env.id)) continue;
    known.add(env.id);
    let note: string | undefined;
    let unchecked = false;
    if (env.postage) {
      const fault = readStamp(env);
      if (typeof fault === 'string') note = fault;
      else if ((ctx.stamps?.get(stampOutpoint(env.postage)) ?? env.id) !== env.id) note = STAMP_USED;
      else {
        note = NOT_CHECKED;
        unchecked = true;
      }
    }
    // One reply per credit: a credit already used by an earlier letter (stored, or earlier in this batch) is spent.
    const replyCredit = replyCreditOk(env, ctx.sent, creditsUsed);
    if (replyCredit && env.inReplyTo) creditsUsed.add(env.inReplyTo);
    items.push({
      id: env.id,
      from: env.from,
      at: Math.min(env.at, now),
      // Only postage the network has and the wallet took in counts as received money (recheckPostage sets it); a
      // credit is not a payment to me.
      verifiedSats: 0,
      replyCredit,
      env,
      relayId: m.messageId,
      verifyNote: note,
      ...(unchecked ? { recheck: { first: now, last: 0, tries: 0 } } : {}),
    });
  }
  return { items, ack, aged, seen };
};

/**
 * One refresh on this device: fetch, store what is new, remember what the relay listed and which stamps are used,
 * check the stamps not checked yet, then clear from the relay only what fetchMail found due (what is due by age,
 * only when the time of the newest block the wallet knows says so too: chainTime). `me` is the account the
 * refresh was started for: if the wallet is on another account by the time something would be stored, taken in or
 * cleared, the refresh stops there.
 */
export const syncMail = async (
  wallet: WalletInterface,
  me: string,
  relay: MailRelay = relayOf(wallet),
  now = Date.now(),
  net: StampNet = stampNet(),
): Promise<void> => {
  if (!(await sameAccount(wallet, me))) return;
  const s = loadMail(me);
  // Used stamps: the kept record, and every stored letter whose stamp counted (letters from before the record).
  const used = loadStamps(me);
  for (const r of [...s.received].reverse())
    if (r.env.postage && r.verifiedSats > 0 && !used.has(stampOutpoint(r.env.postage)))
      used.set(stampOutpoint(r.env.postage), r.id);
  const { items, ack, aged, seen } = await fetchMail(
    {
      me,
      sent: s.sent,
      known: new Set(s.received.map((r) => r.id)),
      // Credits already spent by a stored letter: one reply per reply-paid credit.
      creditsUsed: new Set(
        s.received.filter((r) => r.replyCredit && r.env.inReplyTo).map((r) => r.env.inReplyTo as string),
      ),
      stamps: used,
      seen: loadRelaySeen(me),
      erased: new Set(s.received.flatMap((r) => (r.erased && r.relayId ? [r.relayId] : []))),
      trusted: (from) => isTrustedSender(s, from),
      blocked: (from) => (s.blocked ?? []).includes(from),
      now,
    },
    relay,
  );
  // The box that was listed is the wallet's current account's: it must still be the one this refresh is for.
  if (!(await sameAccount(wallet, me))) return;
  updateMail(me, (x) => addReceived(x, items));
  // A letter that did not reach the store (storage full) is not remembered, so the next fetch takes it again.
  const have = new Set(loadMail(me).received.map((r) => r.id));
  for (const i of items) if (!have.has(i.id) && i.relayId) seen.delete(relayKey(i.relayId));
  saveRelaySeen(me, seen);
  saveStamps(me, used);
  await recheckPostage(wallet, me, now, net);
  if (!(await sameAccount(wallet, me))) return;
  // The 30 days by this device's clock must also have passed by the chain's: without that answer nothing aged goes.
  const chainNow = aged.size ? await chainTime(wallet).catch(() => undefined) : undefined;
  const due = ack.filter((id) => {
    const arrived = aged.get(id);
    return arrived === undefined || (chainNow !== undefined && chainNow - arrived >= RELAY_KEEP_MS);
  });
  await relay.ack(due).catch(() => undefined);
};

/** The notifier reads at most this many stamps in one peek. */
export const PEEK_CHECKS = 50;
/**
 * Notifier peek (notify/engine.ts): list the bmail box WITHOUT acknowledging or internalizing anything, so the
 * bMail screen still receives every message. Postage is checked read-only (the envelope and the key it pays; the
 * network is not asked, so a notification's stamp is a claim until the letter is fetched). Mail this device already
 * dealt with (`skip`: stored letter ids, and the relay ids of its ledger) is passed over before any check.
 */
export const peekMail = async (
  wallet: WalletInterface,
  me: string,
  skip: { known?: ReadonlySet<string>; seen?: RelaySeen; stamps?: ReadonlyMap<string, string> } = {},
  relay: MailRelay = relayOf(wallet),
): Promise<{ env: Envelope; sats: number }[]> => {
  const msgs = await relay.list();
  const out: { env: Envelope; sats: number }[] = [];
  const shown = new Map(skip.stamps ?? []);
  let checks = 0;
  for (const m of msgs) {
    if (skip.seen?.has(relayKey(m.messageId))) continue;
    const env = decodeEnvelope(m.body);
    if (!env || env.from !== String(m.sender).toLowerCase() || env.to !== me) continue;
    if (skip.known?.has(env.id)) continue;
    // A stamp costs a wallet call to read: PEEK_CHECKS of them a peek; the rest count as unstamped until fetched.
    // One stamp, one letter here too: a stamp that paid for a stored letter, or shown earlier in this peek, is not
    // counted again.
    const claim = env.postage ? stampOutpoint(env.postage) : '';
    const fresh = !!env.postage && (shown.get(claim) ?? env.id) === env.id;
    const sats = fresh && checks++ < PEEK_CHECKS ? (await verifyPostage(wallet, env, false)).sats : 0;
    if (sats > 0) shown.set(claim, env.id);
    out.push({ env, sats });
  }
  return out;
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
