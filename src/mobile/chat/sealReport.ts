/**
 * Telling b why a seal's payment failed (owner, 23 Nov 2026, instrument 1c377264: createAction threw something that was
 * classed as "may have paid", the seal was held, and the exact error was never captured).
 *
 * Whenever a native seal ends in pending_recovery or not_paid (nativeSeal.SealFailure), this builds one short report:
 * the createAction error's class (utils/sendErrors classifySendError: kind and moneyMoved), its name and message, cut
 * and scrubbed, the seal step, the app version and platform (errors/errorReport errorContext). It goes through the
 * existing "Report to b" path (agent/reportSend sendOrQueueReport: bit-sign's b_feedback, or the outbox when it can't
 * go now) and is logged with a stable prefix, SEAL_FAILURE_PREFIX, so it can be found in device logs.
 *
 * ⚠ NEVER IN A REPORT: keys, seeds, the BEEF, the attestation, txids or any long hex / base64 run. The text is scrubbed
 * here (hex runs of 16+ and base64-ish runs of 40+ removed, then redactSecrets) before it is cut, so a cut never leaves
 * half an id behind. Pure apart from the injected send / warn.
 */
import { classifySendError } from '../../utils/sendErrors';
import { errorContext, redactSecrets, type ErrorContext } from '../errors/errorReport';
import type { SealFailure } from './nativeSeal';

export const SEAL_FAILURE_PREFIX = '[seal-failure]';
/** The error message as reported, at most this many characters (after scrubbing). */
export const SEAL_REPORT_MESSAGE_MAX = 300;

/** What the on-screen check found after an unclear payment (nativeSeal.settleUnsureSeal). */
export type SealSettled = 'recorded' | 'not_paid' | 'unknown' | 'failed';

/** Scrub, then cut: hex (txids, keys, BEEF, attestations) and long base64-ish runs out, then the wallet's redaction. */
export const scrubSealText = (raw: string): string =>
  redactSecrets(
    raw
      .replace(/(?:0x)?[0-9a-f]{16,}/gi, '…')
      .replace(/[A-Za-z0-9+/_=-]{40,}/g, '…')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, SEAL_REPORT_MESSAGE_MAX);

const rawText = (e: unknown): string => {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e ?? '');
};

/** The facts reported for one failure, all scrubbed. */
export const sealFailureFacts = (f: SealFailure) => {
  const info = classifySendError(f.error, 'send');
  const name = f.error instanceof Error && f.error.name && f.error.name !== 'Error' ? f.error.name : '';
  const code = (f.error as { code?: unknown } | null)?.code;
  return {
    outcome: f.outcome,
    step: f.step,
    kind: info.kind,
    moneyMoved: info.moneyMoved,
    name: scrubSealText(name).slice(0, 60),
    code: typeof code === 'string' ? scrubSealText(code).slice(0, 60) : '',
    message: scrubSealText(rawText(f.error)) || '(no message)',
  };
};

/** The report text (one line per fact; b's feedback log keeps it whole). */
export const sealFailureReportText = (
  f: SealFailure,
  ctx: ErrorContext = errorContext(),
  settled?: SealSettled,
): string => {
  const x = sealFailureFacts(f);
  return [
    `Seal payment failure: native seal ended ${x.outcome}${settled ? ` (on-screen check: ${settled})` : ''}.`,
    `Step: ${x.step}`,
    `createAction error: kind ${x.kind} · moneyMoved ${x.moneyMoved}${x.name ? ` · ${x.name}` : ''}${x.code ? ` · code ${x.code}` : ''}`,
    `Message: ${x.message}`,
    [
      ctx.version && `Version: ${ctx.version}`,
      ctx.channel && `Platform: ${ctx.channel}`,
      ctx.edition && `Edition: ${ctx.edition}`,
      ctx.time && `Time: ${ctx.time}`,
    ]
      .filter(Boolean)
      .map((s) => redactSecrets(String(s)))
      .join(' · '),
  ]
    .filter(Boolean)
    .join('\n');
};

/**
 * Log and report one seal failure. Never throws and never waits: the seal's screen goes on whatever the report does.
 * `send` is the existing report path (the page passes sendOrQueueReport); `warn` is console.warn.
 */
export function reportSealFailure(
  f: SealFailure,
  deps: {
    send: (text: string) => unknown;
    ctx?: ErrorContext;
    warn?: (...a: unknown[]) => void;
    settled?: SealSettled;
  },
): void {
  try {
    const x = sealFailureFacts(f);
    (deps.warn ?? console.warn)(
      SEAL_FAILURE_PREFIX,
      `${x.outcome}${deps.settled ? `/${deps.settled}` : ''} step=${x.step} kind=${x.kind} moneyMoved=${x.moneyMoved}: ${x.message}`,
    );
    void Promise.resolve()
      .then(() => deps.send(sealFailureReportText(f, deps.ctx ?? errorContext(), deps.settled)))
      .catch(() => undefined);
  } catch {
    /* a report never changes the seal */
  }
}
