import type { WalletInterface } from '@bsv/sdk';
import type { SocialProfile } from '../chat/api';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { signRequest } from '../names/paymail';
import { BMARKETX_API, ebayAvailable } from './ebayLink';
import { clearUnfinished } from './pendingLink';

/**
 * "Link your accounts" (owner, 18 Oct 2026). bWalletX is not an OAuth sign-in: the wallet IS the account, and a
 * linked X / Google / GitHub / LinkedIn / HandCash account is a badge on it. Each link is:
 *  1. proved by the provider (bWalletX's own OAuth service, site/lib/social.js: the ticket only opens with this
 *     phone's secret; HandCash: bit-sign's HandCash exchange), then
 *  2. signed by the wallet's identity key ("link provider account -> identityKey", the same BRC-43 signed message
 *     as name bindings, names/paymail.ts signRequest), so anyone can check the link without trusting our server.
 * Google gives an "email verified" tick only: the address is never stored, shown or put into a handle (a
 * Gmail-derived handle published addresses before). Nothing here is ever recorded without a real proof.
 */
export type LinkProvider = 'x' | 'google' | 'github' | 'linkedin' | 'handcash' | 'ebay';
export type AccountLink = {
  provider: LinkProvider;
  /** sha256(provider:accountId): a stable id that reveals nothing (never an email). */
  account: string;
  /** Public handle: X @name, GitHub login, HandCash $handle. '' for Google and LinkedIn. */
  handle: string;
  display?: string;
  emailVerified?: boolean;
  identityKey: string;
  timestamp: number;
  signature: string;
  /** The paymail server keeps a public copy (badge others can see); false = on this phone only so far. */
  published?: boolean;
};

export const LINK_ACTION = 'link';
export const PROVIDER_LABEL: Record<LinkProvider, string> = {
  x: 'X',
  google: 'Google',
  github: 'GitHub',
  linkedin: 'LinkedIn',
  handcash: 'HandCash',
  ebay: 'eBay',
};

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** The public handle a link may show: never anything from an email address. */
export function linkHandle(provider: LinkProvider, name: string): string {
  const n = String(name || '')
    .trim()
    .replace(/^[@$]/, '')
    .toLowerCase();
  if (provider === 'google' || provider === 'linkedin' || n.includes('@')) return '';
  // eBay user IDs run to 64 characters and may hold '*'.
  if (provider === 'ebay') return /^[a-z0-9_.*-]{1,64}$/.test(n) ? n : '';
  return /^[a-z0-9_.-]{1,39}$/.test(n) ? n : '';
}

/** The signed fields for a link (sorted and joined by signedMessage). */
export async function linkFields(provider: LinkProvider, accountId: string, name: string) {
  if (!accountId) throw new Error('Please update the app and link again.');
  return {
    provider,
    account: await sha256Hex(`${provider}:${accountId}`),
    handle: linkHandle(provider, name),
  };
}

/** What the badge says. Google: a tick, never the address. */
export function badgeText(l: Pick<AccountLink, 'provider' | 'handle' | 'display'>): string {
  if (l.provider === 'google') return 'Google · email verified';
  if (l.provider === 'x') return l.handle ? `@${l.handle} on X` : 'X';
  if (l.provider === 'github') return l.handle ? `${l.handle} on GitHub` : 'GitHub';
  if (l.provider === 'ebay') return l.handle ? `${l.handle} on eBay` : 'eBay';
  if (l.provider === 'handcash') return l.handle ? `$${l.handle} on HandCash` : 'HandCash';
  return l.display ? `${l.display} on LinkedIn` : 'LinkedIn';
}

