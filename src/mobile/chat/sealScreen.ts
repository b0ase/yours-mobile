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
import { NativeSealError, type PadPoint, type SealStep } from './nativeSeal';

export const DRAW_HINT = 'Draw your signature';
export const SIGNED_LINE = 'Signed ✓';
/** Exact wording while the payment is being broadcast (CEO, 3 Nov 2026: it must never look stuck). */
export const BROADCASTING_LINE = 'Broadcasting… (can take a minute)';
export const ON_CHAIN_LINE = 'On chain ✓';
/** The coin check started when the pad opened is still running when he presses. */
export const FRESH_COIN_LINE = 'Finding a fresh coin…';
export const WAITING_NETWORK_LINE = 'Waiting for the network…';
/** The commit counts as slow (and says so) after this long. */
export const SLOW_COMMIT_MS = 10_000;

const satsWord = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'sat' : 'sats'}`;

/** The one button: "Sign & seal · ~72 sats" ("Sign & seal" while the cost is unknown). */
export const sealButtonLabel = (feeSats: number | null): string =>
  feeSats ? `Sign & seal · ~${satsWord(feeSats)}` : 'Sign & seal';

const varintLen = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
const pushLen = (n: number) => (n < 0x4c ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5);

/**
 * The seal transaction's size in bytes, as the wallet will build it: one P2PKH input (148), the 0-sat
 * OP_FALSE OP_RETURN <payload JSON> output (bit-sign seal-inscription.ts sealLockingScriptHex over the v2 payload of
 * nds-seal-record.ts buildSealPayloadV2), and one P2PKH change output (34). Every hash in the payload has a fixed
 * length, so only the field ids and the reference change it.
 */
export const sealTxBytes = (fieldIds: string[], ref: string): number => {
  const h = '0'.repeat(64);
  const payload = {
    protocol: 'b0ase-bitsign',
    version: '2.0',
    type: 'nds_field_seal',
    docHash: h,
    origHash: h,
    recordHash: h,
    svgHash: h,
    fields: fieldIds.join(','),
    key: `02${h}`,
    ref,
    ts: '2026-01-01T00:00:00.000Z',
  };
  const data = new TextEncoder().encode(JSON.stringify(payload)).length;
  const script = 2 + pushLen(data) + data; // OP_FALSE OP_RETURN <push>
  const opReturnOut = 8 + varintLen(script) + script;
  return 4 + 1 + 148 + 1 + opReturnOut + 34 + 4; // version, ins, P2PKH in, outs, OP_RETURN, change, locktime
};

/**
 * The seal's network fee by the wallet's OWN fee model: the sat/kB rate its createAction pays (the toolbox feeModel,
 * ChromeStorage getCustomFeeRate, 100 sat/kB by default) × the expected size, rounded up. Owner, 3 Nov 2026: the
 * button said ~715 sats (bit-sign's 1 sat/byte cap) and the seal paid 75. bit-sign's estimateSealFeeSats is only
 * logged now, never shown.
 */
export const estimateSealFee = (fieldIds: string[], ref: string, satsPerKb: number): number => {
  const rate = Number.isFinite(satsPerKb) && satsPerKb > 0 ? satsPerKb : 100;
  return Math.max(1, Math.ceil((sealTxBytes(fieldIds, ref) * rate) / 1000));
};

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
      return [{ text: FRESH_COIN_LINE, done: false }];
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
  if (error instanceof NativeSealError && (error.code === 'pending_recovery' || error.code === 'failed')) return false;
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
