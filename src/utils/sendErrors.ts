/**
 * Send errors in words a person can act on (owner, 28 Oct 2026: a $2 send twice showed only "That didn't work: An
 * internal error has occurred." — "we can't have generic errors in such a critical operation").
 *
 * Every class says what happened, whether money moved, and what to do. The raw text is never shown on its own: it
 * goes in `detail`, behind a Details button with Copy, for support.
 *
 * Pure: no chrome, no React. Tested in sendErrors.test.ts.
 */

/** 'yes': it went out on chain (e.g. a $name payment whose delivery to the payee's host failed afterwards). */
export type MoneyMoved = 'no' | 'unknown' | 'yes';

/**
 * Coins this device still listed as spendable were spent from another device holding the same seed (owner's iPhone,
 * 4 Nov 2026: the extension spent three coins the phone still counted). Said by the background after it cleared those
 * coins: before broadcasting (services/coinPreflight.ts) or after the network refused the send
 * (services/invalidSendHeal.ts). Nothing went out.
 */
export const SPENT_ELSEWHERE_MESSAGE =
  'Some of your coins were already spent from another device. Your balance is updated, so try again.';
/** The same, when the coins left are not enough for this payment (try again would only fail). */
export const SPENT_ELSEWHERE_SHORT_MESSAGE =
  "Some of your coins were already spent from another device. Your balance is updated, and it isn't enough for this payment now. Nothing was sent.";
/** The check found coins spent elsewhere but could not record that (trying again would pick them again). */
export const SPENT_ELSEWHERE_STUCK_MESSAGE =
  "Some of your coins were already spent from another device, but the wallet couldn't update them. Nothing was sent. Go to Settings › Troubleshooting › Resync coins, then send again.";
/**
 * The default after ANY attempt that may have been broadcast and didn't clearly succeed (17c): a refusal can come for a
 * transaction that already went out (refusalRecheck.ts), and WhatsOnChain lags, so its 404 proves nothing. Only hard
 * proof says "not sent" (REFUSED_NOT_SENT_MESSAGE).
 */
export const REFUSED_MAYBE_SENT_MESSAGE = "We can't confirm whether this went out. Check History before sending again.";
/**
 * DOUBLE_SPEND_ATTEMPTED with the other payment not proven mined: ARC keeps the refused transaction and mines it if the
 * other one drops (review 17 F2, 17b H1).
 */
export const DOUBLE_SPEND_PENDING_MESSAGE =
  "We can't confirm whether this went out: one of its coins was also used by another payment, and either may still go through. Check History before sending again.";
/**
 * Hard proof it can't go out: the broadcaster named a DIFFERENT transaction as the spender of this payment's input, or
 * every input is known spent by other transactions (17c: never on a WhatsOnChain 404 alone).
 */
export const REFUSED_NOT_SENT_MESSAGE =
  'The network refused this payment because a coin in it was already spent by another payment, so nothing was sent. Refresh, then try again.';
/**
 * The coin this payment needed was spent by an earlier payment of this wallet TO THE SAME PAYEE (one it may have shown
 * as failed): that payment went out, so nothing is retried (review 17, F1: a retry here paid the same payee twice).
 * Sites never see the txid (sendFailureText).
 */
export const ownPaymentOutMessage = (txid?: string): string =>
  `Your earlier payment to this payee already went out${txid ? ` (tx ${txid})` : ''}. Nothing more was sent, so you won't pay twice. Find it in History.`;
/**
 * The coin went to an earlier payment of this wallet that isn't proven to be to this payee: a $name payee gets a fresh
 * address each time, so "someone else" is never claimed (17c M1), and nobody is told to send again.
 */
export const OWN_COIN_OTHER_PAYMENT_MESSAGE =
  "An earlier payment from this wallet went out using a coin this payment needed. If it was to this payee, don't send again. Check History first.";
/**
 * A coin whose parent payment the network can't find was set aside for now, so sends stop failing on it (17c L3). It
 * comes back by itself once that payment shows up (17d M1: never "won't use it again").
 */
export const MISSING_PARENT_MESSAGE =
  "A coin in this payment comes from a payment the network can't find yet, so it was set aside for now. We'll check again and put it back when that payment shows up. We can't confirm whether this payment went out. Check History before sending again.";
