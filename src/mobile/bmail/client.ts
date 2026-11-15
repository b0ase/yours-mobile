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
import { Beef, Hash, P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
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
  isWaiting,
  isTrustedSender,
  loadMail,
  loadRelaySeen,
  relayKey,
  saveRelaySeen,
  stampOutpoint,
  updateMail,
  usedStamps,
  type Received,
  type RelaySeen,
  type Sent,
} from './store';
import { replyCreditOk } from './route';
import { isPermanentInternalizeError } from '../../services/internalizeBackoff';
import { ARC_ACCEPTED, LOOKUP_TIMEOUT_MS, releaseLookups } from '../../services/unsentGuard';
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

/** What a network lookup says of a transaction: it has it, it does not, or it could not tell. */
export type Sighting = 'seen' | 'missing' | 'unclear';
/** What bMail asks the network about a stamp (tests pass a fake). */
export type StampNet = {
  /**
   * Does the network have this transaction (in a block or in the mempool)? 'missing' only when every lookup answered
   * and none has it; 'unclear' when one could not tell. (true and false are read as 'seen' and 'missing'.)
   */
  seen: (txid: string) => Promise<Sighting | boolean>;
  /** Hand the stamp to the network: 'seen' (accepted, or already there), 'refused' (double spend, invalid), 'unclear'. */
  broadcast: (beefHex: string) => Promise<'seen' | 'refused' | 'unclear'>;
  /** Who spent the output ("txid_vout"): a txid, or null when unspent. Throws when it cannot tell. */
  spender: (outpoint: string) => Promise<string | null>;
  /**
   * Is the transaction in a block yet? Asked only for a stamp that arrived unconfirmed (settleConfirmations). A
   * network without this answer is taken at its word once it has seen the stamp.
   */
  status?: (txid: string) => Promise<StampStatus>;
};
export type StampStatus = 'confirmed' | 'mempool' | 'missing' | 'unclear';
/** A stamp handed to the network gets this long for an answer. */
const BROADCAST_TIMEOUT_MS = 15_000;
/**
 * The network, as the rest of the wallet reads it (services/unsentGuard.ts): seen = WhatsOnChain has the transaction
 * or ARC reports it accepted by the network (SEEN_ON_NETWORK, MINED…); ARC merely holding it is not seen. Missing =
 * WhatsOnChain answers 404 and ARC has no record of it or refused it; a lookup that fails or is rate-limited makes
 * the answer unclear. A stamp nobody has seen is handed to ARC, as the sender's own fallback does: seen when ARC
 * reports it accepted, refused when ARC rejects it (REJECTED, DOUBLE_SPEND…, or its 46x "not valid" answers).
 */
