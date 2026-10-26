import type { SheetModel } from './permissionBundle';

/**
 * Which approval card a request gets (owner-approved designs, 11 Oct 2026). Users don't read, so each
 * kind looks different: SIGN IN (gold key), CONNECT (wallet ↔ site), PAY (the dollar amount), MINT
 * (the bAvatar), CAREFUL (red, the safe answer is the big button).
 */
export type ApprovalKind = 'signin' | 'connect' | 'pay' | 'mint' | 'careful' | 'post' | 'private';

/**
 * The card for a one-sheet bundle. Risk wins over everything; then a first post (POST, its cost shown); then
 * payment; then sign-in, private data, or connect.
 */
export const approvalKindForSheet = (
  model: Pick<SheetModel, 'lines' | 'payment' | 'mode'> & Partial<Pick<SheetModel, 'purpose'>>,
): ApprovalKind => {
  // A payment's size never makes a sheet CAREFUL (owner, 25 Oct 2026: "I have no spending caps"). There is no
  // site allowance, cap or threshold to be "over": the user sees the amount and approves it, whatever it is.
  if (model.lines.some((l) => l.risky)) return 'careful';
  if (model.purpose === 'post') return 'post';
  if (model.payment) return 'pay';
  if (model.lines.length > 0 && model.lines.every(isSignInLine)) return 'signin';
  if (model.lines.length > 0 && model.lines.every((l) => l.signIn || l.privateLabel)) return 'private';
  return 'connect';
};

/**
 * Sign-in style: a real sign-in (a signature anyone can check, the public identity key, or a sign-in protocol).
 * A key for the site with counterparty self is NOT a sign-in ("bchatx agent history" is a key for your Ask b chats; our team still reads Ask b chats on the server).
 */
const isSignInLine = (l: SheetModel['lines'][number]): boolean => l.signIn === true;

/** "Use your wallet keys for your Ask b chats": the label for a PRIVATE card (first private line's label). */
export const privateTitleLabel = (model: Pick<SheetModel, 'lines'>): string =>
  model.lines.find((l) => l.privateLabel)?.privateLabel ?? 'data';

/**
 * "bchatx.com" → "bchatx"; "example.co.uk" → "example". Display only.
 * Anything with more labels is shown whole: dropping two labels whenever the second-last was short let
 * "tokenblaster.com.ab1.io" read as "tokenblaster.com" in a sheet's headline (bridge audit 25 Oct 2026).
 */
export const siteName = (originator: string): string => {
  const host = originator
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/:?#]/)[0]
    .replace(/^www\./i, '');
  const parts = host.split('.');
  if (parts.length === 2) return parts[0] || host;
  if (parts.length === 3 && parts[1].length <= 3 && parts[2].length === 2) return parts[0] || host;
  return host;
};

/**
 * Sheet titles name what the request grants (owner, 26 Oct 2026: "Sign in", "Sign in", "Connect" read the same; to a
 * person, signing in IS connecting). Pure, display only: nothing here changes what is granted.
 */
export const keysName = (text: string): string => /"([^"]+)"/.exec(text)?.[1] ?? '';
export const sheetTitleText = (
  kind: string,
  site: string,
  model: Pick<SheetModel, 'lines'>,
): string => {
  const keys = model.lines.map((l) => keysName(l.text)).find(Boolean);
  switch (kind) {
    case 'signin':
      return `Connect and sign in to ${site}`;
    case 'private':
      return `Open your private ${privateTitleLabel(model)} on ${site}`;
    case 'connect':
      return keys ? `Connect to ${site} and use your "${keys}" keys` : `Connect to ${site}`;
    default:
      return '';
  }
};

/**
 * The main button says when a line the request asked for is left unticked ("Connect without bchat documents"),
 * so pressing it can never silently grant less than the sheet seems to say. Pure.
 */
export const withoutSuffix = (lines: readonly { text: string; isNew?: boolean }[], ticked: (i: number) => boolean) => {
  const off = lines.filter((l, i) => !l.isNew && !ticked(i));
  if (!off.length) return '';
  if (off.length > 1) return ` without ${off.length} permissions`;
  return ` without ${keysName(off[0].text) || 'one permission'}`;
};
