/**
 * Phone to phone (prototype, docs/DIRECT-PAY.md): the glue between bWalletX and the vendored @bsv/webrtpay.
 *
 * In person, two QR codes and no server: the payee shows an offer code, the payer scans it, approves on one sheet,
 * and shows an answer code; the payee scans that. The channel is authenticated with both identity keys
 * ([2, 'webrtpay channel'], a wallet-internal protocol: services/reservedProtocolList.ts) and carries a PeerPay
 * PaymentToken (AtomicBEEF + BRC-29 derivation prefix/suffix). The payee checks the BRC-29 output before
 * internalizeAction (verifyDirectPayment), and a re-delivered token is acknowledged without internalizing twice.
 *
 * Wallet calls pass no originator: the UI's wallet (ChromeCWI from our own pages, or the admin-bound wallet) is the
 * wallet itself, so the reserved-protocol guard lets them through and no permission prompt appears. The user's
 * approval is the one sheet in DirectPaySheet, before anything is answered or spent.
 *
 * Only DirectPaySheet imports this file, and DirectPaySheet is a lazy chunk behind DIRECT_PAY_ENABLED.
 */
import { P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import {
  DirectPayClient,
  PAYMENT_PROTOCOL_ID,
  WebRTPayError,
  acceptDirectPayment,
  decodeCode,
  randomBytes,
  toBase64,
  validatePaymentToken,
  type AuthenticatedPeer,
  type OfferCode,
  type PaymentAck,
  type PaymentTokenInput,
  type ReceiveHandlers,
  type RtcOptions,
  type SeenStore,
  type WalletLike,
  verifyDirectPayment,
} from '../../vendor/webrtpay/index';

/** bWalletX is mainnet only (contexts/providers/ServiceProvider.tsx). */
export const DIRECT_PAY_CHAIN = 'main';
/** How long an offer code stays good: long enough to show it, short enough that a stale screenshot is useless. */
export const OFFER_TTL_MS = 5 * 60_000;
/** History label: wallet/txHistory.ts labels anything whose description says this "phone to phone". */
export const HISTORY_TEXT = 'Phone to phone';
const LABELS = ['phone to phone', 'peerpay', 'direct'];
/** Most sats one phone-to-phone payment may carry in the prototype (0.1 BSV). */
export const MAX_DIRECT_SATS = 10_000_000;

export const shortKey = (k: string) => (k.length > 14 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);

export const stunServers = (env: string | undefined = import.meta.env?.VITE_DIRECT_PAY_STUN): RTCIceServer[] => {
  const urls = (env ?? 'stun:stun.l.google.com:19302')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^stuns?:/i.test(u));
  return urls.length ? [{ urls }] : [];
};

export const createDirectPayClient = (wallet: WalletLike, rtc: RtcOptions = { iceServers: stunServers() }) =>
  new DirectPayClient({ wallet, chain: DIRECT_PAY_CHAIN, rtc });

// ── Durable stores (per device). Wrapped: storage can be missing (private mode, tests). ──────────────────────────

/** Key/value storage the stores use; localStorage in the app, a Map in tests. */
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

