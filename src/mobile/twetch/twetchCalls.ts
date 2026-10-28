/**
 * twetch.* calls from a paired site (bChatX "Post to Twetch"), routed by pair/sessions.ts like bitsign.*:
 *
 * Also reachable from the Chrome extension (window.CWI.twetch.*, services/twetchSite.ts), same rules.
 *
 * - `twetch.status()` → `{ linked, handle?, userId?, publicKey? }`. Read-only, no sheet.
 * - `twetch.loginSign({ challenge })` → `{ signature, publicKey, address }`. BSM signature (compact, base64) by the
 *   Twetch key over Twetch's login challenge, and only that: `twetch-login:<64 hex>:<ms>` stamped within 10 minutes.
 *   "Sign in to Twetch as @name?" shows the first time per site; after that it signs without a sheet.
 * - `twetch.buildPost({ text, replyTxid?, files? })` → `{ txHex, txid, fee }` (fee = miner fee in sats, inputs − outputs). B | MAP | AIP output signed by the Twetch
 *   key, funded from the wallet's BSV through createAction with noSend. Every post shows a sheet (text + fee). The
 *   SITE submits it to Twetch's API and broadcasts it; the wallet never does.
 *
 * - `twetch.signRequest({ method, path, userId, ts, body })` → `{ signature }`. Twetch's API request signature
 *   (headers x-twetch-user / x-twetch-ts / x-twetch-sig) for submitting the post the user just approved: BSM
 *   (compact, base64) by the Twetch key over `${method}\n${path}\n${userId}\n${ts}\n${body}`, a string the wallet
 *   builds itself from the checked fields (a caller's `message` is never signed). Only POST /v1/posts, only with a
 *   body that carries exactly the txHex and text of this origin's last buildPost (see signRequest.ts).
 *
 * Unsent rules (services/unsentGuard.ts): a declined or failed build is aborted before the rawtx leaves the phone.
 * Once txHex is handed to the site it may be broadcast at any time, so the action is never aborted after that: it
 * stays nosend (change spendable) and settleWhenSeen hands it to the wallet's send path when the chain has it.
 */
import { Transaction, Utils } from '@bsv/sdk';
import { USER_DENIED_CODE, USER_DENIED_MESSAGE } from '../../services/userDenied';
import { settleWhenSeen, type UnsentWallet } from '../../services/unsentGuard';
import { TWETCH_POST_ENABLED } from '../storeBuild';
import { TwetchKeyMismatch, twetchHandle, type TwetchStore } from './twetchLink';
import {
  bsmSign,
  buildPostScript,
  feeLabel,
  loginTitle,
  postTitle,
  previewText,
  signChallenge,
  validateChallenge,
  validatePostParams,
} from './twetchPost';

import { TWETCH_LOGIN, TWETCH_POST, TWETCH_SIGN_REQUEST, TWETCH_STATUS } from './twetchAction';
import { rememberBuilt, signRequestString, validateSignRequest } from './signRequest';

export { TWETCH_LOGIN, TWETCH_POST, TWETCH_SIGN_REQUEST, TWETCH_STATUS, isTwetchAction } from './twetchAction';

export const BAD_REQUEST_CODE = 'INVALID_PARAMS';
export const NOT_LINKED_CODE = 'TWETCH_NOT_LINKED';
export const KEY_MISMATCH_CODE = 'TWETCH_KEY_MISMATCH';
export const DISABLED_CODE = 'NOT_SUPPORTED';

/** What the sheet shows. `kind: 'login'` has no text / fee. */
export type TwetchAsk =
  | { kind: 'login'; host: string; handle: string; proven: boolean }
  | { kind: 'post'; host: string; handle: string; proven: boolean; preview: string; reply: boolean; fee: string };

type CreateActionResult = { tx?: number[]; txid?: string };
export type TwetchWallet = {
  createAction: (a: never) => Promise<CreateActionResult>;
  abortAction: (a: { reference: string }) => Promise<unknown>;
};

export type TwetchDeps = {
  store: TwetchStore | undefined;
  wallet: TwetchWallet | undefined;
  bsvUsd: () => Promise<number>;
  proven: boolean;
  ask?: (a: TwetchAsk) => Promise<boolean>;
  /** Background watch after hand-off (tests replace it). */
  settle?: (wallet: TwetchWallet, txid: string) => void;
  now?: () => number;
  enabled?: boolean;
};

export type TwetchReply = { result: unknown } | { error: { code: string; message: string } };

const err = (code: string, message: string): TwetchReply => ({ error: { code, message } });
const LOCKED = err('LOCKED', 'bWalletX is locked. Unlock it and try again.');
const NOT_LINKED = err(NOT_LINKED_CODE, 'Link your Twetch account in bWalletX first (Settings › Twetch).');
const DENIED = err(USER_DENIED_CODE, USER_DENIED_MESSAGE);

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/* ---------- the sheet queue (TwetchHost shows it) ---------- */

type Pending = { ask: TwetchAsk; resolve: (ok: boolean) => void };
let pending: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export const askTwetch = (ask: TwetchAsk): Promise<boolean> =>
  new Promise((resolve) => {
    pending.push({ ask, resolve });
    emit();
  });
export const currentTwetchAsk = (): TwetchAsk | null => pending[0]?.ask ?? null;
export const answerTwetch = (ok: boolean) => {
  const [p, ...rest] = pending;
  if (!p) return;
  pending = rest;
  p.resolve(ok);
  emit();
};
export const onTwetchAsk = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