/**
 * The refused payment can't go out, but this wallet's own payments couldn't be read, so the coin's spender may be an
 * earlier payment of ours to the same payee (17d L3): never "try again".
 */
export const OWN_PAYMENTS_UNCHECKED_MESSAGE =
  "We couldn't check this wallet's recent payments, so we can't confirm whether an earlier payment to this payee already went out. Check History before sending again.";
/**
 * A $name payment that went out on chain, but the payee's wallet host didn't confirm it received the payment details
 * (guardedSendBsv.ts 'delivery-failed:'). It must never read "Nothing was sent" (17c H2).
 */
export const DELIVERY_UNCONFIRMED_MESSAGE =
  "Your payment went out on chain, but the recipient's wallet service didn't confirm it received it. Don't send it again; check History.";
/** For a site's answer: the txid of another payment of this wallet is never shared (17b L1, privacy). */
export const withoutOwnTxids = (text: string): string => text.replace(/ \(tx [0-9a-f]{8,64}…?\)/gi, '');

export type SendErrorKind =
  | 'worker-restarted'
  | 'other-extension'
  | 'earlier-payment-out'
  | 'sent-unconfirmed'
  | 'spent-elsewhere'
  | 'insufficient-funds'
  | 'broadcast-failed'
  | 'broadcast-unknown'
  | 'network'
  | 'storage-full'
  | 'locked'
  | 'cancelled'
  | 'wallet-internal'
  | 'storage-remote-failing'
  | 'payment-refused'
  | 'unknown';

export interface SendErrorInfo {
  kind: SendErrorKind;
  /** One or two sentences: what happened, whether money moved, what to do. */
  message: string;
  moneyMoved: MoneyMoved;
  /** Technical text for support (raw error, code, stack top, txid). Shown only behind Details. */
  detail: string;
  txid?: string;
}

/** Chrome's own messaging errors when the background service worker never got the message. Nothing ran. */
export const NOT_DELIVERED =
  /Could not establish connection|Receiving end does not exist|Extension context invalidated|No SW|service worker.*(not|stopped)/i;
/** The worker got the message but died (or restarted) before it answered. It may have run. */
export const DIED_MID_CALL =
  /message port closed before a response|message channel closed before a response|A listener indicated an asynchronous response/i;

const TXID = /\b([0-9a-f]{64})\b/i;

const text = (e: unknown): string => {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  try {
    return JSON.stringify(e) ?? '';
  } catch {
    return String(e);
  }
};

/** Extra technical fields carried on an Error by the transport (code, background stack top). */
const extra = (e: unknown): string => {
  if (!e || typeof e !== 'object') return '';
  const o = e as { code?: unknown; name?: unknown; detail?: unknown };
  const bits: string[] = [];
  if (typeof o.code === 'string' && o.code) bits.push(`code ${o.code}`);
  if (typeof o.name === 'string' && o.name && o.name !== 'Error') bits.push(`name ${o.name}`);
  if (typeof o.detail === 'string' && o.detail) bits.push(o.detail);
  return bits.join('\n');
};

/**
 * Classify a send failure. `phase` is where it failed:
 * - 'before-sign': nothing was built or signed (e.g. the message never reached the wallet). Money cannot have moved.
 * - 'send': inside createAction/signAction (build, sign, broadcast). Money moved only if the broadcast went out.
 */
