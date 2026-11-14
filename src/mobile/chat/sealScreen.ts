/**
 * The native seal screen's words and rules (owner, 3 Nov 2026: "Finishing the signature IS sealing it").
 *
 *   1. Draw.
 *   2. One tap: "Sign & seal · ~N sats" (disabled until something is drawn: "Draw your signature").
 *   3. EVERY time, the wallet's payment approval sheet (SealPaySheet.tsx), then Face ID / passcode, or the wallet
 *      password when the phone has neither (sealApproval.ts). Never skipped by a spending limit or allowance.
 *   4. Approving it IS the seal: "Signed ✓ → Broadcasting… (can take a minute) → On chain ✓", then the receipt.
 *
 * Pure (no React, no wallet) so sealScreen.test.ts can pin every label and rule.
 */
import { fmtDollars, satsToUsd } from '../../utils/dollarsFirst';
import {
  ALREADY_SEALED_MESSAGE,
  MAY_HAVE_PAID_MESSAGE,
  NativeSealError,
  type PadPoint,
  type SealHere,
  type SealStep,
} from './nativeSeal';

export const DRAW_HINT = 'Draw your signature';
export const SIGNED_LINE = 'Signed ✓';
/** Exact wording while the payment is being broadcast (CEO, 3 Nov 2026: it must never look stuck). */
export const BROADCASTING_LINE = 'Broadcasting… (can take a minute)';
export const ON_CHAIN_LINE = 'On chain ✓';
/** The coin check started when the pad opened is still running when he presses. */
export const FRESH_COIN_LINE = 'Finding a fresh coin…';
/** Under FRESH_COIN_LINE once the coin wait passes 2 s (chat/coinWait.ts); it moves on by itself at the cap. */
export const COIN_SLOW_LINE = 'Checking your coins — this can take a few seconds after the app wakes';
export const WAITING_NETWORK_LINE = 'Waiting for the network…';
/** A payment from this phone for this seal is saved and being recorded (recovery runs on open). */
export const RECORDING_LINE = 'Paid, being recorded…';
/** A seal of this document by this account is running in this app right now (a page left while it paid). */
export const IN_FLIGHT_LINE = 'Sealing now… it finishes on its own.';
/** Recovery ended and the payment is still not recorded: kept on the phone for the next open. */
export const STILL_RECORDING_LINE =
  'Paid, still being recorded. It is saved on this phone and finishes the next time you open this document.';

/**
 * What the screen shows on open for what this device knows about the seal (nativeSeal.sealStateHere), before and
 * after recovery: null = the pad. 'sealed' is only a hint; the server's already_sealed is the authority.
 */
export const openingNotice = (state: SealHere, recovered: boolean): { text: string; busy: boolean } | null => {
  switch (state) {
    case 'sealed':
      return { text: ALREADY_SEALED_MESSAGE, busy: false };
    case 'recording':
      return recovered ? { text: STILL_RECORDING_LINE, busy: false } : { text: RECORDING_LINE, busy: true };
    case 'in_flight':
      return { text: IN_FLIGHT_LINE, busy: true };
    case 'unsure':
      return { text: MAY_HAVE_PAID_MESSAGE, busy: false };
    case 'none':
      return null;
  }
};

/** The commit counts as slow (and says so) after this long. */
export const SLOW_COMMIT_MS = 10_000;