const read = <T>(kv: KV | undefined, key: string, fallback: T): T => {
  try {
    const raw = kv?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (kv: KV | undefined, key: string, v: unknown) => {
  try {
    kv?.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or unavailable: idempotency falls back to the wallet's own duplicate checks */
  }
};

const SEEN_KEY = 'bwx.directpay.seen';
const SEEN_CAP = 500;

/** Payments already taken in (webrtpay paymentKey), so a re-delivery is acked without internalizing twice. */
export const seenStore = (kv: KV | undefined = globalThis.localStorage): SeenStore => ({
  has: (k) => read<string[]>(kv, SEEN_KEY, []).includes(k),
  add: (k) => {
    const all = read<string[]>(kv, SEEN_KEY, []).filter((x) => x !== k);
    all.push(k);
    write(kv, SEEN_KEY, all.slice(-SEEN_CAP));
  },
});

const PENDING_KEY = 'bwx.directpay.pending';

type StoredToken = { prefix: string; suffix: string; tx: string; amount: number; outputIndex: number; at: number };

/**
 * Tokens the payer broadcast but the payee has not acknowledged, by payee identity key. The money has left; the payee
 * needs the token to find it. The next phone-to-phone session with the same payee delivers it again first.
 */
export const pendingStore = (kv: KV | undefined = globalThis.localStorage) => {
  const all = () => read<Record<string, StoredToken>>(kv, PENDING_KEY, {});
  return {
    get(payee: string): PaymentTokenInput | null {
      const t = all()[payee];
      if (!t) return null;
      return {
        customInstructions: { derivationPrefix: t.prefix, derivationSuffix: t.suffix },
        transaction: Utils.toArray(t.tx, 'base64'),
        amount: t.amount,
        outputIndex: t.outputIndex,
      };
    },
    put(payee: string, token: PaymentTokenInput) {
      const m = all();
      m[payee] = {
        prefix: token.customInstructions.derivationPrefix,
        suffix: token.customInstructions.derivationSuffix,
        tx: Utils.toBase64(Array.from(token.transaction)),
        amount: token.amount,
        outputIndex: token.outputIndex ?? 0,
        at: Date.now(),
      };
      write(kv, PENDING_KEY, m);
    },
    remove(payee: string) {
      const m = all();
      delete m[payee];
      write(kv, PENDING_KEY, m);
    },
  };
};
export type PendingStore = ReturnType<typeof pendingStore>;

// ── Payee ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Received = { txid: string; sats: number; sender: string; duplicate: boolean };

/**
 * Receive handlers: verify the BRC-29 output pays this wallet the stated amount BEFORE internalizeAction, then
 * internalize once. A payment that does not verify is refused and nothing is stored. A wallet failure after it
 * verified throws: the payer gets "rejected" with the txid, keeps its token and delivers it again (pendingStore).
 */
export const receiveHandlers = (o: {
  wallet: WalletLike;
  seen: SeenStore;
  onReceived: (r: Received) => void;
  onError?: (e: unknown) => void;
}): ReceiveHandlers => ({
  async onPayment(p) {
    try {
      await verifyDirectPayment(o.wallet, p);
    } catch (e) {
      if (e instanceof WebRTPayError && e.code === 'invalid_payment') return { status: 'rejected', reason: e.message };
      throw e;
    }
    const r = await acceptDirectPayment(o.wallet, p, {
      seen: o.seen,
      labels: [...LABELS, 'inbound'],
      description: `${HISTORY_TEXT} from ${shortKey(p.sender)}`,
      onSeenError: (e) => console.warn('[directPay] payment taken but not recorded as seen', e),
    });
    o.onReceived({ txid: r.txid, sats: p.token.amount, sender: p.sender, duplicate: r.status === 'duplicate' });
    return 'accepted';
  },
  onError: o.onError,
});

// ── Payer ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type OfferPreview = { identityKey: string; amount?: number; expiresAt?: number };

/** Read a scanned offer code without answering it (answering starts the ~15 s ICE clock). Throws a user message. */
export const previewOffer = (text: string, now = Date.now()): OfferPreview => {
  let c: ReturnType<typeof decodeCode>;
  try {
    c = decodeCode(text.trim(), { expectedChain: DIRECT_PAY_CHAIN, now });
  } catch (e) {
    throw new Error(
      e instanceof WebRTPayError && /expired/i.test(e.message)
        ? 'This code has expired. Ask them to show a new one.'
        : e instanceof WebRTPayError && /network|chain/i.test(e.message)
          ? 'Their wallet is on a different network.'
          : 'Not a phone-to-phone payment code.',
    );
  }
  if (c.kind !== 'offer') throw new Error('That is an answer code. Scan the code on the phone you are paying.');
  const o = c as OfferCode;
  return { identityKey: o.identityKey, amount: o.amount, expiresAt: o.expiresAt };
};

/** Whole sats in (0, MAX_DIRECT_SATS]: the approval sheet refuses anything else. */
export const validSats = (sats: unknown): sats is number =>
  typeof sats === 'number' && Number.isSafeInteger(sats) && sats > 0 && sats <= MAX_DIRECT_SATS;

export type PayWallet = Pick<WalletInterface, 'getPublicKey' | 'createAction' | 'abortAction'>;

export type PayOutcome =
  | { k: 'paid'; txid: string; sats: number; ack: PaymentAck['status'] }
  /** Broadcast, but the payee did not acknowledge: the token is kept and delivered again next time. */
  | { k: 'undelivered'; txid: string; sats: number; reason: string }
  /** An earlier undelivered payment to this payee went through instead; nothing new was spent. */
  | { k: 'redelivered'; txid: string; sats: number };

const txidOf = (token: PaymentTokenInput) => Transaction.fromAtomicBEEF(Array.from(token.transaction)).id('hex');

/**
 * Pay over an authenticated channel, PeerPay style, in the order the package asks for: sign without broadcasting,
 * check the channel is still open, broadcast, deliver, wait for the ack. A channel that closed before the broadcast
 * aborts the action (nothing spent). After the broadcast, the token is kept until the payee acks it.
 */
export async function payOverChannel(o: {
  client: Pick<DirectPayClient, 'sendPayment'>;
  wallet: PayWallet;
  peer: Pick<AuthenticatedPeer, 'isOpen' | 'peerIdentityKey'>;
  sats: number;
  pending: PendingStore;
}): Promise<PayOutcome> {
  const payee = o.peer.peerIdentityKey;
  const earlier = o.pending.get(payee);
  if (earlier) {
    const ack = await o.client.sendPayment(o.peer as AuthenticatedPeer, earlier);
    if (ack.status === 'rejected') throw new Error(ack.reason || 'They could not take the earlier payment');
    o.pending.remove(payee);
    return { k: 'redelivered', txid: txidOf(earlier), sats: earlier.amount };
  }
  if (!validSats(o.sats)) throw new Error('Choose an amount first');

  const derivationPrefix = toBase64(randomBytes(32));
  const derivationSuffix = toBase64(randomBytes(32));
  const { publicKey } = await o.wallet.getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payee,
  });
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
  const description = `${HISTORY_TEXT} payment to ${shortKey(payee)}`;
  const signed = await o.wallet.createAction({
    description,
    labels: [...LABELS, 'outbound'],
    outputs: [{ satoshis: o.sats, lockingScript, outputDescription: HISTORY_TEXT }],
    options: { randomizeOutputs: false, noSend: true },
  });
  const txid = signed.txid;
  if (!signed.tx || !txid) throw new Error('The wallet did not return the payment');
  const token: PaymentTokenInput = {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: signed.tx,
    amount: o.sats,
    outputIndex: 0,
  };
  const abort = () => o.wallet.abortAction({ reference: txid }).catch(() => undefined);
  try {
    validatePaymentToken(token);
  } catch (e) {
    await abort();
    throw e;
  }
  if (!o.peer.isOpen) {
    await abort();
    throw new Error('The other phone hung up before you paid. Nothing was sent.');
  }
  try {
    await o.wallet.createAction({ description, options: { sendWith: [txid] } });
  } catch (e) {
    await abort();
    throw e;
  }
  // Broadcast: from here the payee must get this token, now or on a later delivery.
  o.pending.put(payee, token);
  try {
    const ack = await o.client.sendPayment(o.peer as AuthenticatedPeer, token);
    if (ack.status === 'rejected')
      return { k: 'undelivered', txid, sats: o.sats, reason: ack.reason || 'They could not take it yet' };
    o.pending.remove(payee);
    return { k: 'paid', txid, sats: o.sats, ack: ack.status };
  } catch (e) {
    return { k: 'undelivered', txid, sats: o.sats, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** A user-facing line for a connect failure (the fallback offers a normal send). */
export const connectFailure = (e: unknown): string => {
  if (e instanceof WebRTPayError) {
    if (e.code === 'rejected' && e.reason === 'wrong_network') return 'Their wallet is on a different network.';
    if (e.code === 'timeout' || e.code === 'peer_unreachable' || e.code === 'closed')
      return "The phones couldn't reach each other. Nothing was sent.";
    if (e.code === 'auth_failed') return "Couldn't confirm the other phone's identity. Nothing was sent.";
  }
  return "Phone to phone didn't connect. Nothing was sent.";
};
