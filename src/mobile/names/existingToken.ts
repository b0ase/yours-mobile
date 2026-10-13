/**
 * Handle ↔ existing token (owner, 13 Oct 2026). Before offering to mint a personal $NAME token, look for
 * tokens that already use that ticker:
 *  - this account controls one (issued it, or holds it) → "We found the $X token — sign to import it":
 *    one signature, the token becomes the account's personal token, its room opens; nothing is minted;
 *  - a BSV-20 tick with that name exists and isn't ours → an error (BSV-20 ticks are unique by protocol);
 *  - someone else's BSV-21 token uses it → minting is still allowed, after a clear note, and the new token
 *    is labelled "$john · personal token of john@domain" so the two aren't confused;
 *  - nothing → the normal mint.
 * Never a silent duplicate.
 */
import { bsv21FieldsFromOutput, type OneSatContext } from '@1sat/actions';
import { BSV21_BASKET, MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { Utils } from '@bsv/sdk';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { BWALLET_PAYMAIL_DOMAIN } from './config';
import { normId, personalKey, personalTicker, setPersonalLink, type PersonalLink } from './personalToken';

export type TokenRef = { tokenId: string; sym: string; supply?: string; issued?: boolean };

/** Brand tickers whose token sym differs from the handle ($npg ↔ NPG / NINJAPUNKGIRLS). */
export const TICKER_ALIASES: Record<string, string[]> = { npg: ['NPG', 'NINJAPUNKGIRLS'] };

const clean = (s: string) => (s || '').trim().replace(/^\$/, '').toUpperCase();

/** Tickers a handle stands for: its own ticker plus any brand aliases. */
export const tickersFor = (handle: string): string[] => {
  const t = personalTicker(handle);
  const extra = TICKER_ALIASES[personalKey(handle)] ?? [];
  return [...new Set([...(t ? [t] : []), ...extra.map(clean)])];
};

/** The first token (issued ones first) whose sym matches the handle's tickers, else null. */
export function matchExistingToken(handle: string, tokens: readonly TokenRef[]): TokenRef | null {
  const want = new Set(tickersFor(handle));
  if (!want.size) return null;
  const hits = tokens.filter((t) => normId(t.tokenId) && want.has(clean(t.sym)));
  return hits.find((t) => t.issued) ?? hits[0] ?? null;
}

export type ExistingChoice =
  | { kind: 'import'; token: TokenRef }
  | { kind: 'bsv20-taken'; tick: string }
  | { kind: 'mint-labelled'; others: number }
  | { kind: 'mint' };

/** What the personal-token step offers for this handle. */
export function decideExisting(input: {
  handle: string;
  controlled: readonly TokenRef[];
  /** Someone else's BSV-21 tokens using the ticker (count). */
  othersBsv21: number;
  /** A BSV-20 tick with this name exists and this account doesn't control it. */
  bsv20Tick: boolean;
}): ExistingChoice {
  const mine = matchExistingToken(input.handle, input.controlled);
  if (mine) return { kind: 'import', token: mine };
  const tick = personalTicker(input.handle) ?? input.handle;
  if (input.bsv20Tick) return { kind: 'bsv20-taken', tick };
  if (input.othersBsv21 > 0) return { kind: 'mint-labelled', others: input.othersBsv21 };
  return { kind: 'mint' };
}

/** "$john · personal token of john@bwalletx.com" */
export const personalTokenLabel = (handle: string, domain = BWALLET_PAYMAIL_DOMAIN): string => {
  const name = personalKey(handle);
  return `$${name} · personal token of ${name}${domain ? `@${domain}` : ''}`;
};

/** The note shown before a labelled mint. */
export const duplicateNote = (handle: string, domain = BWALLET_PAYMAIL_DOMAIN): string =>
  `There's already a token called ${personalTicker(handle) ?? handle} by someone else; yours will be labelled ${personalTokenLabel(handle, domain)}.`;

export const bsv20TakenError = (tick: string) =>
  `${tick} is already a BSV-20 token, and BSV-20 names are unique, so it can't be minted again. Choose a different handle for your token.`;

/** Tokens this wallet issued (own deploys) or holds, read from the wallet. */
export async function controlledTokens(ctx: OneSatContext): Promise<TokenRef[]> {
  const [held, deploys] = await Promise.all([
    heldBsv21Balances(ctx).catch(() => []),
    ctx.wallet
      .listOutputs({
        basket: BSV21_BASKET,
        tags: ['bsv21:deploy'],
        includeTags: true,
        includeCustomInstructions: true,
        limit: 200,
      })
      .catch(() => null),
  ]);
  const out: TokenRef[] = [];
  for (const o of deploys?.outputs ?? []) {
    const f = bsv21FieldsFromOutput({ tags: o.tags, customInstructions: o.customInstructions, outpoint: o.outpoint });
    if (f.isDeploy && f.tokenId && f.sym)
      out.push({ tokenId: normId(f.tokenId)!, sym: f.sym, supply: f.amt, issued: true });
  }
  for (const t of held) {
    const id = normId(t.id);
    if (id && t.sym && !out.some((x) => x.tokenId === id)) out.push({ tokenId: id, sym: t.sym });
  }
  return out;
}

type Fetch = (u: string, i?: RequestInit) => Promise<Response>;

/** Does a BSV-20 (v1) tick with this name exist? null when the lookup failed. */
export async function bsv20TickExists(tick: string, f: Fetch = fetch): Promise<boolean | null> {
  try {
    const r = await f(`https://ordinals.gorillapool.io/api/bsv20/tick/${encodeURIComponent(tick)}`);
    if (r.status === 404) return false;
    return r.ok ? true : null;
  } catch {
    return null;
  }
}

/** The message the wallet signs to import a token: names the token and the identity key. */
export const importChallenge = (tokenId: string, identityKey: string, name: string, at = Date.now()) =>
  `bWalletX: link token ${tokenId} to $${personalKey(name)} for identity ${identityKey} at ${new Date(at).toISOString()}`;

/** Sign the import challenge with the identity key (BRC-100 createSignature). */
export async function signImport(ctx: OneSatContext, tokenId: string, name: string) {
  const args = { protocolID: MESSAGE_SIGNING_PROTOCOL as [0 | 1 | 2, string], keyID: 'identity', counterparty: 'self' };
  const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
  const message = importChallenge(tokenId, publicKey, name);
  const { signature } = await ctx.wallet.createSignature({ ...args, data: Utils.toArray(message, 'utf8') });
  return { message, identityKey: publicKey, signature: Utils.toHex(signature) };
}

/** Save an imported token as this account's personal token (no mint). */
export function linkImported(identityAddress: string, handle: string, token: TokenRef): PersonalLink {
  const link: PersonalLink = {
    name: personalKey(handle),
    tokenId: normId(token.tokenId)!,
    ticker: clean(token.sym),
    supply: token.supply ?? '0',
    createdAt: Date.now(),
    roomTicker: null,
  };
  setPersonalLink(identityAddress, link);
  return link;
}
