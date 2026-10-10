/**
 * The identity line on the wallet card (WalletCard.tsx), under the account name:
 *   `$bwallet0126 · 02cbe7…6ed8`   signed in to chat
 *   `02cbe7…6ed8 · not signed in to chat`
 * plus a "Chat identity mismatch" chip when this account's bChat session belongs to someone else.
 *
 * Why (8 Oct 2026): one wallet account was signed in to bit-sign/bChat as another account's handle and
 * the owner could not tell. The line shows which chat identity this account is using, every time.
 */

/** `02cbe7…6ed8`: first 6 and last 4 hex characters. */
export const shortKey = (key: string | null | undefined): string => {
  const k = (key || '').trim();
  return k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k;
};

/**
 * The identity key's fingerprint for the card FRONT and account rows (owner, 10 Oct 2026): first 6 and
 * last 4 hex characters, `0236aa…3ed4`. Display only: the full key (copyable) is on the card's back.
 */
export const keyFingerprint = (key: string | null | undefined): string => {
  const k = (key || '').trim().toLowerCase();
  return /^[0-9a-f]{66}$/.test(k) ? `${k.slice(0, 6)}…${k.slice(-4)}` : '';
};

export interface IdentityLine {
  /** `$handle` or null when not signed in to chat. */
  handle: string | null;
  key: string;
  text: string;
}

export const identityLine = (
  handle: string | null | undefined,
  identityKey: string | null | undefined,
): IdentityLine => {
  const key = shortKey(identityKey);
  const h = (handle || '').trim().replace(/^\$/, '');
  if (!h) return { handle: null, key, text: key ? `${key} · not signed in to chat` : 'Not signed in to chat' };
  const tag = `$${h}`;
  return { handle: tag, key, text: key ? `${tag} · ${key}` : tag };
};

/**
 * One handle per account (owner, 10 Oct 2026): the card's name is this account's own $paymail alias, and
 * the line under it never shows a DIFFERENT handle as if it were this account's. A bChat session on a
 * `yours-*` placeholder or on another account's handle becomes a one-tap fix instead.
 *   same        → `testy@bwalletx.com · 02cbe7…6ed8`
 *   placeholder → same line + "bChatX still calls you @yours-jorv3rmo: use @testy"
 *   other       → same line + "Signed in to bChatX as @b0asex: sign in as @b0asey"
 *   none        → `02cbe7…6ed8 · not signed in to bChatX`
 * Without a paymail alias the old `$handle · key` line stands (nothing to compare against). Pure.
 */
export type ChatHandleIssue = { kind: 'placeholder' | 'other'; chatHandle: string; alias: string; text: string } | null;

export const accountIdentityLine = (
  chatHandle: string | null | undefined,
  identityKey: string | null | undefined,
  paymail: string | null | undefined,
): IdentityLine & { issue: ChatHandleIssue } => {
  const key = shortKey(identityKey);
  const full = (paymail || '').trim();
  const alias = norm(full.split('@')[0]);
  const chat = norm(chatHandle);
  if (!alias) return { ...identityLine(chatHandle, identityKey), issue: null };
  const text = key ? `${full} · ${key}` : full;
  if (!chat)
    return {
      handle: null,
      key,
      text: key ? `${key} · not signed in to bChatX` : 'Not signed in to bChatX',
      issue: null,
    };
  if (chat === alias) return { handle: `$${alias}`, key, text, issue: null };
  const placeholder = chat.startsWith('yours-');
  return {
    handle: `$${alias}`,
    key,
    text,
    issue: {
      kind: placeholder ? 'placeholder' : 'other',
      chatHandle: chat,
      alias,
      text: placeholder
        ? `bChatX still calls you @${chat}: use @${alias}`
        : `Signed in to bChatX as @${chat}: sign in as @${alias}`,
    },
  };
};

export interface MismatchInput {
  /** This wallet account (identity address). */
  account: string | null | undefined;
  /** The stored bChat session for it. */
  session: { handle: string; address: string; account?: string } | null;
  /** The address this account signs chat sign-ins with (chat/signer.ts walletSigner().address()). */
  expectedAddress?: string | null;
  /** GET /api/bitsign/whoami: the handle the token really belongs to (undefined = not checked yet). */
  serverHandle?: string | null;
  /** whoami?address=: whether expectedAddress is a credential of that handle (null/undefined = unknown). */
  addressLinked?: boolean | null;
}

const norm = (h: string | null | undefined) => (h || '').trim().replace(/^\$/, '').toLowerCase();

/**
 * True when the session's identity does not match this account. Unknowns never warn (a network
 * failure must not cry wolf); only a positive contradiction does.
 */
export const chatIdentityMismatch = (i: MismatchInput): boolean => {
  const s = i.session;
  if (!s) return false;
  if (s.account && i.account && s.account !== i.account) return true;
  if (i.expectedAddress && s.address && s.address !== i.expectedAddress) return true;
  if (typeof i.serverHandle === 'string' && i.serverHandle && norm(i.serverHandle) !== norm(s.handle)) return true;
  if (i.addressLinked === false) return true;
  return false;
};
