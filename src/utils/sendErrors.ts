/**
 * Send errors in words a person can act on (owner, 28 Oct 2026: a $2 send twice showed only "That didn't work: An
 * internal error has occurred." — "we can't have generic errors in such a critical operation").
 *
 * Every class says what happened, whether money moved, and what to do. The raw text is never shown on its own: it
 * goes in `detail`, behind a Details button with Copy, for support.
 *
 * Pure: no chrome, no React. Tested in sendErrors.test.ts.
 */

export type MoneyMoved = 'no' | 'unknown';

export type SendErrorKind =
  | 'worker-restarted'
  | 'other-extension'
  | 'insufficient-funds'
  | 'broadcast-failed'
  | 'broadcast-unknown'
  | 'network'
  | 'storage-full'
  | 'locked'
  | 'cancelled'
  | 'wallet-internal'
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

  if (
    (/double spend|doubleSpend|rejected by the network|invalidTx|broadcaster said/i.test(raw) ||
      /\bARC\b|REJECTED/.test(raw)) &&
    !/unknown|timed? ?out|serviceError|service error/i.test(raw)
  ) {
    const reason =
      /broadcaster said:\s*([^.\n]+)/i.exec(raw)?.[1] ??
      /(double spend[^;.\n]*|rejected by the network as invalid)/i.exec(raw)?.[1] ??
      raw.slice(0, 160);
    return make(
      'broadcast-failed',
      `Broadcast failed: ${reason}. Your coins are unchanged. Refresh, then try again.`,
      'no',
    );
  }

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

  // @bsv/wallet-toolbox WERR_INTERNAL: "An internal error has occurred." It is thrown while building the payment
  // (coin data, proofs, the storage commit), before the broadcast. See PR notes for the throw sites.
  if (/An internal error has occurred|WERR_INTERNAL/i.test(raw))
    return make(
      'wallet-internal',
      "The wallet couldn't build this payment: it was missing data about one of your coins (usually a lookup to a Bitcoin data service that was busy). Nothing was broadcast. Check History once, then try again in a minute; if it fails again, tap Details and send them to support.",
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
