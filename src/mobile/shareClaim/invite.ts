import { ProtoWallet, Utils, type WalletProtocol } from '@bsv/sdk';
import { canonicalBytes } from './canonical';
import { companyConfigured, companyFor, NOT_CONFIGURED, type CompanyPin } from './companies';

/**
 * Register-of-members claim invites (docs/SHARE-CLAIM.md):
 *   bwalletx://claim/<inviteId>?c=npg
 *   https://web.bwalletx.com/m/claim/<inviteId>?c=npg
 * inviteId: 256-bit base64url (43 chars), single use, 30-day expiry. Nothing personal is in the URL.
 */
export const INVITE_PROTOCOL: WalletProtocol = [1, 'npg share invite'];
export const INVITE_KEY_ID = '1';
const INVITE_ID = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_HOSTS = new Set(['web.bwalletx.com', 'bwalletx.com', 'www.bwalletx.com']);

export const isInviteId = (s: unknown): s is string => typeof s === 'string' && INVITE_ID.test(s);

export type ClaimLink = { inviteId: string; company: string };

export function parseClaimLink(url: string | null | undefined): ClaimLink | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    let id = '';
    if (u.protocol === 'bwalletx:' && u.host === 'claim') id = u.pathname.replace(/^\/+|\/+$/g, '');
    else if (u.protocol === 'https:' && CLAIM_HOSTS.has(u.host)) {
      const m = u.pathname.match(/^\/m\/claim\/([^/]+)\/?$/);
      if (!m) return null;
      id = m[1];
    } else return null;
    const company = u.searchParams.get('c') ?? '';
    if (!isInviteId(id) || !companyFor(company)) return null;
    return { inviteId: id, company };
  } catch {
    return null;
  }
}

export type InviteToken = { standard: 'bsv21'; id: string; decimals: 0; tranche: string; amount: number };

export type InvitePayload = {
  v: 1;
  company: { name: string; number: string; ticker: string };
  tokens: InviteToken[];
  holder: { registerEntry: string; shares: number; nameOnRegister: string };
  lock: { type: '2of2'; companyPubKey: string; releaseAfterBlock: null };
  claimUrl: string;
  expiresAt: string;
  sig: string;
};

/** A checked invite: tokens resolved against the pinned registry. */
export type CheckedInvite = InvitePayload & { inviteId: string; pin: CompanyPin };

export class InviteError extends Error {}
const fail = (m: string): never => {
  throw new InviteError(m);
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** The bytes the company signs: canonicalJson(payload without `sig`). */
export function inviteSignedBytes(payload: Record<string, unknown>): number[] {
  const rest = { ...payload };
  delete rest.sig;
  return canonicalBytes(rest);
}

/**
 * Checks an invite fetched for `inviteId` under company `code`. Order: pinned keys configured → signature against
 * the PINNED identity key → shape → expiry → pinned lock key → every token id pinned, decimals 0 → share totals.
 */
export async function checkInvite(
  raw: unknown,
  inviteId: string,
  code: string,
  now = Date.now(),
): Promise<CheckedInvite> {
  const pin = companyFor(code) ?? fail('Unknown company');
  if (!companyConfigured(pin)) fail(NOT_CONFIGURED);
  if (!isInviteId(inviteId)) fail('Bad invite link');
  if (!isObj(raw)) fail('The invite could not be read');
  const p = raw as Record<string, unknown>;
  if (typeof p.sig !== 'string' || !/^[0-9a-f]+$/i.test(p.sig)) fail('The invite is not signed');
  let valid = false;
  try {
    ({ valid } = await new ProtoWallet('anyone').verifySignature({
      data: inviteSignedBytes(p),
      signature: Utils.toArray(p.sig as string, 'hex'),
      protocolID: INVITE_PROTOCOL,
      keyID: INVITE_KEY_ID,
      counterparty: pin.identityKey,
    }));
  } catch {
    valid = false;
  }
  if (!valid) fail('The invite signature does not match the company key');

  if (p.v !== 1) fail('Unsupported invite version');
  const company = p.company,
    holder = p.holder,
    lock = p.lock;
  if (!isObj(company) || company.number !== pin.number) fail('The invite is for a different company');
  if (!isObj(holder) || typeof holder.registerEntry !== 'string' || typeof holder.nameOnRegister !== 'string')
    fail('The invite has no register entry');
  if (!isCount((holder as Record<string, unknown>).shares)) fail('The invite has no share count');
  if (typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt))) fail('The invite has no expiry');
  if (Date.parse(p.expiresAt as string) <= now) fail('This invite has expired');
  if (!isObj(lock) || lock.type !== '2of2') fail('Unsupported lock type');
  // TODO(owner): a timed release (releaseAfterBlock) is not decided; refuse anything but null for now.
  if ((lock as Record<string, unknown>).releaseAfterBlock !== null) fail('Timed release is not supported yet');
  if (String((lock as Record<string, unknown>).companyPubKey).toLowerCase() !== pin.lockKey)
    fail('The invite lock key is not the pinned company key');
  if (typeof p.claimUrl !== 'string') fail('The invite has no claim address');
  const claim = new URL(p.claimUrl as string);
  if (claim.origin !== new URL(pin.host).origin) fail('The claim address is not the company host');

  if (!Array.isArray(p.tokens) || p.tokens.length === 0) fail('The invite lists no tokens');
  const seen = new Set<string>();
  let sum = 0;
  for (const t of p.tokens as unknown[]) {
    if (!isObj(t) || t.standard !== 'bsv21') fail('Unsupported token standard');
    const tt = t as Record<string, unknown>;
    const known = typeof tt.id === 'string' ? pin.tokens[tt.id] : undefined;
    if (!known) fail('The invite names a token that is not this company’s');
    if (seen.has(tt.id as string)) fail('The invite lists a token twice');
    seen.add(tt.id as string);
    if (tt.decimals !== 0) fail('Share tokens must have 0 decimals');
    if (tt.tranche !== known!.tranche) fail('The tranche does not match its token');
    if (!isCount(tt.amount)) fail('A tranche has no share count');
    if ((tt.amount as number) > known!.shares) fail('A tranche is larger than its allotment');
    sum += tt.amount as number;
  }
  if (sum !== (holder as Record<string, unknown>).shares) fail('The tranche amounts do not add up to the holding');
  return { ...(p as unknown as InvitePayload), inviteId, pin };
}

type Fetch = typeof fetch;

/** GET <host>/api/shareholders/invite/<inviteId>, then checkInvite. */
export async function fetchInvite(link: ClaimLink, f: Fetch = fetch, now = Date.now()): Promise<CheckedInvite> {
  const pin = companyFor(link.company) ?? fail('Unknown company');
  if (!companyConfigured(pin)) fail(NOT_CONFIGURED);
  const r = await f(`${pin.host}/api/shareholders/invite/${encodeURIComponent(link.inviteId)}`, {
    headers: { accept: 'application/json' },
  });
  if (r.status === 404 || r.status === 410) fail('This invite has already been used or has expired');
  if (r.status === 503) fail('The company has not set up share claims yet');
  if (r.status === 409) fail('One of these tranches is not on chain yet; try again later');
  if (!r.ok) fail(`The company server answered ${r.status}`);
  return checkInvite(await r.json(), link.inviteId, link.company, now);
}
