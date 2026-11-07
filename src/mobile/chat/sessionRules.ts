/**
 * The native Chat's bChatX session, as states (owner, 3 Nov 2026: "chat with no visible sign-in"). Pure rules;
 * the store that runs them is chatSession.ts.
 *
 *   idle         nothing yet: the next ensure signs in (silently, with the wallet's own key)
 *   pending      signing in: Chat shows a skeleton
 *   ready        signed in as `handle`
 *   needs-handle a wallet bChatX hasn't seen and no name of its own: the one real choice, "Choose your handle"
 *   off          the owner turned bChatX off for this account (Settings › bChatX): never signed in
 *   error        it failed: one line + Retry
 */
import { needsHandle } from './api';

export type ChatSessionState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  /** `at`: when this session was made here (0 = one restored from storage). */
  | { kind: 'ready'; handle: string; at: number }
  | { kind: 'needs-handle'; claimToken: string; address: string }
  | { kind: 'off' }
  | { kind: 'error'; message: string; at: number };

/** An automatic attempt after a failure waits this long (Retry always goes at once). */
export const ERROR_RETRY_MS = 30_000;
/** A refusal this soon after a fresh sign-in means the server keeps refusing: stop instead of looping. */
export const LOOP_GUARD_MS = 15_000;

export const CHAT_SESSION_FAILED = "Couldn't connect to chat.";

/**
 * Should ensure() start a sign-in now? `force` is Retry. `recheckHandle` (opening Chat or DMs): a wallet that was
 * waiting for a name may have chosen one since (the Wallet's "Choose your handle"), and the signer then uses it.
 */
export const shouldSignIn = (s: ChatSessionState, opts: { force?: boolean; recheckHandle?: boolean; now: number }) => {
  if (s.kind === 'pending' || s.kind === 'ready' || s.kind === 'off') return false;
  if (opts.force) return true;
  // Otherwise waits for the person's choice of name; signing in again would only ask the same thing.
  if (s.kind === 'needs-handle') return !!opts.recheckHandle;
  if (s.kind === 'error') return opts.now - s.at >= ERROR_RETRY_MS;
  return true;
};

/** What a failed sign-in becomes: "Choose your handle" for a new wallet with no name, else one line + Retry. */
export const stateFromError = (e: unknown, now: number): ChatSessionState => {
  const need = needsHandle(e);
  if (need) return { kind: 'needs-handle', ...need };
  return { kind: 'error', message: CHAT_SESSION_FAILED, at: now };
};

/** The server refused the session (401). Sign in again quietly, unless it was only just made. */
export const afterAuthLost = (s: ChatSessionState, now: number): ChatSessionState =>
  s.kind === 'ready' && s.at > 0 && now - s.at < LOOP_GUARD_MS
    ? { kind: 'error', message: CHAT_SESSION_FAILED, at: now }
    : { kind: 'idle' };
