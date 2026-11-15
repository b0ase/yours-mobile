/**
 * Feed-author binding: the wallet proves that its feed posting address is its own name's (owner's bug report,
 * 15 Nov 2026: a wallet post by $peytonmoon69 showed no handle on bChatX, so its avatar linked nowhere).
 *
 * Feed posts are bSocial, AIP-signed by the account's BAP posting key ([1,'sigma'], keyID identity-N). That is not the
 * BRC-100 identity key the paymail resolves to, so nothing tied a post's address to a $name. The wallet sends bChatX
 * TWO signatures over one canonical text (spec agreed with bit-sign, lib/feed/author-binding.ts there):
 *   1. the identity key: createSignature, protocol [2,'bwallet feed author'], keyID '1', counterparty 'anyone', DER hex;
 *   2. the posting key: a Bitcoin Signed Message compact signature (base64), exactly what AIP puts on a post.
 * The server also needs the name's signed binding to give that identity key, and Sigma's BAP index to give that BAP
 * ID for the posting address.
 *
 * ⚠ Silent and never in a post's way. Both keys are the wallet's own, signing a statement about its own account, so
 * there is no prompt; the protocol is reserved (services/reservedProtocolList.ts) so no site can ask for one. Nothing
 * here throws: a post is never delayed or failed by it (feedApi.publish fires it and moves on).
 */
import { computeBapId, resolveBapSigner, type OneSatContext } from '@1sat/actions';
import { AIP } from '@1sat/templates';
import { PublicKey, Utils } from '@bsv/sdk';
import { getPaymail } from '../names/accountName';
import { bareName } from '../names/names';
import { onSessionReset } from '../../utils/sessionCaches';
import { readAuthorBinding, writeAuthorBinding, type AuthorBindingRecord } from './authorBindingState';

export const FEED_AUTHOR_BINDING_API = 'https://www.bchatx.com/api/bitsign/feed/author-binding';
export const FEED_AUTHOR_PROTOCOL: [2, string] = [2, 'bwallet feed author'];
export const FEED_AUTHOR_KEY_ID = '1';

export type FeedAuthorClaim = {
  alias: string;
  identityKey: string;
  bapId: string;
  postingAddress: string;
  timestamp: number;
};
export type FeedAuthorBody = FeedAuthorClaim & { identitySignature: string; postingSignature: string };

/** The exact text both keys sign. UTF-8, no trailing newline. Byte for byte the server's feedAuthorMessage. */
export const feedAuthorMessage = (c: FeedAuthorClaim): string =>
  `bwallet-feed-author|v1|alias=${c.alias}|identityKey=${c.identityKey}|bapId=${c.bapId}|postingAddress=${c.postingAddress}|timestamp=${c.timestamp}`;

/**
 * The alias the server accepts for a bWalletX paymail (lowercase, no $ and no @domain), or null: no paymail, a paymail
 * on someone else's domain, or a name the server would refuse. The server never normalises, so neither do we past
 * lowercasing our own name.
 */
export const feedAuthorAlias = (paymail: string, bare: (p: string) => string = bareName): string | null => {
  const alias = bare(paymail.trim()).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias) ? alias : null;
};

/** The posting address on an AIP-signed script (the push before the signature), for the cheap "already sent" check. */
export const aipAddressOf = (signed: { chunks: { data?: number[] }[] }): string | null => {
  const data = signed.chunks[signed.chunks.length - 2]?.data;
  if (!data?.length) return null;
  const address = Utils.toUTF8(data);
  return /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address) ? address : null;
};

/**
 * Sign a claim with both keys. Throws when the wallet's current posting key is not `claim.postingAddress` (the text
 * names the address, so a signature from another key would be refused anyway).
 */