export function classifySendError(e: unknown, phase: 'before-sign' | 'send' = 'send'): SendErrorInfo {
  const raw = text(e).trim();
  const more = extra(e);
  const detail = [raw || '(no message)', more].filter(Boolean).join('\n');
  const txid = TXID.exec(raw)?.[1] ?? (e as { txid?: string } | null)?.txid;
  const make = (kind: SendErrorKind, message: string, moneyMoved: MoneyMoved): SendErrorInfo => ({
    kind,
    message,
    moneyMoved,
    detail,
    ...(txid ? { txid } : {}),
  });

  // A $name payment broadcast on chain whose delivery to the payee's host failed afterwards: it went out (17c H2). First,
  // so its "Failed to fetch" / "429" / "timed out" never reads as a network failure with "Nothing was sent".
  if (/delivery-failed:/i.test(raw)) return make('sent-unconfirmed', DELIVERY_UNCONFIRMED_MESSAGE, 'yes');

  if (/another wallet extension|OTHER_WALLET_EXTENSION/i.test(raw))
    return make(
      'other-extension',
      'Another wallet extension is answering requests in this browser. Nothing was sent. Turn off the other bWalletX (or other wallet) extensions in chrome://extensions, then try again.',
      'no',
    );

  if (NOT_DELIVERED.test(raw))
    return make(
      'worker-restarted',
      "The wallet's background service restarted before the payment started. Nothing was sent. Try again.",
      'no',
    );

  if (DIED_MID_CALL.test(raw))
    return phase === 'before-sign'
      ? make(
          'worker-restarted',
          "The wallet's background service restarted before the payment started. Nothing was sent. Try again.",
          'no',
        )
      : make(
          'worker-restarted',
          "The wallet's background service restarted in the middle of this payment, so we can't tell yet if it went out. Check History before you try again.",
          'unknown',
        );

  if (/wallet is locked|^locked$/i.test(raw))
    return make('locked', 'The wallet is locked. Nothing was sent. Unlock it and try again.', 'no');

  if (/denied by user|user denied|cancell?ed by (the )?user|USER_DENIED/i.test(raw))
    return make('cancelled', 'You cancelled the payment. Nothing was sent.', 'no');

  // The background's own sentences after a refusal or the coin check (services/spentRetry.ts, coinPreflight.ts).
  // Before the insufficient-funds and broadcast rules: they are specific.
  // A payment of ours to this payee already went out with this coin: say so with its short txid (the full one is in
  // `txid`, for Details).
  // Before the next rule: it also mentions "an earlier payment to this payee already went out", as a question (17d L3).
  if (/couldn't check this wallet's recent payments/i.test(raw))
    return make('earlier-payment-out', OWN_PAYMENTS_UNCHECKED_MESSAGE, 'unknown');
  if (/earlier payment to this payee already went out/i.test(raw))
    return make('earlier-payment-out', ownPaymentOutMessage(txid ? `${txid.slice(0, 8)}…` : undefined), 'yes');
  if (/an earlier payment from this wallet went out using a coin/i.test(raw))
    return make('earlier-payment-out', OWN_COIN_OTHER_PAYMENT_MESSAGE, 'unknown');
  if (/one of its coins was also used by another payment/i.test(raw))
    return make('broadcast-unknown', DOUBLE_SPEND_PENDING_MESSAGE, 'unknown');
  if (/comes from a payment the network can't find yet/i.test(raw))
    return make('broadcast-unknown', MISSING_PARENT_MESSAGE, 'unknown');
  if (/can't confirm whether this went out/i.test(raw))
    return make('broadcast-unknown', REFUSED_MAYBE_SENT_MESSAGE, 'unknown');
  // Refused by the wallet's own checks before anything was signed (guardedSendBsv.ts, paymailDestination.ts), or a
  // send-all to a paymail, which @1sat/actions refuses before building (17d L4: these never read "can't confirm").
  if (/^Payment refused: [\s\S]*Nothing was sent\.?$/i.test(raw)) return make('payment-refused', raw, 'no');
  if (/sendAllBsv does not support paymail/i.test(raw))
    return make(
      'payment-refused',
      "Send all can't go to a paymail or $name. Nothing was sent. Send a fixed amount, or send all to an address.",
      'no',
    );
  if (/already spent by another payment, so nothing was sent/i.test(raw))
    return make('broadcast-failed', REFUSED_NOT_SENT_MESSAGE, 'no');
  if (/couldn't update them/i.test(raw)) return make('spent-elsewhere', SPENT_ELSEWHERE_STUCK_MESSAGE, 'no');
  if (/already spent (?:on|from) another device|WERR_SPENT_ELSEWHERE/i.test(raw))
    return make(
      'spent-elsewhere',
      /isn't enough for this payment/i.test(raw) ? SPENT_ELSEWHERE_SHORT_MESSAGE : SPENT_ELSEWHERE_MESSAGE,
      'no',
    );

  // The background's own funding message already names both numbers: keep it whole.
  if (/^Insufficient funds:/i.test(raw)) return make('insufficient-funds', `${raw} Nothing was sent.`, 'no');
  if (/WERR_INSUFFICIENT_FUNDS|insufficient funds|not enough (funds|spendable)/i.test(raw)) {
    const need = /(\d[\d,]*)\s*(?:more )?sat(?:oshi)?s?\s*(?:needed|required|more)/i.exec(raw)?.[1];
    return make(
      'insufficient-funds',
      `Not enough spendable BSV for this payment${need ? ` (${need} more sats needed)` : ''}. Nothing was sent. Received coins may still be arriving: refresh, wait a minute, and try again.`,
      'no',
    );
  }

  if (/QUOTA_BYTES|QuotaExceeded|quota exceeded|storage is full/i.test(raw))
    return make(
      'storage-full',
      "The browser's storage for the wallet is full, so the payment could not be saved. Nothing was sent. Free some disk space, then try again.",
      'no',
    );

  // A bare double spend: ARC keeps the refused transaction and can still mine it (17b H1). Unknown, never "not sent".
  if (/double ?spend|DOUBLE_SPEND/i.test(raw))
    return make('broadcast-unknown', DOUBLE_SPEND_PENDING_MESSAGE, 'unknown');
  // A bare refusal: nothing here checked the chain, and a refusal can come for a transaction that already went out
  // (refusalRecheck.ts). Only the background's chain-checked REFUSED_NOT_SENT_MESSAGE says "not sent" (17b M1).
  if (
    (/rejected by the network|invalidTx|broadcaster said/i.test(raw) || /\bARC\b|REJECTED/.test(raw)) &&
    !/unknown|timed? ?out|serviceError|service error/i.test(raw)
  )
    return make('broadcast-unknown', REFUSED_MAYBE_SENT_MESSAGE, 'unknown');

  if (
    /serviceError|service error|broadcast.*(unavailable|unknown|timed? ?out)|WERR_BROADCAST_UNAVAILABLE|queued|pending/i.test(
      raw,
    )
  )
    return make(
      'broadcast-unknown',
      `Broadcast status unknown: the payment was signed but the network did not answer. Check History before you try again${txid ? `, txid ${txid}` : ''}.`,
      'unknown',
    );

  if (
    /Too Many Requests|\b429\b|Failed to fetch|NetworkError|network error|ECONNRESET|ETIMEDOUT|timed? ?out/i.test(raw)
  )
    return make(
      'network',
      'The wallet could not reach a Bitcoin service it needs to build this payment (busy or offline). Nothing was sent. Wait a minute and try again.',
      'no',
    );

  // The background's storage failover could not send from This device (services/storageFailover.ts): say which
  // storage is failing and offer the one-tap switch (SendErrorNotice).
  if (/WERR_STORAGE_REMOTE_FAILING|online storage \(.*\) is failing/i.test(raw))
    return make(
      'storage-remote-failing',
      "bWalletX's online storage (wallet.1sat.app) is failing for your account. Nothing was sent. Switch to This device in Settings › Storage, then try again.",
      'no',
    );

  // @bsv/wallet-toolbox WERR_INTERNAL: "An internal error has occurred." Usually thrown while building the payment
  // (coin data, proofs, the storage commit), but an online storage's processAction can answer it after it broadcast
  // (17d P1), so it never says "nothing was broadcast" (17d L4: it is `unknown`, and the Send page's note stays).
  if (/An internal error has occurred|WERR_INTERNAL/i.test(raw))
    return make(
      'wallet-internal',
      "The wallet couldn't finish this payment: it was missing data about one of your coins (usually a lookup to a Bitcoin data service that was busy). We can't confirm whether it went out, so check History before you try again in a minute. If it keeps failing and Settings › Storage shows an online storage as active, make This device active and try again; otherwise tap Details and send them to support.",
      'unknown',
    );

  return make(
    'unknown',
    phase === 'before-sign'
      ? 'The payment could not start. Nothing was sent. Try again; if it fails again, tap Details and send them to support.'
      : "The payment didn't complete and we can't confirm whether it went out. Check History before you try again. Tap Details for the technical reason.",
    phase === 'before-sign' ? 'no' : 'unknown',
  );
}
