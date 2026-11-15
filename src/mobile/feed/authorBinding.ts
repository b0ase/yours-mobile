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
 * ⚠ Only for accounts that post. The binding tells bChatX which name a posting address belongs to, so an account that
 * has never posted is never bound: it is sent after a post, and on Feed open only when the account has posted before.
 * Agent accounts and pots are never bound.
 *
 * ⚠ Silent and never in a post's way. Both keys are the wallet's own, signing a statement about its own account, so
 * there is no prompt; the protocol is reserved (services/reservedProtocolList.ts) so no site can ask for one. Nothing
 * here throws: a post is never delayed or failed by it (feedApi.publish fires it and moves on).
 */
import { BSOCIAL_BASKET, computeBapId, resolveBapSigner, type OneSatContext } from '@1sat/actions';
import { AIP } from '@1sat/templates';
import { PublicKey, Utils } from '@bsv/sdk';
import { isAgentAccount } from '../agents/agentAccounts';
import { IS_EXTENSION } from '../extension';
import { getPaymail, setPaymail } from '../names/accountName';
import { lookupPaymailState, paymailEnabled, type PaymailLookup } from '../names/paymail';
import { bareName } from '../names/names';
import { onSessionReset } from '../../utils/sessionCaches';
import {
  feedAuthorTransport,
  retryAfterMs,
  sendFeedAuthorClaim,
  sendFeedAuthorClaimViaWorker,
  type FeedAuthorAnswer,
} from '../../services/feedAuthorRelay';
import {
  hasPostedFlag,
  markPosted,
  readAuthorBinding,
  writeAuthorBinding,
  type AuthorBindingRecord,
} from './authorBindingState';

export { FEED_AUTHOR_BINDING_API } from '../../services/feedAuthorRelay';
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

/**
 * A post or a reply needs a bWalletX name (owner, 15 Nov 2026): the name is what the post's avatar links to. The
 * test is the binding's own (feedAuthorAlias). It is about HAVING a name, never about the link: with a name, posting
 * works whether the link is done, pending, refused or the server is down. A build with names switched off has no
 * way to claim one, so it gates nothing. Likes, follows, branches, hides and tips are never gated.
 *
 * ⚠ It exists to stop unnamed accounts, not to block named ones. The cached name is trusted when there is one; with
 * none cached the server is asked once, and only its definite "no name" refuses. "Couldn't tell" lets the post go.
 */
export const postNameGate = {
  enabled: (): boolean => paymailEnabled(),
  paymailFor: (identityAddress: string): string => getPaymail(identityAddress),
  bare: (paymail: string): string => bareName(paymail),
  /** The server's answer for an identity key (names/paymail.ts lookupPaymailState). */
  lookup: (identityKey: string): Promise<PaymailLookup> => lookupPaymailState((u, i) => fetch(u, i), identityKey),
  /** Put a name the server just gave back in the cache. */
  remember: (identityAddress: string, paymail: string): void => setPaymail(identityAddress, paymail),
};
/** This account has no name in the cache (the composer's quick test; publish asks the server before refusing). */
export const needsNameToPost = (paymail: string): boolean =>
  postNameGate.enabled() && feedAuthorAlias(paymail, postNameGate.bare) === null;

export const NAME_NEEDED_MESSAGE = 'Choose your $name before you post. Nothing was posted or paid.';
export class NameNeededError extends Error {
  constructor() {
    super(NAME_NEEDED_MESSAGE);
    this.name = 'NameNeededError';
  }
}

/** Proof that the name check passed for a post about to be made. Only assertNameToPost makes one. */
export type NameChecked = { readonly nameChecked: true };
const passes = new WeakSet<object>();
export const isNameChecked = (t: unknown): t is NameChecked => typeof t === 'object' && t !== null && passes.has(t);

/**
 * Refuse (NameNeededError) when the account `ctx` signs as has no bWalletX name; otherwise a pass to hand to
 * publish(). Call it BEFORE anything is paid (inscribing media, a reveal): publish() given the pass does not check
 * again, so a name that goes missing in between can never stop a post whose media is already paid for.
 */