const key = (owner: string) => `bwallet.links.${owner}`;
const listeners = new Set<() => void>();
export const onLinksChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export function getLinks(owner: string): AccountLink[] {
  if (!owner) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key(owner)) || '[]') as AccountLink[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const save = (owner: string, links: AccountLink[]) => {
  try {
    localStorage.setItem(key(owner), JSON.stringify(links));
  } catch {
    /* private mode: the link lasts this session only */
  }
  listeners.forEach((l) => l());
};
export const linkFor = (owner: string, provider: LinkProvider) => getLinks(owner).find((l) => l.provider === provider);
export const unlink = (owner: string, provider: LinkProvider) =>
  save(
    owner,
    getLinks(owner).filter((l) => l.provider !== provider),
  );

type Proof = { ticket: string; secret: string };

/**
 * Sign and keep a link after a real proof. `profile` comes from the OAuth preview (or HandCash's exchange).
 * Tries to publish it (POST /api/social/link, which re-checks the ticket and the signature); a server without
 * that route leaves it on this phone, still signed.
 */
export async function recordLink(
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  owner: string,
  provider: LinkProvider,
  profile: Pick<SocialProfile, 'id' | 'name' | 'display'>,
  proof?: Proof,
): Promise<AccountLink> {
  const fields = await linkFields(provider, profile.id || '', profile.name);
  const existing = linkFor(owner, provider);
  if (existing && existing.account === fields.account) return existing;
  const s = await signRequest(wallet, LINK_ACTION, fields);
  const link: AccountLink = {
    ...fields,
    display: provider === 'google' ? undefined : profile.display || undefined,
    emailVerified: provider === 'google' ? true : undefined,
    identityKey: s.identityKey,
    timestamp: s.timestamp,
    signature: s.signature,
  };
  if (proof && provider !== 'handcash') link.published = await publishLink(link, proof);
  save(owner, [...getLinks(owner).filter((l) => l.provider !== provider), link]);
  clearUnfinished(owner, provider);
  return link;
}

async function publishLink(link: AccountLink, proof: Proof): Promise<boolean> {
  // eBay tickets are bMarketX's (ebayLink.ts); the rest are the paymail server's.
  const url =
    link.provider === 'ebay' ? `${BMARKETX_API}/api/ebay/wallet/link` : `${BWALLET_PAYMAIL_API}/api/social/link`;
  if (link.provider !== 'ebay' && !BWALLET_PAYMAIL_API) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...proof,
        identityKey: link.identityKey,
        timestamp: link.timestamp,
        signature: link.signature,
        fields: { provider: link.provider, account: link.account, handle: link.handle },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export type ProviderState = Record<'x' | 'google' | 'github' | 'linkedin' | 'ebay' | 'handcash', boolean>;
/**
 * X and Google have run since 4 Oct; GitHub / LinkedIn only once the server says their OAuth apps are set up; eBay
 * only once bMarketX's wallet-mode eBay route answers (ebayLink.ts). HandCash (owner, 31 Oct 2026: "just another OAuth
 * provider" in Link an account) only once the paymail server's /api/social/providers reports `handcash: true`, i.e.
 * site/lib/social.js has a HandCash start/callback; until then its tile stays hidden like GitHub / LinkedIn.
 */
export const DEFAULT_PROVIDERS: ProviderState = {
  x: true,
  google: true,
  github: false,
  linkedin: false,
  ebay: false,
  handcash: false,
};
export async function fetchProviders(f: typeof fetch = fetch): Promise<ProviderState> {
  const ebay = ebayAvailable(f);
  if (!BWALLET_PAYMAIL_API) return { ...DEFAULT_PROVIDERS, ebay: await ebay };
  try {
    const r = await f(`${BWALLET_PAYMAIL_API}/api/social/providers`);
    if (!r.ok) return { ...DEFAULT_PROVIDERS, ebay: await ebay };
    const j = (await r.json()) as Partial<ProviderState>;
    return {
      x: j.x !== false,
      google: j.google !== false,
      github: j.github === true,
      linkedin: j.linkedin === true,
      handcash: j.handcash === true,
      ebay: await ebay,
    };
  } catch {
    return { ...DEFAULT_PROVIDERS, ebay: await ebay };
  }
}