const satsWord = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'sat' : 'sats'}`;

/** The one button: "Sign & seal · ~72 sats" ("Sign & seal" while the cost is unknown). */
export const sealButtonLabel = (feeSats: number | null): string =>
  feeSats ? `Sign & seal · ~${satsWord(feeSats)}` : 'Sign & seal';

export { estimateSealFee, sealTxBytes } from './sealFee';

/**
 * The name the account is shown as now, from bit-sign GET /api/public/handles/primary?h=<handle>
 * ({ primary: { b0asex: "boase" } }: only names that differ are listed). Falls back to the session handle. Pure.
 */
export const primaryHandleFrom = (resp: unknown, handle: string): string => {
  const h = handle.trim().replace(/^\$/, '').toLowerCase();
  const map = (resp as { primary?: unknown } | null)?.primary;
  const v = map && typeof map === 'object' ? (map as Record<string, unknown>)[h] : undefined;
  return typeof v === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(v.replace(/^\$/, ''))
    ? v.replace(/^\$/, '').toLowerCase()
    : h;
};

/** Enough ink to be a signature: a stray tap or a short flick keeps the button disabled. */
export const MIN_INK_PX = 40;
export const padHasSignature = (strokes: PadPoint[][]): boolean => {
  let ink = 0;
  for (const s of strokes)
    for (let i = 1; i < s.length; i++) ink += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return ink >= MIN_INK_PX;
};

export type ProgressLine = { text: string; done: boolean };
export type SealProgress = SealStep | 'done';

/** The inline lines under the button for each step. Long waits always say what is happening. */
export const sealProgress = (step: SealProgress, slow = false): ProgressLine[] => {
  const signed = { text: SIGNED_LINE, done: true };
  const onChain = { text: ON_CHAIN_LINE, done: true };
  switch (step) {
    case 'preparing':
      return [{ text: 'Getting the seal ready…', done: false }];
    case 'approving':
      return [{ text: 'Waiting for your approval…', done: false }];
    case 'healing':
      return slow
        ? [
            { text: FRESH_COIN_LINE, done: false },
            { text: COIN_SLOW_LINE, done: false },
          ]
        : [{ text: FRESH_COIN_LINE, done: false }];
    case 'composing':
    case 'signing':
      return [{ text: 'Signing…', done: false }];
    case 'paying':
      return [signed, { text: BROADCASTING_LINE, done: false }];
    case 'committing':
      return [signed, onChain, { text: slow ? WAITING_NETWORK_LINE : 'Recording the seal…', done: false }];
    case 'recovering':
      return [signed, onChain, { text: WAITING_NETWORK_LINE, done: false }];
    case 'done':
      return [signed, onChain];
  }
};

/**
 * May the button come back after this failure? Only when the code KNOWS nothing was paid: the failure came before the
 * payment step started (prepare / approval / compose / sign), or the payment itself was refused because a coin was
 * already spent (nativeSeal: createAction threw, nothing broadcast, nothing saved). Anything during or after the
 * payment may have moved money: no button; the saved seal is finished by recovery when the document is reopened.
 */
export const retryAllowed = (error: unknown, reachedPay: boolean): boolean => {
  if (error instanceof NativeSealError && error.code === 'spent_elsewhere') return true;
  // The wallet proved nothing went out (and the nonce was cancelled): a clean retry.
  if (error instanceof NativeSealError && error.code === 'not_paid') return true;
  // Sealed already (on this device, or the server says so): never a second seal, so never the button again.
  if (error instanceof NativeSealError && error.code === 'already_sealed') return false;
  // This version is out of date (signer_race): the page offers the latest version instead of the same button.
  if (error instanceof NativeSealError && error.code === 'newer_version') return false;
  if (
    error instanceof NativeSealError &&
    (error.code === 'pending_recovery' || error.code === 'failed' || error.code === 'orphaned')
  )
    return false;
  return !reachedPay;
};

/** What the approval sheet shows (SealPaySheet.tsx). */
export interface SealSheetInfo {
  /** "Minute 011". */
  title: string;
  /** Room ticker without the $. */
  ticker: string;
  /** First 8 hex of the document's hash. */
  docHash: string;
  /** The paying handle without the $. */
  handle: string;
  feeSats: number | null;
  blocks: number;
}

/** The Face ID / passcode / password reason: what is sealed and what it costs. */
export const sealReason = (info: Pick<SealSheetInfo, 'title' | 'feeSats'>): string =>
  info.feeSats
    ? `Seal ${info.title} on Bitcoin and pay about ${satsWord(info.feeSats)}`
    : `Seal ${info.title} on Bitcoin and pay the network fee`;

/** "0.0038¢" / "4¢" (the sheets' own dollars-first format); null without a price. */
const cents = (sats: number, usdPerBsv: number | null): string | null =>
  usdPerBsv && usdPerBsv > 0 ? fmtDollars(satsToUsd(sats, usdPerBsv)) : null;

/**
 * The done-state receipt: "Paid 75 sats (~0.004¢) from $b0asex's wallet · 3f2a…91c0". The actual fee from the
 * transaction when the wallet returned it, otherwise the estimate, labelled "about".
 */
export const sealReceipt = (p: {
  actualFeeSats: number | null | undefined;
  estFeeSats: number | null;
  handle: string;
  txid: string;
  usdPerBsv: number | null;
}): string => {
  const actual = typeof p.actualFeeSats === 'number' && p.actualFeeSats >= 0 ? p.actualFeeSats : null;
  const sats = actual ?? p.estFeeSats;
  const short = p.txid ? `${p.txid.slice(0, 4)}…${p.txid.slice(-4)}` : '';
  const who = p.handle ? ` from $${p.handle.replace(/^\$/, '')}'s wallet` : '';
  if (sats == null) return `Paid the network fee${who}${short ? ` · ${short}` : ''}`;
  const c = cents(sats, p.usdPerBsv);
  const amount = `${actual == null ? 'about ' : ''}${satsWord(sats)}${c ? ` (~${c})` : ''}`;
  return `Paid ${amount}${who}${short ? ` · ${short}` : ''}`;
};

/**
 * The double press / double pay guard: the first press takes it (synchronously, before any await) and every later
 * press is ignored until `release()`, which the page calls ONLY when retryAllowed says nothing was paid.
 */
export const createPressGuard = () => {
  let held = false;
  return {
    take: (): boolean => (held ? false : (held = true)),
    release: (): void => {
      held = false;
    },
    held: (): boolean => held,
  };
};