export async function signFeedAuthorClaim(ctx: OneSatContext, claim: FeedAuthorClaim): Promise<FeedAuthorBody> {
  const bytes = Utils.toArray(feedAuthorMessage(claim), 'utf8');
  const { signature } = await ctx.wallet.createSignature({
    protocolID: FEED_AUTHOR_PROTOCOL,
    keyID: FEED_AUTHOR_KEY_ID,
    counterparty: 'anyone',
    data: bytes,
  });
  // The posting key signs as it signs a post: AIP.sign is a BSM compact signature by the current BAP signing key.
  const { signer } = await resolveBapSigner(ctx);
  const aip = await AIP.sign(bytes, signer);
  if (aip.data.address !== claim.postingAddress) throw new Error('The posting key changed while signing');
  return {
    ...claim,
    identitySignature: Utils.toHex(Array.from(signature)),
    postingSignature: Utils.toBase64(Array.from(aip.data.signature)),
  };
}

/** ok: linked. retry-later: try again soon, quietly. needs-name: claim or re-sign the name first. failed: refused. */
export type BindingOutcome = 'ok' | 'retry-later' | 'needs-name' | 'failed';

/** What a server answer means for the wallet. */
export const bindingOutcome = (status: number, body: { ok?: unknown; code?: unknown } | null): BindingOutcome => {
  const code = typeof body?.code === 'string' ? body.code : '';
  if (status === 200 && body?.ok === true) return 'ok';
  if (code === 'name_binding_not_verified') return 'needs-name';
  // 503 pki_unavailable / sigma_unavailable, any other 5xx, or rate limiting: the claim is fine, the moment isn't.
  if (status >= 500 || status === 429) return 'retry-later';
  // Sigma's BAP index reads the chain: a posting profile published a minute ago isn't in it yet.
  if (code === 'bap_id_mismatch') return 'retry-later';
  return 'failed';
};

