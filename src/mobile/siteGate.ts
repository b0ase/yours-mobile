/**
 * Biometric confirmation for site requests (owner, 29 Oct 2026; docs/BIOMETRIC-GATE.md).
 *
 * When a site asks the phone wallet to sign (BRC-100 createSignature, e.g. the bChatX contract seal) or to pay
 * (createAction / signAction), the phone asks Face ID / fingerprint, falling back to the device passcode, before
 * the request reaches the wallet. Biometric data never leaves the device: the OS answers yes or no.
 *
 * - One prompt per user action: a pass covers the same site's signs for GRACE_MS and at most ONE payment after it
 *   (sign-and-seal = createSignature + createAction = one prompt). Every payment after a payment asks again.
 *   Calls from one origin are checked one at a time, in order.
 * - Cancel → the standard denial (ERR_PERMISSION_DENIED). No answer within timeoutMs → ERR_USER_VERIFICATION_TIMEOUT.
 * - No biometrics and no passcode, or the setting off → no prompt (the wallet's own approval sheets still apply);
 *   recorded as verifiedBy 'none'.
 * - getLastVerification(origin): the origin's most recent gated call, non-secret, for the site to show.
 *
 * Pure: the native prompt, clock and timers come in as deps so it can be unit-tested.
 */
import { userDeniedError } from '../services/userDenied';

export type VerifiedBy = 'biometric' | 'passcode' | 'password' | 'none';
export type GatedCall = 'createSignature' | 'createAction' | 'confirmUser';
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

/**
 * Non-standard call a site makes to ask the SAME gate before an act that is not itself a wallet call: the bChatX
 * Sign sheet (a drawn signature) and Seal sheet (owner, 30 Oct 2026). Gated as a sign; it reaches no wallet code and
 * returns only `{ verifiedBy }`. One pass still covers the seal's createSignature + createAction that follow.
 */
export const CONFIRM_USER_CALL = 'confirmUser';

/** Which calls are gated, as what. signAction finishes a payment createAction started, so it counts as paying. */
export const gateFor = (call: string): { kind: GateKind; call: GatedCall } | null => {
  if (call === 'createSignature') return { kind: 'sign', call: 'createSignature' };
  if (call === CONFIRM_USER_CALL) return { kind: 'sign', call: 'confirmUser' };
  if (call === 'createAction' || call === 'signAction') return { kind: 'pay', call: 'createAction' };
  return null;
};

export type GateDeps = {
  /** Settings › Security "Face ID / fingerprint for signing and payments" (and a native shell to ask). */
  enabled: () => boolean;
  /** The OS prompt. `host` is shown where the platform has room (Android subtitle). */
  auth: (reason: string, host: string) => Promise<AuthResult>;
  /**
   * The fallback when the phone has no biometrics AND no passcode, or its prompt fails: the wallet password.
   * Resolves true (right password), false (cancelled or wrong). Never skipped silently: with this dep present, an
   * unavailable OS prompt asks for the password instead of passing as 'none' (owner, 30 Oct 2026).
   */
  passwordAuth?: (reason: string, host: string) => Promise<boolean>;
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
  // payUsed: a payment already rode on this pass; the next payment asks again (owner, 29 Oct 2026).
  const passes = new Map<string, { method: Exclude<VerifiedBy, 'none'>; until: number; payUsed: boolean }>();
  // One gated call per origin at a time, so each one sees the pass the previous one left.
  const queue = new Map<string, Promise<unknown>>();

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
              if (r.status === 'ok') resolve(r.method);
              else if (r.status === 'cancelled') reject(userDeniedError());
              else fallback();
            }),
          // A broken native call is treated like no biometrics: the password fallback (or, with none wired, today's
          // approval sheets) guards the request.
          () => finish(fallback),
        );
      function fallback() {
        if (!deps.passwordAuth) return resolve('none');
        // The password sheet is the user's answer: still inside the same time limit.
        done = false;
        const h2 = setTimer(() => {
          if (done) return;
          done = true;
          reject(timeoutError());
        }, timeoutMs);
        deps.passwordAuth(GATE_REASON[kind], hostOf(origin)).then(
          (ok) => {
            if (done) return;
            done = true;
            clearTimer(h2);
            if (ok) resolve('password');
            else reject(userDeniedError());
          },
          () => {
            if (done) return;
            done = true;
            clearTimer(h2);
            reject(userDeniedError());
          },
        );
      }
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
      const run = async (): Promise<VerifiedBy> => {
        const pass = passes.get(origin);
        // A pass covers signs, and at most one payment (sign → seal). Every later payment asks again.
        if (pass && pass.until > now() && (g.kind === 'sign' || !pass.payUsed)) {
          if (g.kind === 'pay') pass.payUsed = true;
          return pass.method;
        }
        const m = await ask(origin, g.kind);
        if (m !== 'none') passes.set(origin, { method: m, until: now() + graceMs, payUsed: g.kind === 'pay' });
        return m;
      };
      const p = (queue.get(origin) ?? Promise.resolve()).catch(() => undefined).then(run);
      queue.set(origin, p);
      void p
        .catch(() => undefined)
        .finally(() => {
          if (queue.get(origin) === p) queue.delete(origin);
        });
      verifiedBy = await p;
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