export async function assertNameToPost(ctx: OneSatContext): Promise<NameChecked> {
  const pass: NameChecked = { nameChecked: true };
  passes.add(pass);
  if (!postNameGate.enabled()) return pass;
  const identityKey = (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();
  const identityAddress = PublicKey.fromString(identityKey).toAddress();
  if (!needsNameToPost(postNameGate.paymailFor(identityAddress))) return pass;
  const live = await postNameGate.lookup(identityKey).catch((): PaymailLookup => ({ state: 'unknown' }));
  if (live.state === 'none') throw new NameNeededError();
  if (live.state === 'name' && feedAuthorAlias(live.paymail, postNameGate.bare) !== null)
    postNameGate.remember(identityAddress, live.paymail);
  return pass;
}

/** feedApi.publish: a post or reply ('type:post') is checked here unless its caller already holds a pass. */
export async function assertNameForPost(ctx: OneSatContext, tags: readonly string[], pass?: unknown): Promise<void> {
  if (!tags.includes('type:post') || isNameChecked(pass)) return;
  await assertNameToPost(ctx);
}

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

/**
 * ok: linked. retry-later: try again soon, quietly. needs-name: claim or re-sign the name first. failed: refused, may
 * be tried again much later. blocked: the address is linked to another name; not re-sent for 30 days, or until the name is re-signed.
 */
export type BindingOutcome = 'ok' | 'retry-later' | 'needs-name' | 'failed' | 'blocked';

/** What a server answer means for the wallet. Read from the `code`, never from the status alone (409 has two). */
export const bindingOutcome = (status: number, body: { ok?: unknown; code?: unknown } | null): BindingOutcome => {
  const code = typeof body?.code === 'string' ? body.code : '';
  if (status === 200 && body?.ok === true) return 'ok';
  if (code === 'name_binding_not_verified') return 'needs-name';
  // 409: this posting address is already linked to a different identity key whose name still resolves to it. No
  // quick retry can change that (BLOCKED_RETRY_MS).
  if (code === 'address_linked_to_another_name') return 'blocked';
  // 409 bap_not_indexed: Sigma's BAP index reads the chain, and a posting profile published a minute ago isn't in it
  // yet. Until the server says so by name it answers 401 bap_id_mismatch for the same case, so that waits too.
  if (code === 'bap_not_indexed' || code === 'bap_id_mismatch') return 'retry-later';
  // No answer, 503 pki_unavailable / sigma_unavailable, any other 5xx, or rate limiting: the claim is fine, the
  // moment isn't.
  if (status === 0 || status >= 500 || status === 429) return 'retry-later';
  return 'failed';
};

/** Send a signed claim the way this build must (services/feedAuthorRelay.ts). Never throws. */
export async function postFeedAuthorBinding(
  body: FeedAuthorBody,
  f: typeof fetch = fetch,
  transport: 'worker' | 'direct' = feedAuthorTransport(IS_EXTENSION),
): Promise<{ outcome: BindingOutcome; code: string; answer: FeedAuthorAnswer }> {
  const answer = transport === 'worker' ? await sendFeedAuthorClaimViaWorker(body) : await sendFeedAuthorClaim(body, f);
  const code = typeof answer.body?.code === 'string' ? answer.body.code : answer.status === 0 ? 'network' : '';
  return { outcome: bindingOutcome(answer.status, answer.body), code, answer };
}

/** The tag on a post or a reply in the wallet's bSocial basket (FeedPage's composer and reply). */
export const AUTHORED_TAG = 'type:post';
/** A publish that authors something: a post or a reply. Likes, follows, branches, hides and tips are not. */
export const isAuthoredPost = (tags: readonly string[]) => tags.includes(AUTHORED_TAG);

/** Has this account written a post or a reply from this wallet? Its bSocial basket holds each one, tagged. */
const hasBsocialOutputs = async (ctx: OneSatContext): Promise<boolean> => {
  try {
    // Posts and replies only (feedApi's 'type:post' tag): a like, follow, branch or hide is not authorship.
    const r = await ctx.wallet.listOutputs({ basket: BSOCIAL_BASKET, tags: [AUTHORED_TAG], limit: 1 });
    return (r.totalOutputs ?? r.outputs.length) > 0;
  } catch {
    return false;
  }
};

export type AuthorBindingDeps = {
  now: () => number;
  fetch: typeof fetch;
  /** Send the signed claim (the extension goes through its service worker). */
  post: (body: FeedAuthorBody, f: typeof fetch) => ReturnType<typeof postFeedAuthorBinding>;
  /** The account's cached bWalletX paymail ('' when it has none). */
  paymailFor: (identityAddress: string) => string;
  /** A paymail without our own domain (names.ts bareName); another domain's is returned whole. */
  bare: (paymail: string) => string;
  /** An agent account or a pot (agents/agentAccounts.ts): never bound. */
  isAgentOrPot: (identityAddress: string) => boolean;
  /** This account has posted to the Feed from this wallet (the flag set at post time, else its bSocial basket). */
  hasPosted: (ctx: OneSatContext, identityAddress: string) => Promise<boolean>;
  /** Remember that this account has posted. */
  markPosted: (identityAddress: string) => void;
  read: (identityAddress: string) => AuthorBindingRecord | null;
  write: (identityAddress: string, record: AuthorBindingRecord | null) => void;
  /** Run `fn` after `ms` (a quiet retry). */
  schedule: (fn: () => void, ms: number) => unknown;
};

const defaultDeps: AuthorBindingDeps = {
  now: () => Date.now(),
  fetch: (...a) => fetch(...a),
  post: (body, f) => postFeedAuthorBinding(body, f),
  paymailFor: getPaymail,
  bare: bareName,
  isAgentOrPot: isAgentAccount,
  hasPosted: async (ctx, identityAddress) => hasPostedFlag(identityAddress) || (await hasBsocialOutputs(ctx)),
  markPosted,
  read: readAuthorBinding,
  write: writeAuthorBinding,
  schedule: (fn, ms) => setTimeout(fn, ms),
};

/**
 * Quiet retries after a retry-later answer: 1 min, 5 min, 30 min (longer when the server's Retry-After says so).
 * After those, the next Feed open or post retries, never sooner than the last delay: about one send per 30 minutes.
 */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** A name the server found unsigned is asked about again after this long, or at once when the name sync signs it. */
export const NEEDS_NAME_RETRY_MS = 24 * 60 * 60_000;
/** A refused claim (bad signature, clock far off) is not re-sent on every post. */
export const FAILED_RETRY_MS = 6 * 60 * 60_000;

/**
 * "Linked to another name" is not retried on timers, on Feed open or after posts. It gets one fresh attempt after
 * this long (the other name may have been released since), or at once when the name sync re-signs the name.
 */
export const BLOCKED_RETRY_MS = 30 * 24 * 60 * 60_000;

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
  /** The account has never posted to the Feed: nothing about it is sent. */
  | 'not-posted'
  /** An agent account or a pot: never bound. */
  | 'excluded'
  /** A recent retry-later / refusal: not asked again yet. */
  | 'waiting'
  /** The wallet could not sign just now (locked, switching accounts), or a retry's account is no longer the one open. */
  | 'unavailable';

/** Has the server (as far as this device knows) linked exactly this name and posting address? */
const linked = (r: AuthorBindingRecord | null, alias: string, address: string) =>
  r?.status === 'ok' && r.alias === alias && r.address === address;

/** A refusal on record for exactly this claim that must not be asked about again (yet, or ever). */
const refused = (r: AuthorBindingRecord | null, alias: string, address: string, now: number) => {
  if (!r || r.status === 'ok' || r.alias !== alias || r.address !== address) return false;
  const wait =
    r.status === 'blocked' ? BLOCKED_RETRY_MS : r.status === 'needs-name' ? NEEDS_NAME_RETRY_MS : FAILED_RETRY_MS;
  return now - r.at < wait;
};

export type EnsureOptions = {
  /**
   * The caller just published a post with this wallet (feedApi.publish): the account has posted, and
   * `postingAddress` is the address on that post, so an account already linked is recognised without asking the
   * wallet for anything but its identity key.
   */
  posted?: boolean;
  postingAddress?: string | null;
  /** A scheduled retry, for this account only: if the wallet has moved to another account, nothing is done. */
  retryFor?: string;
  /** An unlock / account-switch check for this account only (linkAuthorAtUnlock): the same rules as Feed open. */
  onlyFor?: string;
};

/**
 * Link this account's posting address to its bWalletX name on bChatX, once. Called after each post, and on Feed open
 * (where it does nothing for an account that has never posted). Sent again only when the posting address or the name
 * changed. Never throws.
 */
export async function ensureFeedAuthorBinding(
  ctx: OneSatContext,
  opts: EnsureOptions = {},
  deps: Partial<AuthorBindingDeps> = {},
): Promise<EnsureResult> {
  const d = { ...defaultDeps, ...deps };
  try {
    const identityKey = (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();
    const identityAddress = PublicKey.fromString(identityKey).toAddress();
    // The app has one wallet context, and it follows the account in use: a retry scheduled for account A must not
    // sign and send for account B after a switch.
    if (opts.retryFor !== undefined && opts.retryFor !== identityAddress) return 'unavailable';
    if (opts.onlyFor !== undefined && opts.onlyFor !== identityAddress) return 'unavailable';
    if (d.isAgentOrPot(identityAddress)) return 'excluded';
    if (opts.posted) d.markPosted(identityAddress);
    const alias = feedAuthorAlias(d.paymailFor(identityAddress), d.bare);
    if (!alias) return 'no-name';
    const retry = opts.retryFor !== undefined;
    if (opts.postingAddress) {
      const known = d.read(identityAddress);
      if (linked(known, alias, opts.postingAddress)) return 'already';
      if (known?.status === 'blocked' && refused(known, alias, opts.postingAddress, d.now())) return 'blocked';
    }

    const s = sessions.get(identityAddress) ?? { attempts: 0, notBefore: 0, flight: null, epoch };
    sessions.set(identityAddress, s);
    const joined = s.flight;
    if (joined) {
      const r = await joined;
      // A post that arrives while a Feed-open check is deciding "never posted" must not inherit that answer: it
      // goes round once more as the post it is (or joins another post's run that got there first).
      if (!(opts.posted && r === 'not-posted')) return r;
      if (s.flight && s.flight !== joined) return await s.flight;
    }
    if (!retry && d.now() < s.notBefore) return 'waiting';

    const run = (async (): Promise<EnsureResult> => {
      // Privacy: an account that has never posted is not bound (a retry was scheduled by one that had).
      if (!opts.posted && !retry && !(await d.hasPosted(ctx, identityAddress))) return 'not-posted';
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
      // A permanent refusal holds for a retry too; a timed one only for a new trigger.
      if (refused(record, alias, postingAddress, d.now())) {
        if (record?.status === 'blocked') return 'blocked';
        if (!retry) return 'waiting';
      }

      // Every send is a fresh claim: the BAP ID is read again and the text carries a new time, so a retry never
      // repeats an old body (the server's window is 10 minutes, and its index may have caught up meanwhile).
      const claim: FeedAuthorClaim = {
        alias,
        identityKey,
        bapId: await computeBapId(ctx),
        postingAddress,
        timestamp: Math.trunc(d.now()),
      };
      const { outcome, code, answer } = await d.post(await signFeedAuthorClaim(ctx, claim), d.fetch);
      const at = d.now();
      if (outcome === 'retry-later') {
        const step = RETRY_DELAYS_MS[Math.min(s.attempts, RETRY_DELAYS_MS.length - 1)];
        // The server's Retry-After is a minimum, never a way to retry sooner.
        const delay = Math.max(step, retryAfterMs(answer, at));
        s.notBefore = at + delay;
        if (s.attempts++ < RETRY_DELAYS_MS.length) {
          const mine = s.epoch;
          d.schedule(() => {
            if (mine === epoch) void ensureFeedAuthorBinding(ctx, { retryFor: identityAddress }, deps);
          }, delay);
        }
        return outcome;
      }
      s.attempts = 0;
      s.notBefore = 0;
      d.write(identityAddress, { status: outcome, alias, address: postingAddress, at, ...(code && { code }) });
      return outcome;
    })();
    s.flight = run;
    try {
      return await run;
    } finally {
      if (s.flight === run) s.flight = null;
    }
  } catch {
    return 'unavailable';
  }
}

/** Right after a switch the wallet context can still be the previous account's: look again after these waits. */
export const UNLOCK_RECHECK_MS = [2_000, 8_000, 30_000];

/**
 * The Feed-open check, run when the wallet unlocks and when the account in use changes (notify/NotifyEngine.tsx,
 * mounted on every platform). Same rules: only an account that has written a post or reply, never an agent account or
 * a pot, the same records and spacing. Fire-and-forget: returns at once, never throws, asks nothing. It checks
 * `identityAddress` only: while the wallet context is still another account's it waits and looks again, and never
 * signs for the account it wasn't asked about.
 */
export function linkAuthorAtUnlock(ctx: OneSatContext, identityAddress: string, deps: Partial<AuthorBindingDeps> = {}) {
  const schedule = deps.schedule ?? defaultDeps.schedule;
  const started = epoch;
  const attempt = (n: number) => {
    void ensureFeedAuthorBinding(ctx, { onlyFor: identityAddress }, deps)
      .then((r) => {
        if (r !== 'unavailable' || n >= UNLOCK_RECHECK_MS.length) return;
        schedule(() => {
          if (started === epoch) attempt(n + 1);
        }, UNLOCK_RECHECK_MS[n]);
      })
      .catch(() => undefined);
  };
  try {
    attempt(0);
  } catch {
    /* never into unlock */
  }
}