/** POST a signed claim. Never throws: no network is retry-later. */
export async function postFeedAuthorBinding(
  body: FeedAuthorBody,
  f: typeof fetch = fetch,
): Promise<{ outcome: BindingOutcome; code: string }> {
  try {
    const res = await f(FEED_AUTHOR_BINDING_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as { ok?: unknown; code?: unknown } | null;
    return { outcome: bindingOutcome(res.status, json), code: typeof json?.code === 'string' ? json.code : '' };
  } catch {
    return { outcome: 'retry-later', code: 'network' };
  }
}

export type AuthorBindingDeps = {
  now: () => number;
  fetch: typeof fetch;
  /** The account's cached bWalletX paymail ('' when it has none). */
  paymailFor: (identityAddress: string) => string;
  /** A paymail without our own domain (names.ts bareName); another domain's is returned whole. */
  bare: (paymail: string) => string;
  read: (identityAddress: string) => AuthorBindingRecord | null;
  write: (identityAddress: string, record: AuthorBindingRecord | null) => void;
  /** Run `fn` after `ms` (a quiet retry). */
  schedule: (fn: () => void, ms: number) => unknown;
};

const defaultDeps: AuthorBindingDeps = {
  now: () => Date.now(),
  fetch: (...a) => fetch(...a),
  paymailFor: getPaymail,
  bare: bareName,
  read: readAuthorBinding,
  write: writeAuthorBinding,
  schedule: (fn, ms) => setTimeout(fn, ms),
};

/** Quiet retries after a retry-later answer: 1 min, 5 min, 30 min. After those, the next Feed open or post retries. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** A name the server found unsigned is asked about again after this long, or at once when the name sync signs it. */
export const NEEDS_NAME_RETRY_MS = 24 * 60 * 60_000;
/** A refused claim (bad signature, clock far off) is not re-sent on every post. */
export const FAILED_RETRY_MS = 6 * 60 * 60_000;

/** Per account, this session: retry count, the earliest next try, and the request in flight. */
type Session = { attempts: number; notBefore: number; flight: Promise<EnsureResult> | null; epoch: number };
const sessions = new Map<string, Session>();
let epoch = 0;
/** A lock ends every pending retry: the next unlock's Feed open or post starts again. */
onSessionReset(() => {
  epoch++;
  sessions.clear();
});
/** Tests only: forget this session's retries. */
export const resetAuthorBindingSession = () => {
  epoch++;
  sessions.clear();
};

export type EnsureResult =
  | BindingOutcome
  /** The server already has this account + posting address + name. Nothing sent. */
  | 'already'
  /** No bWalletX paymail: nothing to bind. */
  | 'no-name'
  /** No posting profile published yet. */
  | 'no-identity'
  /** A recent retry-later / refusal: not asked again yet. */
  | 'waiting'
  /** The wallet could not sign just now (locked, switching accounts). */
  | 'unavailable';

/** Has the server (as far as this device knows) linked exactly this name and posting address? */
const linked = (r: AuthorBindingRecord | null, alias: string, address: string) =>
  r?.status === 'ok' && r.alias === alias && r.address === address;

/** A refusal on record that is still too fresh to ask about again. */
const refusedRecently = (r: AuthorBindingRecord | null, alias: string, address: string, now: number) => {
  if (!r || r.status === 'ok' || r.alias !== alias || r.address !== address) return false;
  return now - r.at < (r.status === 'needs-name' ? NEEDS_NAME_RETRY_MS : FAILED_RETRY_MS);
};

/**
 * Link this account's posting address to its bWalletX name on bChatX, once. Called when the posting profile is set
 * up, on Feed open, and after each post; sent again only when the posting address or the name changed.
 *
 * `postingAddress` is the address the caller just saw on a signed post: with it, an account already linked is
 * recognised without asking the wallet for anything but its identity key. Never throws.
 */
export async function ensureFeedAuthorBinding(
  ctx: OneSatContext,
  opts: { postingAddress?: string | null; retry?: boolean } = {},
  deps: Partial<AuthorBindingDeps> = {},
): Promise<EnsureResult> {
  const d = { ...defaultDeps, ...deps };
  try {
    const identityKey = (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();
    const identityAddress = PublicKey.fromString(identityKey).toAddress();
    const alias = feedAuthorAlias(d.paymailFor(identityAddress), d.bare);
    if (!alias) return 'no-name';
    if (opts.postingAddress && linked(d.read(identityAddress), alias, opts.postingAddress)) return 'already';

    const s = sessions.get(identityAddress) ?? { attempts: 0, notBefore: 0, flight: null, epoch };
    sessions.set(identityAddress, s);
    if (s.flight) return await s.flight;
    if (!opts.retry && d.now() < s.notBefore) return 'waiting';

    s.flight = (async (): Promise<EnsureResult> => {
      let postingAddress: string;
      try {
        const { signer } = await resolveBapSigner(ctx);
        postingAddress = PublicKey.fromString(await signer.getPublicKey()).toAddress();
      } catch (e) {
        // @1sat/actions resolveCurrentKeyId: "No BAP identity published". Anything else is the wallet being busy.
        return /No BAP identity/i.test(e instanceof Error ? e.message : String(e)) ? 'no-identity' : 'unavailable';
      }
      const record = d.read(identityAddress);
      if (linked(record, alias, postingAddress)) return 'already';
      if (!opts.retry && refusedRecently(record, alias, postingAddress, d.now())) return 'waiting';

      const claim: FeedAuthorClaim = {
        alias,
        identityKey,
        bapId: await computeBapId(ctx),
        postingAddress,
        timestamp: Math.trunc(d.now()),
      };
      const { outcome, code } = await postFeedAuthorBinding(await signFeedAuthorClaim(ctx, claim), d.fetch);
      const at = d.now();
      if (outcome === 'retry-later') {
        const delay = RETRY_DELAYS_MS[Math.min(s.attempts, RETRY_DELAYS_MS.length - 1)];
        s.notBefore = at + delay;
        if (s.attempts++ < RETRY_DELAYS_MS.length) {
          const mine = s.epoch;
          d.schedule(() => {
            if (mine === epoch) void ensureFeedAuthorBinding(ctx, { retry: true }, deps);
          }, delay);
        }
        return outcome;
      }
      s.attempts = 0;
      s.notBefore = 0;
      d.write(identityAddress, { status: outcome, alias, address: postingAddress, at, ...(code && { code }) });
      return outcome;
    })();
    try {
      return await s.flight;
    } finally {
      s.flight = null;
    }
  } catch {
    return 'unavailable';
  }
}
