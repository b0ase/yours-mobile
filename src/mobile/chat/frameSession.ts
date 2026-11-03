/**
 * bChatX in the wallet's bApp frame is signed in as the wallet's active account, with no user step
 * (owner, 3 Nov 2026: a framed bChatX page showed the signed-out /welcome door and the board-minute signing failed).
 *
 * Why the frame has no session of its own: on iOS the bApp frame is an <iframe> inside the app's capacitor://
 * WebView (bappFrame/BappFrameHost.tsx), so www.bchatx.com is a THIRD-PARTY site there and WKWebView drops its
 * cookies. bit-sign's session is a SameSite=Lax cookie (bit-sign src/lib/login-cookies.ts) and its middleware sends
 * any cookie-less bChatX page to /welcome. Signing in inside the frame cannot fix that: the cookie it sets is dropped.
 *
 * So the page asks the wallet over the frame's XDM bridge (call `bchatx.frameSession`):
 *   { mode: 'whoami' } → { handle }        the active account's bChatX handle (no server call), or null
 *   { mode: 'code' }   → { code, handle }  a 60-second, single-use code the server minted for the wallet's own
 *                                          chat session (POST /api/bitsign/auth/frame-code, Bearer); the page
 *                                          redeems it once at /api/bitsign/auth/frame-session for its own session
 * The wallet's own token never leaves the wallet. Only bChatX origins (exact) are answered; the frame host has
 * already checked the message came from OUR iframe at its allowlisted origin. No URL carries a code or a token.
 *
 * PURE apart from the injected deps (frameSession.test.ts).
 */
import { BCHAT_ORIGINS } from '../../services/bchatOrigin';
import { ChatApiError, needsHandle, type ChatSession } from './api';
import { FRAME_SESSION_CALL } from '../bappFrame/frameBridge';

export { FRAME_SESSION_CALL };
/** bit-sign route that mints the one-time code from the wallet's Bearer session. */
export const FRAME_CODE_PATH = '/api/bitsign/auth/frame-code';
/** A code the server minted: base64url of 32 random bytes (bit-sign frame-session-rules FRAME_CODE_RE). */
const CODE_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** Only bChatX itself (www.bchatx.com, chat.bwalletx.com) is ever handed a session. Exact origins. */
export const isBchatFrameOrigin = (origin: unknown): boolean =>
  typeof origin === 'string' && (BCHAT_ORIGINS as readonly string[]).includes(origin);

export type FrameSessionMode = 'code' | 'whoami';

export const parseFrameSessionMode = (args: unknown): FrameSessionMode | null => {
  const mode = (args as { mode?: unknown } | null)?.mode;
  return mode === 'code' || mode === 'whoami' ? mode : null;
};

export type FrameSessionDeps = {
  /** The active account's stored bChatX session (chat/api.ts loadSession), or null. */
  load: () => ChatSession | null;
  /** Sign in with the wallet key (chat/signer.ts), store the session, return it. */
  signIn: () => Promise<ChatSession>;
  /** POST FRAME_CODE_PATH with this session's Bearer token; resolves the JSON body. */
  mint: (session: ChatSession) => Promise<unknown>;
  /**
   * An opaque tag for the wallet's ACTIVE account (accountTag below), or null. bChatX stores it with the frame's
   * session and drops that session the moment the tag changes (an account switch), even for the same handle.
   */
  account: () => string | null;
};

/**
 * The tag for an account's identity address: a short one-way digest, so the page can tell accounts apart without
 * learning the address. `digestHex` is sha256 → hex (injected; the frame host passes @bsv/sdk's).
 */
export const accountTag = (
  identityAddress: string | null | undefined,
  digestHex: (s: string) => string,
): string | null => (identityAddress ? digestHex(`bwalletx-frame-account|${identityAddress}`).slice(0, 24) : null);

export type FrameSessionReply = { success: true; data: unknown } | { success: false; error: string };

const errorText = (e: unknown): string => {
  if (needsHandle(e)) return 'Choose your bChatX name in the Chat tab first.';
  return e instanceof Error && e.message ? e.message : 'bWalletX could not sign you in to bChatX.';
};

/** The frame's `bchatx.frameSession` call, answered for one origin. Never throws. */
export const answerFrameSession = async (
  origin: string,
  args: unknown,
  deps: FrameSessionDeps,
): Promise<FrameSessionReply> => {
  if (!isBchatFrameOrigin(origin)) return { success: false, error: 'Not available for this app.' };
  const mode = parseFrameSessionMode(args);
  if (!mode) return { success: false, error: 'Unknown request.' };
  try {
    if (mode === 'whoami')
      return { success: true, data: { handle: deps.load()?.handle ?? null, account: deps.account() } };
    let session = deps.load() ?? (await deps.signIn());
    let body: unknown;
    try {
      body = await deps.mint(session);
    } catch (e) {
      // The stored token is stale (signed out elsewhere, "This wasn't me", secret rotated): sign in again, once.
      if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
      session = await deps.signIn();
      body = await deps.mint(session);
    }
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !CODE_RE.test(code))
      return { success: false, error: 'bChatX sent no sign-in code.' };
    return { success: true, data: { code, handle: session.handle, account: deps.account() } };
  } catch (e) {
    return { success: false, error: errorText(e) };
  }
};

/** One wallet sign-in at a time: a page that asks twice while the first sign-in runs gets the same one. */
export const singleFlight = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let inflight: Promise<T> | null = null;
  return () => {
    inflight ??= fn().finally(() => {
      inflight = null;
    });
    return inflight;
  };
};