const defaultSettle = (wallet: TwetchWallet, txid: string) =>
  void settleWhenSeen(wallet as unknown as UnsentWallet, txid).catch(() => undefined);

/** Handle one twetch.* call from a paired site whose verified origin is `origin`. */
export async function handleTwetchCall(
  action: string,
  params: unknown,
  origin: string,
  deps: TwetchDeps,
): Promise<TwetchReply> {
  if (!(deps.enabled ?? TWETCH_POST_ENABLED)) return err(DISABLED_CODE, 'Twetch posting is not available here.');
  const link = deps.store?.link();
  if (action === TWETCH_STATUS)
    return {
      result: link
        ? { linked: true, handle: link.name || undefined, userId: link.userId, publicKey: link.publicKey }
        : { linked: false },
    };
  if (!deps.store) return LOCKED;
  const ask = deps.ask ?? askTwetch;
  const host = hostOf(origin);
  try {
    if (action === TWETCH_LOGIN) {
      const v = validateChallenge(params, deps.now?.() ?? Date.now());
      if (typeof v === 'string') return err(BAD_REQUEST_CODE, v);
      if (!link) return NOT_LINKED;
      const key = await deps.store.key(); // refuses on a key / account mismatch
      if (!link.loginSites?.includes(origin)) {
        if (!(await ask({ kind: 'login', host, handle: twetchHandle(link), proven: deps.proven }))) return DENIED;
        await deps.store.addLoginSite(origin);
      }
      const pub = key.toPublicKey();
      return {
        result: { signature: signChallenge(v.challenge, key), publicKey: pub.toString(), address: pub.toAddress() },
      };
    }
    if (action === TWETCH_SIGN_REQUEST) {
      if (!link) return NOT_LINKED;
      const v = validateSignRequest(params, origin, link.userId, deps.now?.() ?? Date.now());
      if (typeof v === 'string') return err(BAD_REQUEST_CODE, v);
      const key = await deps.store.key(); // refuses on a key / account mismatch
      // No sheet here, on purpose: the user approved this exact post (text + fee) on the buildPost sheet moments
      // ago, and validateSignRequest only lets through a POST /v1/posts whose body is that same txHex and text for
      // the same site. The signature registers the already-approved post with Twetch; it cannot pay or post more.
      return { result: { signature: bsmSign(Utils.toArray(signRequestString(v), 'utf8'), key) } };
    }
    if (action !== TWETCH_POST) return err(DISABLED_CODE, `${action} is not supported.`);
    const input = validatePostParams(params);
    if (typeof input === 'string') return err(BAD_REQUEST_CODE, input);
    if (!link) return NOT_LINKED;
    if (!deps.wallet) return LOCKED;
    const key = await deps.store.key();
    const script = buildPostScript(input, key, deps.now?.() ?? Date.now());
    const r = await deps.wallet.createAction({
      description: input.replyTxid ? 'Reply on Twetch' : 'Post on Twetch',
      outputs: [{ lockingScript: script, satoshis: 0, outputDescription: 'Twetch post' }],
      labels: ['twetch'],
      options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: false },
    } as never);
    if (!r.tx || !r.txid) return err('ERROR', 'The wallet did not build the transaction.');
    const txid = r.txid;
    // Nothing has left the phone yet: any refusal from here to the reply aborts the action.
    let handedOff = false;
    try {
      const tx = Transaction.fromAtomicBEEF(r.tx);
      if (tx.id('hex') !== txid) return err('ERROR', 'Transaction id mismatch.');
      const post = tx.outputs.find((o) => o.lockingScript.toHex() === script);
      if (!post || post.satoshis !== 0) return err('ERROR', 'The wallet changed the post output.');
      const fee = tx.getFee();
      const rate = await deps.bsvUsd().catch(() => 0);
      const ok = await ask({
        kind: 'post',
        host,
        handle: twetchHandle(link),
        proven: deps.proven,
        preview: previewText(input.text),
        reply: !!input.replyTxid,
        fee: feeLabel(fee, rate),
      });
      if (!ok) return DENIED;
      const txHex = tx.toHex();
      handedOff = true;
      rememberBuilt(origin, { txHex, text: input.text, reply: !!input.replyTxid, fee }, deps.now?.() ?? Date.now());
      (deps.settle ?? defaultSettle)(deps.wallet, txid);
      return { result: { txHex, txid, fee } };
    } finally {
      if (!handedOff) await deps.wallet.abortAction({ reference: txid }).catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof TwetchKeyMismatch) return err(KEY_MISMATCH_CODE, e.message);
    return err('ERROR', e instanceof Error ? e.message : String(e));
  }
}

/** The sheet's words, kept apart so tests check them without rendering. */
export const sheetText = (a: TwetchAsk) => {
  const site = a.proven ? a.host : `a site that claims to be ${a.host}`;
  if (a.kind === 'login')
    return {
      title: loginTitle(a.handle),
      body: `${site} asks to sign in to Twetch with your Twetch key. Nothing is spent.`,
      approve: 'Sign in',
    };
  return {
    title: postTitle(a.handle, a.reply),
    body: `From ${site}. Network fee ${a.fee}. Nothing is paid to Twetch. Posts on Twetch are public and permanent.`,
    approve: a.reply ? 'Reply' : 'Post',
  };
};