export const stampNet = (f: typeof fetch = (...a) => fetch(...a)): StampNet => ({
  seen: async (txid) => {
    const said = await Promise.all(releaseLookups(f).map((look) => look(txid)));
    return said.includes('seen') ? 'seen' : said.every((s) => s === 'missing') ? 'missing' : 'unclear';
  },
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
  // WhatsOnChain's own record of the transaction: 404 missing; in a block when it reports confirmations or a block.
  status: async (txid) => {
    const d = deadline(LOOKUP_TIMEOUT_MS);
    try {
      const r = await f(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`, { signal: d.signal });
      if (r.status === 404) return 'missing';
      if (!r.ok) return 'unclear';
      const j = (await r.json().catch(() => null)) as { confirmations?: unknown; blockheight?: unknown } | null;
      if (!j) return 'unclear';
      return Number(j.confirmations) > 0 || Number(j.blockheight) > 0 ? 'confirmed' : 'mempool';
    } catch {
      return 'unclear';
    } finally {
      d.clear();
    }
  },
});

/**
 * The answer of one postage check.
 *  - sats > 0: paid. `fresh`: this very check took the coin into the wallet (it was not there before). `notes`: what
 *    else the account's record says of this stamp (noteStamp). `confirming`: the stamp is not in a block yet.
 *  - `pending`: nothing was learnt, or what was learnt may still change; recheckPostage tries again. `answered`: the
 *    wallet and the network did answer (the try counts towards giving up); without it they could not be reached.
 *  - `confirm`: unpaid, on an answer that one look does not settle (the key did not match, the network refused it):
 *    final only when a later check says the same.
 *  - none of these, at 0 sats: unpaid for good.
 */
export type StampCheck = {
  sats: number;
  note?: string;
  pending?: boolean;
  answered?: boolean;
  confirm?: boolean;
  fresh?: boolean;
  notes?: string[];
  confirming?: boolean;
};
/** Shown on a letter whose stamp another letter used first. */
export const STAMP_USED = 'This stamp was already used for another letter';
/** Shown when the wallet held the stamp's coin before this letter, with no record of what it paid for. */
export const STAMP_HELD = 'This payment was already in your wallet before this letter';
/** Shown while a spent stamp waits for the account's own record of it (another device took it in). */
export const STAMP_NO_RECORD = 'Postage not checked yet: this wallet has no record of the stamp so far';
/** Shown when a stamp that arrived unconfirmed is no longer on the network: the letter is checked again from scratch. */
export const STAMP_DROPPED = 'Postage not checked yet: the network no longer has this stamp';
const NOT_CHECKED = 'Postage not checked yet';
const GAVE_UP = 'Postage could not be checked';

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

const later = (why: unknown, answered = false): StampCheck => ({
  sats: 0,
  note: `${NOT_CHECKED}: ${why instanceof Error ? why.message : String(why)}`.slice(0, 160),
  pending: true,
  ...(answered ? { answered } : {}),
});

/**
 * What the wallet alone can tell of a stamp, no network: the envelope's own claims (readStamp), the output pays the
 * BRC-29 key only this account can derive from the sender's, and the BEEF is complete (every transaction proven or
 * with its inputs in the BEEF), and a stamp not yet in a block is at least a signed transaction. A key that does not
 * match is `confirm`: the wallet may have been on another account for that one call. `confirming`: the BEEF carries
 * no proof for the stamp itself.
 */
const stampPaysMe = async (wallet: WalletInterface, env: Envelope): Promise<StampCheck> => {
  const p = env.postage;
  if (!p) return { sats: 0 };
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
    if (stamp.script !== want) return { sats: 0, note: 'Postage is not paid to you', confirm: true };
  } catch (e) {
    // The wallet could not derive the key (locked, busy): nothing was learnt about the stamp.
    return later(e);
  }
  let whole = false;
  try {
    whole = Beef.fromBinary(Utils.toArray(p.beef, 'hex')).isValid();
  } catch {
    /* not a BEEF the SDK can walk */
  }
  if (!whole) return { sats: 0, note: 'Postage proof is incomplete' };
  // A transaction nobody signed cannot be on the network (in a block it needs no second look).
  if (!stamp.tx.merklePath && !stamp.tx.inputs.every((i) => (i.unlockingScript?.toBinary().length ?? 0) > 0))
    return { sats: 0, note: 'Postage is not a signed payment' };
  return { sats: stamp.sats, ...(stamp.tx.merklePath ? {} : { confirming: true }) };
};

/**
 * The account's own record of what a stamp paid for. It lives in the wallet, so every device of the account has it
 * once the devices have synced: the stamp's transaction carries the label stampLabel(outpoint) and one usedLabel per
 * letter or door request that outpoint was taken in for. The "bmail" labels are the wallet's own: no site can write
 * or list by one (services/reservedLabels.ts).
 */
export const stampLabel = (p: Pick<Postage, 'txid' | 'outputIndex'>) =>
  `bmail stamp ${p.txid}.${p.outputIndex}`.toLowerCase();
const hashHex = (text: string) => Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')));
/**
 * The label for one use of a stamp: the outpoint, then 20 bytes of a hash over the sender's key and `use`. `use` says
 * what the stamp pays for and holds its content, not just an id the sender picks (letterUse; the door's request), so
 * no other letter or request can ever match a record, whatever id it shows.
 */
export const usedLabel = (p: Pick<Postage, 'txid' | 'outputIndex'>, from: string, use: string) =>
  `bmail paid ${p.txid}.${p.outputIndex} ${hashHex(JSON.stringify([from.trim().toLowerCase(), use])).slice(0, 40)}`.toLowerCase();
/** What a letter's stamp pays for: this letter's id and its sealed content. */
export const letterUse = (env: Pick<Envelope, 'id' | 'sealed'>) => `letter ${env.id} ${hashHex(env.sealed)}`;
/** A note the wallet keeps beside a stamp's record (noteStamp), e.g. the door's "ticket <txid>". */
const noteLabel = (p: Pick<Postage, 'txid' | 'outputIndex'>, note: string) =>
  `bmail note ${p.txid}.${p.outputIndex} ${note
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')}`.slice(0, 250);

type StampRecord = {
  /** The wallet holds the stamp's transaction under the stamp's label, with this output as one of its own coins. */
  known: boolean;
  /** What this outpoint was taken in for (usedLabel), in order. */
  uses: string[];
  notes: string[];
  /** Uses written on an action that is no record (see stampRecord): never counted, now or after the coin is taken in. */
  stale: string[];
};
/**
 * What the wallet has recorded for a stamp. Only an action that is the stamp's own transaction, not failed, and holds
 * this very output as a coin of the wallet (its 'default' basket) counts: a label on anything else is no record. More
 * than one use is a race (two checks at the same moment, or two devices that had not synced): the first in order is
 * the one that counts, on every device alike.
 */
const stampRecord = async (wallet: WalletInterface, p: Postage): Promise<StampRecord> => {
  const { actions } = await wallet.listActions({
    labels: [stampLabel(p)],
    includeLabels: true,
    includeOutputs: true,
    limit: 10,
  });
  const mine = actions.filter(
    (a) =>
      a.txid === p.txid &&
      a.status !== 'failed' &&
      (a.outputs ?? []).some((o) => o.outputIndex === p.outputIndex && o.basket === 'default'),
  );
  const outpoint = `${p.txid}.${p.outputIndex} `.toLowerCase();
  const of = (from: typeof actions, kind: string) =>
    [...new Set(from.flatMap((a) => a.labels ?? []))]
      .sort()
      .filter((l) => l.startsWith(`bmail ${kind} ${outpoint}`))
      .map((l) => l.slice(`bmail ${kind} ${outpoint}`.length));
  const stale = of(
    actions.filter((a) => !mine.includes(a)),
    'paid',
  );
  return { known: mine.length > 0, uses: of(mine, 'paid'), notes: of(mine, 'note'), stale };
};
/** Is the outpoint one of the wallet's own spendable coins already? */
const walletHolds = async (wallet: WalletInterface, p: Postage): Promise<boolean> => {
  const outpoint = `${p.txid}.${p.outputIndex}`;
  for (let offset = 0; ; ) {
    const page = await wallet.listOutputs({ basket: 'default', limit: 1000, offset });
    if (page.outputs.some((o) => o.outpoint === outpoint)) return true;
    offset += page.outputs.length;
    if (!page.outputs.length || offset >= page.totalOutputs) return false;
  }
};

/**
 * Check the postage and take it in. A stamp counts as paid only when all of this holds, in this order:
 *  1. what the wallet alone can tell (stampPaysMe);
 *  2. the network has the transaction (`net.seen`), or takes it when this wallet hands it over (`net.broadcast`).
 *     A stamp that was signed and never sent, or whose coins were spent elsewhere, stops here: nothing is taken in.
 *     A refusal is believed only when the lookups said, before and after it, that the network does not have the
 *     transaction, and then only on a second check (`confirm`);
 *  3. the account's own record (stampRecord) does not show the stamp taken in for anything else. Taken in for this
 *     very letter (`use`: its id and content, letterUse) already, on this or another device: paid, nothing more to do;
 *  4. with no record: the output is unspent and not already one of the wallet's coins, and the wallet takes it in
 *     (internalizeAction, which checks the BEEF's proofs) under the labels that make the record. An output that is
 *     spent, with no record, was not taken in for this letter as far as this wallet knows: never paid on the spot.
 *     Another device of the account may have taken it in and not synced yet, so it is asked again later
 *     (`answered`), and given up on if the record never comes. A coin the wallet held before, with no record, paid
 *     for something else.
 * Returns the verified sats. `internalize` false (the notifier's peek): step 1 only, read-only.
 */
export const verifyPostage = async (
  wallet: WalletInterface,
  env: Envelope,
  internalize = true,
  net: StampNet = stampNet(),
  use = letterUse(env),
): Promise<StampCheck> => {
  const p = env.postage;
  if (!p) return { sats: 0 };
  const local = await stampPaysMe(wallet, env);
  if (!internalize || local.sats <= 0) return local;
  const sats = local.sats;
  const sighting = async (): Promise<Sighting> => {
    const s = await net.seen(p.txid);
    return s === true ? 'seen' : s === false ? 'missing' : s;
  };
  let stale: string[] = [];
  const mine = usedLabel(p, env.from, use).slice(`bmail paid ${p.txid}.${p.outputIndex} `.length);
  // Not in a block as far as the BEEF shows: is it by now? (Asked once the stamp is found paid.)
  const confirming = async () =>
    !!local.confirming && !!net.status && (await net.status(p.txid).catch(() => 'unclear')) !== 'confirmed';
  try {
    const before = await sighting();
    if (before !== 'seen') {
      const sent = await net.broadcast(p.beef);
      // Someone else may have sent it meanwhile: a second look, whatever the broadcaster said.
      const after = sent === 'seen' ? 'seen' : await sighting();
      if (after !== 'seen') {
        if (sent === 'refused' && before === 'missing' && after === 'missing')
          return { sats: 0, note: 'The network refused this stamp (already spent, or not valid)', confirm: true };
        return later('the network does not have the stamp yet');
      }
    }
    const record = await stampRecord(wallet, p);
    stale = record.stale;
    // Taken in for something already: for this very letter (paid, nothing to do), or for another (used). Either way
    // nothing more is taken in, so a record never gains a second use from here.
    if (record.uses.length) {
      if (record.uses[0] !== mine) return { sats: 0, note: STAMP_USED };
      return { sats, notes: record.notes, ...((await confirming()) ? { confirming: true } : {}) };
    }
    // Spent, and this wallet has no record of taking it in: not paid by it here. Another device may yet sync one.
    if (await net.spender(`${p.txid}_${p.outputIndex}`))
      return { sats: 0, note: STAMP_NO_RECORD, pending: true, answered: true };
    if (record.known || (await walletHolds(wallet, p))) return { sats: 0, note: STAMP_HELD };
  } catch (e) {
    return later(e);
  }
  // isMerge, satoshis: what the wallet toolbox adds to the BRC-100 answer.
  const take = (): Promise<{ accepted: boolean; isMerge?: boolean; satoshis?: number }> =>
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
      labels: [stampLabel(p), usedLabel(p, env.from, use)],
    });
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let fresh = true;
  try {
    // "…undergoing active changes": device sync wrote this same payment (taken in on another device of this wallet)
    // while the call ran. A second try finds it stored and merges. No error text is read as "paid".
    const took = await take().catch((e) => (/active changes/i.test(message(e)) ? take() : Promise.reject(e)));
    // The toolbox says when the transaction was in the wallet already and nothing was added: another check of this
    // same stamp took it in a moment ago.
    fresh = !(took.isMerge === true && took.satoshis === 0);
  } catch (e) {
    // The wallet holds the transaction as failed/invalid: not good.
    if (isPermanentInternalizeError(e)) return { sats: 0, note: `Postage not accepted: ${message(e)}`.slice(0, 160) };
    // "must be valid AtomicBEEF": a forged proof, or the wallet's chain lookup is down. The block headers tell which.
    if (/valid AtomicBEEF/i.test(message(e)) && !(await proofsHold(wallet, p.beef).catch(() => true)))
      return { sats: 0, note: 'Postage proof is not valid' };
    return later(e);
  }
  // Two checks at the same moment (a letter and a door request showing one payment) both get this far: the record
  // now holds both, and only the first in order is paid.
  try {
    const uses = (await stampRecord(wallet, p)).uses.filter((u) => !stale.includes(u) || u === mine);
    if (uses.length && uses[0] !== mine) return { sats: 0, note: STAMP_USED };
  } catch (e) {
    return later(e);
  }
  return { sats, ...(fresh ? { fresh } : {}), ...((await confirming()) ? { confirming: true } : {}) };
};

/**
 * Add a note to the account's record of a stamp this wallet has taken in (the door: "ticket <txid>" once the ticket
 * went out, so the host's other devices know). The wallet merges it into the transaction it already holds; nothing
 * is taken in. Only for a stamp whose record names `use`.
 */
export const noteStamp = async (wallet: WalletInterface, env: Envelope, use: string, note: string): Promise<void> => {
  const p = env.postage;
  if (!p) return;
  const record = await stampRecord(wallet, p);
  if (record.uses[0] !== usedLabel(p, env.from, use).slice(`bmail paid ${p.txid}.${p.outputIndex} `.length)) return;
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
    labels: [stampLabel(p), noteLabel(p, note)],
  });
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
/**
 * given up on after this many tries that the wallet and the network answered (tries they could not be reached for do
 * not count), or RELAY_KEEP_MS after the first, by this device's clock and the chain's.
 */
export const RECHECK_TRIES = 12;
/** At most this many letters are checked against the network in one refresh, */
export const RECHECK_MAX = 20;
/** and this many of one sender's, so one sender's backlog cannot hold up another sender's letter. */
export const RECHECK_PER_SENDER = 5;
/** At most this many stamps are read by the wallet alone (no network) in one refresh. */
export const RECHECK_LOCAL_MAX = 200;

/** Has RECHECK_EVERY_MS passed since `t` (0: never; a time ahead of the clock was a wrong clock's)? */
const waited = (t: number | undefined, now: number) => !t || t > now || now - t >= RECHECK_EVERY_MS;

/**
 * The letters to check against the network now: only stamps the wallet has found to pay this account
 * (`recheck.mine`), so a stamp that pays someone else never costs a network check. Senders take turns: senders the
 * user deals with first, then the sender whose letter has waited longest, a letter never tried before any tried one.
 */
const recheckQueue = (received: Received[], now: number, trusted: (from: string) => boolean): Received[] => {
  const bySender = new Map<string, Received[]>();
  for (const r of received) {
    if (!r.recheck?.mine || !waited(r.recheck.last, now)) continue;
    bySender.set(r.from, [...(bySender.get(r.from) ?? []), r]);
  }
  // Never tried (last 0): the one first seen longest ago goes first. Then the one whose last try is longest ago.
  const order = (a: Received, z: Received) =>
    (a.recheck?.last ?? 0) - (z.recheck?.last ?? 0) || (a.recheck?.first ?? 0) - (z.recheck?.first ?? 0);
  const lines = [...bySender.values()]
    .map((l) => l.sort(order).slice(0, RECHECK_PER_SENDER))
    .sort((a, z) => Number(trusted(z[0].from)) - Number(trusted(a[0].from)) || order(a[0], z[0]));
  const out: Received[] = [];
  for (let turn = 0; turn < RECHECK_PER_SENDER; turn++) for (const l of lines) if (l[turn]) out.push(l[turn]);
  return out.slice(0, RECHECK_MAX);
};

/** A stamp found paid while not yet in a block is watched until it is (settleConfirmations). */
const settlingFrom = (v: StampCheck, now: number) => (v.confirming ? { settling: { since: now, last: now } } : {});

/** Write one check's answer to the stored letter (see StampCheck). */
const settleStamp = (
  me: string,
  id: string,
  v: StampCheck,
  now: number,
  o: { local?: boolean; giveUp?: boolean } = {},
) =>
  updateMail(me, (s) => ({
    ...s,
    received: s.received.map((x) => {
      if (x.id !== id || !x.recheck) return x;
      const { recheck, stampOpen: _open, ...rest } = x;
      const first = recheck.first;
      // Given up, not refused: the letter can be checked again when it is opened (recheckLetter).
      if (o.giveUp) return { ...rest, verifiedSats: 0, verifyNote: GAVE_UP, stampOpen: now };
      if (v.sats > 0) {
        // The wallet alone found it pays this account: the network check is still to come.
        if (o.local) return { ...x, recheck: { first, last: recheck.last, tries: recheck.tries, mine: true as const } };
        return {
          ...rest,
          verifiedSats: v.sats,
          verifyNote: v.note,
          stampRecorded: true as const,
          ...settlingFrom(v, now),
        };
      }
      if (v.pending) {
        const tries = recheck.tries + (v.answered ? 1 : 0);
        if (tries >= RECHECK_TRIES) return { ...rest, verifiedSats: 0, verifyNote: GAVE_UP, stampOpen: now };
        const { doubt: _doubt, ...kept } = recheck;
        return { ...x, verifyNote: v.note, recheck: { ...kept, first, last: o.local ? recheck.last : now, tries } };
      }
      // One look does not settle it: unpaid for good only when a check at least RECHECK_EVERY_MS later agrees.
      if (v.confirm && !(recheck.doubt !== undefined && waited(recheck.doubt, now)))
        return {
          ...x,
          verifyNote: NOT_CHECKED,
          recheck: {
            ...recheck,
            first,
            last: o.local ? recheck.last : now,
            doubt: Math.min(recheck.doubt ?? now, now),
          },
        };
      return { ...rest, verifiedSats: 0, verifyNote: v.note };
    }),
  }));

/**
 * Stored letters whose postage is not checked yet (`recheck`; every stamped letter starts so): check from the stored
 * envelope (the relay ledger plays no part) and settle each one.
 *  - First what the wallet alone can tell (stampPaysMe), for up to RECHECK_LOCAL_MAX letters: a stamp that does not
 *    pay this account never reaches the network queue.
 *  - Then the network and the account's record (verifyPostage), for the letters of recheckQueue. Paid: verifiedSats
 *    is set, once, so the letter routes and shows as any paid letter. Of several letters showing one stamp, the one
 *    the wallet took it in for keeps it and the others are unstamped.
 *  - Given up on (RECHECK_TRIES answered tries, or RELAY_KEEP_MS by this device's clock and by the chain's, and
 *    never before a first network try): unpaid, and checked again when the letter is opened (recheckLetter).
 * Nothing is written for a check during which the wallet was on another account.
 */
export const recheckPostage = async (
  wallet: WalletInterface,
  me: string,
  now = Date.now(),
  net: StampNet = stampNet(),
): Promise<void> => {
  const settle = (id: string, v: StampCheck, o?: { local?: boolean; giveUp?: boolean }) =>
    settleStamp(me, id, v, now, o);
  // One stamp, one letter: a letter whose stamp has paid for another stored letter is unstamped, nothing asked.
  const settleUsed = () => {
    const s = loadMail(me);
    const used = usedStamps(s);
    for (const r of s.received)
      if (r.recheck && r.env.postage && (used.get(stampOutpoint(r.env.postage)) ?? r.id) !== r.id)
        settle(r.id, { sats: 0, note: STAMP_USED });
  };
  settleUsed();
  // First the stamps that were paid before they were in a block: one the network has dropped is checked again below.
  await settleConfirmations(wallet, me, now, net);
  if (!(await sameAccount(wallet, me))) return;
  // Too old by this device's clock: given up only if the newest block's time says so too, and never a stamp that
  // pays this account before its first network check.
  const old = (r: Received, t: number) =>
    !!r.recheck && (r.recheck.last > 0 || !r.recheck.mine) && t - r.recheck.first >= RELAY_KEEP_MS;
  if (loadMail(me).received.some((r) => old(r, now))) {
    const chainNow = await chainTime(wallet).catch(() => undefined);
    if (chainNow !== undefined)
      for (const r of loadMail(me).received)
        if (old(r, now) && old(r, chainNow)) settle(r.id, { sats: 0 }, { giveUp: true });
  }
  const s0 = loadMail(me);
  const trusted = (from: string) => isTrustedSender(s0, from);
  const unread = s0.received
    .filter((r) => r.recheck && !r.recheck.mine && waited(r.recheck.doubt, now))
    .sort((a, z) => Number(trusted(z.from)) - Number(trusted(a.from)));
  // The wallet may have switched account since the refresh began: its keys and this mail are then not one account's.
  if (!(await sameAccount(wallet, me))) return;
  for (const r of unread.slice(0, RECHECK_LOCAL_MAX)) {
    const v = await stampPaysMe(wallet, r.env);
    if (!(await sameAccount(wallet, me))) return;
    settle(r.id, v, { local: true });
  }
  for (const r of recheckQueue(loadMail(me).received, now, trusted)) {
    if (!(await sameAccount(wallet, me))) return;
    const used = usedStamps(loadMail(me));
    if (r.env.postage && (used.get(stampOutpoint(r.env.postage)) ?? r.id) !== r.id) continue;
    const v = await verifyPostage(wallet, r.env, true, net);
    if (!(await sameAccount(wallet, me))) return;
    settle(r.id, v);
  }
  settleUsed();
};

/**
 * Letters paid by a stamp that was not in a block yet (`settling`): one lookup each, at most every RECHECK_EVERY_MS
 * and RECHECK_MAX a refresh, until the stamp has a confirmation. If the network no longer has the transaction (it was
 * replaced by another spend of the same coins, or dropped), and a second look at least RECHECK_EVERY_MS later says
 * the same, the letter is unpaid again and goes back to "not checked yet": the ordinary check then hands the stamp to
 * the network once more and settles it (paid again if it is taken, unpaid for good if it is refused). The wallet's own
 * record of the dead coin is left to the wallet (it marks a transaction the network dropped as failed in its own time).
 */
const settleConfirmations = async (wallet: WalletInterface, me: string, now: number, net: StampNet): Promise<void> => {
  const status = net.status;
  const due = loadMail(me)
    .received.filter((r) => r.settling && r.env.postage && waited(r.settling.last, now))
    .sort((a, z) => (a.settling?.last ?? 0) - (z.settling?.last ?? 0))
    .slice(0, RECHECK_MAX);
  for (const r of due) {
    const said: StampStatus =
      !status || now - (r.settling?.since ?? now) >= RELAY_KEEP_MS
        ? 'confirmed'
        : await status((r.env.postage as Postage).txid).catch((): StampStatus => 'unclear');
    if (!(await sameAccount(wallet, me))) return;
    updateMail(me, (s) => ({
      ...s,
      received: s.received.map((x) => {
        if (x.id !== r.id || !x.settling) return x;
        const { settling, ...rest } = x;
        if (said === 'confirmed') return rest;
        if (said !== 'missing') return { ...x, settling: { since: settling.since, last: now } };
        if (!(settling.doubt !== undefined && waited(settling.doubt, now)))
          return { ...x, settling: { ...settling, last: now, doubt: Math.min(settling.doubt ?? now, now) } };
        return {
          ...rest,
          verifiedSats: 0,
          verifyNote: STAMP_DROPPED,
          recheck: { first: now, last: 0, tries: 0, mine: true as const },
        };
      }),
    }));
  }
};

/**
 * A letter whose stamp was given up on (`stampOpen`: no answer in time, never a refusal) is checked once more, at
 * most every RECHECK_EVERY_MS: the bMail screen calls this when the letter is opened. Paid: it shows and routes as
 * any paid letter from then on.
 */
export const recheckLetter = async (
  wallet: WalletInterface,
  me: string,
  id: string,
  now = Date.now(),
  net: StampNet = stampNet(),
): Promise<void> => {
  const r = loadMail(me).received.find((x) => x.id === id);
  if (!r?.env.postage || r.stampOpen === undefined || r.verifiedSats > 0) return;
  if (!waited(r.stampOpen, now)) return;
  if ((usedStamps(loadMail(me)).get(stampOutpoint(r.env.postage)) ?? id) !== id) return;
  if (!(await sameAccount(wallet, me))) return;
  const v = await verifyPostage(wallet, r.env, true, net);
  if (!(await sameAccount(wallet, me))) return;
  updateMail(me, (s) => ({
    ...s,
    received: s.received.map((x) => {
      if (x.id !== id || x.stampOpen === undefined) return x;
      const { stampOpen: _open, ...rest } = x;
      return v.sats > 0
        ? {
            ...rest,
            verifiedSats: v.sats,
            verifyNote: undefined,
            stampRecorded: true as const,
            ...settlingFrom(v, now),
          }
        : { ...x, stampOpen: now };
    }),
  }));
};

/** At most this many new letters are taken in by one fetch; the rest wait for the next. */
export const TAKE_MAX = 200;
/** At most this many stamped letters from strangers wait, stored, for their first network check (see fetchMail). */
export const WAITING_MAX = 100;

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
 *      sight by a clock that was behind (recorded at the newest block's time when that is later: `ctx.chainNow`),
 *      therefore clears nothing at once; a mark made by a clock that has
 *      since gone back is dropped. The envelope's `at` is the sender's claim and plays no part. These are also listed
 *      in `aged` (relay id → when it arrived): syncMail clears them only if the newest block's time agrees;
 *  (b) a letter this device has erased (30 days in the Bin; `ctx.erased`, by relay id).
 * A message that fails the envelope checks is refused, remembered and skipped from then on, and goes by rule (a), so
 * a newer wallet on another device still gets its chance at it. `seen` is the ledger to keep: an entry for every
 * listed message this device has dealt with, so none is ever taken twice.
 *
 * At most TAKE_MAX new letters are taken per fetch (pickNew: the user's own correspondents and stamped letters
 * first), and stamped letters from strangers only while fewer than WAITING_MAX wait for their first network check;
 * the others stay unlisted in the ledger and are taken by later fetches.
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
    /** The time of the newest block (syncMail: chainTime), asked for only when a first sight is recorded. */
    chainNow?: () => Promise<number>;
    /** How many more stamped letters from strangers may join the line for a first network check (WAITING_MAX). */
    room?: number;
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
  // The time a first sight is recorded at: this device's clock, or the newest block's when that is later (a clock
  // that is behind would otherwise make the message look 30 days old as soon as it is put right).
  let latest: number | undefined;
  const sighted = async () => (latest ??= Math.max(now, (await ctx.chainNow?.().catch(() => undefined)) ?? 0));
  const seen: RelaySeen = new Map();
  const cands: { m: RelayMessage; key: string; env: Envelope; at: number }[] = [];
  for (const m of msgs) {
    const key = relayKey(m.messageId);
    const had = ctx.seen?.get(key);
    if (had) {
      // Dealt with on an earlier fetch: nothing is decoded or checked again.
      // A first-seen time ahead of the clock and of the chain (the clock was wrong then) starts again from now.
      const first = had.first > now ? Math.min(had.first, await sighted()) : had.first;
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
      seen.set(key, { first: await sighted(), due: 0 });
    else cands.push({ m, key, env, at: typeof m.created_at === 'string' ? Date.parse(m.created_at) : NaN });
  }
  const rank = (env: Envelope) => (ctx.blocked?.(env.from) ? 3 : ctx.trusted?.(env.from) ? 0 : env.postage ? 1 : 2);
  // Stamped letters from senders the user has no dealings with are taken only while there is room in the line for a
  // first network check (ctx.room): the rest stay on the relay, untouched, and are taken by later fetches. A stamp
  // costs nothing to make up, and a letter waiting for its check is never dropped (store.ts trimReceived), so the
  // line is what is kept short.
  const lined = (c: { env: Envelope }) => ctx.room !== undefined && !!c.env.postage && rank(c.env) === 1;
  const allowed = new Set(pickNew(cands.filter(lined), rank, Math.max(0, ctx.room ?? 0)));
  const takeable = cands.filter((c) => !lined(c) || allowed.has(c));
  for (const { m, key, env } of pickNew(takeable, rank, TAKE_MAX)) {
    seen.set(key, { first: await sighted(), due: 0 });
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
      ...(unchecked ? { recheck: { first: await sighted(), last: 0, tries: 0 } } : {}),
    });
  }
  return { items, ack, aged, seen };
};

/**
 * Upgrade step, once per letter: a letter this device stored as paid before the account kept its record in the
 * wallet has no record there, so the account's other devices could not tell what its stamp paid for. For each such
 * letter whose stamp the wallet really holds as one of its own coins (found in the wallet's own history; spent or
 * not), the record's labels are written onto that transaction. Nothing is taken in: a transaction the wallet does
 * not hold, or one that already has a record, is left alone. Returns how many records were written.
 */
export const recordOldStamps = async (wallet: WalletInterface, me: string): Promise<number> => {
  const todo = loadMail(me).received.filter((r) => r.verifiedSats > 0 && r.env.postage && !r.stampRecorded);
  if (!todo.length) return 0;
  // Which of these stamps the wallet holds: its history, by txid, with the outputs that are its own coins.
  const wanted = new Set(todo.map((r) => (r.env.postage as Postage).txid));
  const held = new Set<string>();
  for (let offset = 0; ; ) {
    const page = await wallet.listActions({ labels: [], includeOutputs: true, limit: 1000, offset });
    for (const a of page.actions)
      if (wanted.has(a.txid) && a.status !== 'failed')
        for (const o of a.outputs ?? []) if (o.basket === 'default') held.add(`${a.txid}.${o.outputIndex}`);
    offset += page.actions.length;
    if (!page.actions.length || offset >= page.totalActions) break;
  }
  let written = 0;
  for (const r of todo) {
    const p = r.env.postage as Postage;
    try {
      if (held.has(stampOutpoint(p)) && !(await stampRecord(wallet, p)).uses.length) {
        await wallet.internalizeAction({
          tx: Utils.toArray(p.beef, 'hex'),
          outputs: [
            {
              outputIndex: p.outputIndex,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: p.derivationPrefix,
                derivationSuffix: p.derivationSuffix,
                senderIdentityKey: r.env.from,
              },
            },
          ],
          description: 'bMail postage received',
          labels: [stampLabel(p), usedLabel(p, r.env.from, letterUse(r.env))],
        });
        written++;
      }
    } catch (e) {
      // Not written (the wallet would not merge it): the letter is not tried again; other devices read it unpaid.
      console.warn('[bMail] could not record an old stamp', e);
    }
    if (!(await sameAccount(wallet, me))) return written;
    updateMail(me, (s) => ({
      ...s,
      received: s.received.map((x) => (x.id === r.id ? { ...x, stampRecorded: true as const } : x)),
    }));
  }
  return written;
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
  await recordOldStamps(wallet, me).catch(() => undefined);
  if (!(await sameAccount(wallet, me))) return;
  const s = loadMail(me);
  const { items, ack, aged, seen } = await fetchMail(
    {
      me,
      sent: s.sent,
      known: new Set(s.received.map((r) => r.id)),
      // Credits already spent by a stored letter: one reply per reply-paid credit.
      creditsUsed: new Set(
        s.received.filter((r) => r.replyCredit && r.env.inReplyTo).map((r) => r.env.inReplyTo as string),
      ),
      stamps: usedStamps(s),
      seen: loadRelaySeen(me),
      erased: new Set(s.received.flatMap((r) => (r.erased && r.relayId ? [r.relayId] : []))),
      trusted: (from) => isTrustedSender(s, from),
      blocked: (from) => (s.blocked ?? []).includes(from),
      now,
      chainNow: () => chainTime(wallet),
      room: Math.max(0, WAITING_MAX - s.received.filter((r) => isWaiting(r) && !isTrustedSender(s, r.from)).length),
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

/**
 * How long the notifier waits before its next peek, by how many messages the last one listed. The relay has no
 * "new since" or ids-only listing (message box client 2.5.4: offset, limit, page size), so every peek downloads the
 * whole box, bodies included, and mail stays in it for 30 days: a large box is peeked less often.
 */
export const peekGapMs = (listed: number): number =>
  listed <= 20 ? 0 : listed <= 200 ? 5 * 60 * 1000 : 15 * 60 * 1000;

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
  skip: {
    known?: ReadonlySet<string>;
    seen?: RelaySeen;
    stamps?: ReadonlyMap<string, string>;
    /** Told how many messages the relay listed (the notifier paces its next peek by it: peekGapMs). */
    onListed?: (count: number) => void;
  } = {},
  relay: MailRelay = relayOf(wallet),
): Promise<{ env: Envelope; sats: number }[]> => {
  const msgs = await relay.list();
  skip.onListed?.(msgs.length);
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
