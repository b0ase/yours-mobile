import { Utils, type WalletInterface } from '@bsv/sdk';
import type { AuthLink } from './authLink';

/**
 * The wallet's half of Sign in with bWalletX. Kept in lockstep with site/lib/auth.js (authMessage, signedFields,
 * SIGN_PROTOCOL): the identity key signs the request id, the app and the exact redirect URI, so an approval can't
 * be replayed for another app or another destination.
 */
export const AUTH_SIGN_PROTOCOL: [2, string] = [2, 'bwalletx auth'];
export const AUTH_SIGN_KEY_ID = '1';

export type AuthRequest = {
  id: string;
  status: string;
  client: { id: string; name: string; site: string };
  redirect_uri: string;
  redirectHost: string;
  scopes: string[];
  expiresAt: string;
};

export const authMessage = (action: string, fields: Record<string, string>) => {
  const keys = Object.keys(fields).sort();
  return ['bwalletx-auth', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
};

export const fetchAuthRequest = async (link: AuthLink, f: typeof fetch = fetch): Promise<AuthRequest> => {
  const r = await f(`${link.server}/api/auth/request?id=${link.id}`, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || 'This sign-in could not be loaded.');
  return j as AuthRequest;
};

/** Sign and send the user's answer. */
export const answerAuthRequest = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  link: AuthLink,
  req: Pick<AuthRequest, 'id' | 'client' | 'redirect_uri'>,
  action: 'approve' | 'deny',
  f: typeof fetch = fetch,
  now = Date.now(),
  match?: string,
) => {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const fields = {
    id: req.id,
    client_id: req.client.id,
    redirect_uri: req.redirect_uri,
    identityKey,
    timestamp: String(now),
  };
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(authMessage(action, fields), 'utf8'),
    protocolID: AUTH_SIGN_PROTOCOL,
    keyID: AUTH_SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  const r = await f(`${link.server}/api/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: req.id,
      identityKey,
      timestamp: now,
      signature: Utils.toHex(signature),
      ...(action === 'approve' ? { match } : {}),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || 'Sign-in failed. Try again on the site.');
  return j as { ok: true };
};

/** Plain words for each scope on the sheet. */
export const scopeLabel = (s: string) =>
  s === 'openid'
    ? 'Your identity key'
    : s === 'profile' || s === 'paymail'
      ? 'Your $name and paymail'
      : s === 'bitsign'
        ? 'Your bit-sign verified level'
        : s;

/** The 4-digit code the site shows; the sheet only enables Allow once four digits are typed. */
export const cleanMatchCode = (s: string) => s.replace(/[^0-9]/g, '').slice(0, 4);
