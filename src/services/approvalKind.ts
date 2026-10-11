import type { SheetModel } from './permissionBundle';

/**
 * Which approval card a request gets (owner-approved designs, 11 Oct 2026). Users don't read, so each
 * kind looks different: SIGN IN (gold key), CONNECT (wallet ↔ site), PAY (the dollar amount), MINT
 * (the bAvatar), CAREFUL (red, the safe answer is the big button).
 */
export type ApprovalKind = 'signin' | 'connect' | 'pay' | 'mint' | 'careful';

export interface ApprovalContext {
  /**
   * The site's current monthly allowance in sats, if it has one. A payment that still reaches a sheet
   * while an allowance exists did not fit inside it.
   */
  existingAllowanceSats?: number;
}

/** True when this sheet's payment goes past the site's monthly allowance. */
export const isOverAllowance = (model: Pick<SheetModel, 'payment'>, ctx: ApprovalContext = {}): boolean =>
  !!model.payment && ctx.existingAllowanceSats !== undefined;

/** The card for a one-sheet bundle. Risk wins over everything; then payment; then sign-in vs connect. */
export const approvalKindForSheet = (
  model: Pick<SheetModel, 'lines' | 'payment' | 'mode'>,
  ctx: ApprovalContext = {},
): ApprovalKind => {
  if (model.lines.some((l) => l.risky)) return 'careful';
  if (isOverAllowance(model, ctx)) return 'careful';
  if (model.payment) return 'pay';
  if (model.lines.length > 0 && model.lines.every(isSignInLine)) return 'signin';
  return 'connect';
};

/** Sign-in style: a signature/key use for the site itself, nothing kept, nothing shared, nothing seen. */
const isSignInLine = (l: SheetModel['lines'][number]): boolean =>
  /^protocol /.test(l.detail) && !/counterparty (?!anyone|self)\S/.test(l.detail);

/** "bchatx.com" → "bchatx"; "www.app.example.co.uk" → "app.example". Display only. */
export const siteName = (originator: string): string => {
  const host = originator
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/:?#]/)[0]
    .replace(/^www\./i, '');
  const parts = host.split('.');
  if (parts.length <= 1) return host;
  const drop = parts.length > 2 && parts[parts.length - 2].length <= 3 ? 2 : 1;
  return parts.slice(0, parts.length - drop).join('.') || host;
};
