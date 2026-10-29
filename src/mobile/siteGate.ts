/**
 * Biometric confirmation for site requests (owner, 29 Oct 2026; docs/BIOMETRIC-GATE.md).
 *
 * When a site asks the phone wallet to sign (BRC-100 createSignature, e.g. the bChatX contract seal) or to pay
 * (createAction / signAction), the phone asks Face ID / fingerprint, falling back to the device passcode, before
 * the request reaches the wallet. Biometric data never leaves the device: the OS answers yes or no.
 *
 * - One prompt per user action: a pass covers the same site for GRACE_MS, and calls that arrive while a prompt is
 *   up join it (sign-and-seal = createSignature + createAction = one prompt).
 * - Cancel → the standard denial (ERR_PERMISSION_DENIED). No answer within timeoutMs → ERR_USER_VERIFICATION_TIMEOUT.
 * - No biometrics and no passcode, or the setting off → no prompt (the wallet's own approval sheets still apply);
 *   recorded as verifiedBy 'none'.
 * - getLastVerification(origin): the origin's most recent gated call, non-secret, for the site to show.
 *
 * Pure: the native prompt, clock and timers come in as deps so it can be unit-tested.
 */
import { userDeniedError } from '../services/userDenied';

export type VerifiedBy = 'biometric' | 'passcode' | 'none';
export type GatedCall = 'createSignature' | 'createAction';
export type GateKind = 'sign' | 'pay';
export type LastVerification = { verifiedBy: VerifiedBy; at: string; call: GatedCall };

export type AuthResult =
  | { status: 'ok'; method: 'biometric' | 'passcode' }
  | { status: 'cancelled' }
  | { status: 'unavailable' };

export const GATE_REASON: Record<GateKind, string> = {
  sign: "Confirm it's you to sign",
  pay: "Confirm it's you to pay",
};

/** A pass covers the same site's follow-on calls for this long (one user action, e.g. sign then seal). */
export const GRACE_MS = 30_000;
/** The system prompt must be answered within this long. */
export const VERIFY_TIMEOUT_MS = 60_000;

export const VERIFICATION_TIMEOUT_CODE = 'ERR_USER_VERIFICATION_TIMEOUT';
export const VERIFICATION_TIMEOUT_MESSAGE = "bWalletX didn't get a Face ID, fingerprint or passcode answer in time.";

/** Which calls are gated, as what. signAction finishes a payment createAction started, so it counts as paying. */
export const gateFor = (call: string): { kind: GateKind; call: GatedCall } | null => {
  if (call === 'createSignature') return { kind: 'sign', call: 'createSignature' };
  if (call === 'createAction' || call === 'signAction') return { kind: 'pay', call: 'createAction' };
  return null;
};

export type GateDeps = {
  /** Settings › Security "Face ID / fingerprint for signing and payments" (and a native shell to ask). */
  enabled: () => boolean;
  /** The OS prompt. `host` is shown where the platform has room (Android subtitle). */
  auth: (reason: string, host: string) => Promise<AuthResult>;
  now?: () => number;
  timeoutMs?: number;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
};

const timeoutError = () =>
  Object.assign(new Error(VERIFICATION_TIMEOUT_MESSAGE), { code: VERIFICATION_TIMEOUT_CODE, status: 408 });

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const createSiteGate = (deps: GateDeps) => {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const graceMs = deps.graceMs ?? GRACE_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const last = new Map<string, LastVerification>();
  const passes = new Map<string, { method: 'biometric' | 'passcode'; until: number }>();
  const inFlight = new Map<string, Promise<VerifiedBy>>();

  const ask = (origin: string, kind: GateKind): Promise<VerifiedBy> =>
    new Promise<VerifiedBy>((resolve, reject) => {
      let done = false;
      const h = setTimer(() => {
        if (done) return;
        done = true;
        reject(timeoutError());
      }, timeoutMs);
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimer(h);
        fn();
      };
      Promise.resolve()
        .then(() => deps.auth(GATE_REASON[kind], hostOf(origin)))
        .then(
          (r) =>
            finish(() => {
              if (r.status === 'ok') {
                passes.set(origin, { method: r.method, until: now() + graceMs });
                resolve(r.method);
              } else if (r.status === 'cancelled') reject(userDeniedError());
              else resolve('none');
            }),
          // A broken native call is treated like no biometrics: today's approval sheets still guard the request.
          () => finish(() => resolve('none')),
        );
    });

  /**
   * Resolves with how the user was verified (or null for an ungated call); rejects with the denial or the timeout
   * error. Never hangs: the prompt is capped at timeoutMs.
   */
  const check = async (origin: string, call: string): Promise<VerifiedBy | null> => {
    const g = gateFor(call);
    if (!g) return null;
    let verifiedBy: VerifiedBy;
    if (!deps.enabled()) verifiedBy = 'none';
    else {
      const pass = passes.get(origin);
      if (pass && pass.until > now()) verifiedBy = pass.method;
      else {
        let p = inFlight.get(origin);
        if (!p) {
          p = ask(origin, g.kind).finally(() => inFlight.delete(origin));
          inFlight.set(origin, p);
        }
        verifiedBy = await p;
      }
    }
    last.set(origin, { verifiedBy, at: new Date(now()).toISOString(), call: g.call });
    return verifiedBy;
  };

  return {
    check,
    lastVerification: (origin: string): LastVerification | null => last.get(origin) ?? null,
    /** Lock / account switch: the next request asks again. */
    clearPasses: () => passes.clear(),
  };
};

export type SiteGate = ReturnType<typeof createSiteGate>;

/** Non-standard wallet call a site makes to read its last verification (window.CWI.getLastVerification()). */
export const LAST_VERIFICATION_CALL = 'getLastVerification';

/** Hard ceilings so a site's call always settles (docs/BIOMETRIC-GATE.md). Pay calls get longer: build + broadcast. */
export const SITE_CALL_TIMEOUT_MS = 120_000;
export const SITE_PAY_TIMEOUT_MS = 300_000;
export const siteCallTimeoutFor = (call: string) =>
  call === 'createAction' || call === 'signAction' ? SITE_PAY_TIMEOUT_MS : SITE_CALL_TIMEOUT_MS;

export const SITE_CALL_TIMEOUT_CODE = 'ERR_WALLET_TIMEOUT';
export const SITE_CALL_TIMEOUT_MESSAGE =
  "bWalletX didn't answer this request in time. Check History in your wallet before you try again.";

/** Settle `work` within `ms`: a late answer is dropped (never unhandled), the caller gets the timeout reply. */
export const withSiteCeiling = <T>(
  work: Promise<T>,
  ms: number,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, m) => setTimeout(fn, m),
  clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): Promise<T | { success: false; error: string; code: string; status: number }> =>
  new Promise((resolve, reject) => {
    let done = false;
    const h = setTimer(() => {
      if (done) return;
      done = true;
      resolve({ success: false, error: SITE_CALL_TIMEOUT_MESSAGE, code: SITE_CALL_TIMEOUT_CODE, status: 504 });
    }, ms);
    work.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimer(h);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimer(h);
        reject(e);
      },
    );
  });
