/**
 * "Choose your name", the first step of Create Account (owner, 28 Oct 2026; bitcoin-corp docs/PROVABLE-NAMES.md).
 *
 * The user signs in with Google / X / GitHub / LinkedIn on the first screen and picks the social handle that sign-in
 * proves (name.gmail, name.x, name.github, slug.linkedin). It becomes the account's main paymail once the wallet
 * exists, and then its name token is minted free. A plain name stays an option ("or choose a plain name").
 *
 * The choice is held here (this device, 30 minutes, like the sign-up link) until the wallet exists; the sign-in ticket
 * itself stays in socialLogin.ts. Nothing is claimed before the wallet has keys.
 */
import type { SocialProfile } from '../chat/api';

export type NameProvider = 'x' | 'google' | 'github' | 'linkedin';
export type NameChoice = { provider: NameProvider; alias: string; at: number };

export const NAME_SUFFIX: Record<NameProvider, string> = {
  x: 'x',
  google: 'gmail',
  github: 'github',
  linkedin: 'linkedin',
};
export const NAME_PROVIDER_LABEL: Record<NameProvider, string> = {
  x: 'X',
  google: 'Google',
  github: 'GitHub',
  linkedin: 'LinkedIn',
};

const KEY = 'bwallet.nameChoice';
const TTL_MS = 30 * 60_000;
const BASE_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** The social handle a returned sign-in offers: the server's `social_alias`, checked against its provider's suffix. */
export function handleForProfile(p: Pick<SocialProfile, 'provider' | 'social_alias'> | null): string | null {
  if (!p || p.provider === 'ebay') return null;
  const a = String(p.social_alias ?? '').toLowerCase();
  const suffix = NAME_SUFFIX[p.provider];
  if (!a.endsWith(`.${suffix}`)) return null;
  return BASE_RE.test(a.slice(0, -suffix.length - 1)) ? a : null;
}

/**
 * LinkedIn only: the slug the user typed (LinkedIn gives no vanity name, so the user picks it; it is bound to their
 * LinkedIn account when claimed). Other providers' names can't be edited: they are the account's own name.
 */
export function linkedinAlias(slug: string): string | null {
  const s = slug
    .trim()
    .toLowerCase()
    .replace(/\.linkedin$/, '');
  return BASE_RE.test(s) ? `${s}.linkedin` : null;
}

const listeners = new Set<() => void>();
const fire = () => listeners.forEach((l) => l());
/** Called when a choice is made or cleared. Returns the unsubscribe. */
export const onNameChoiceStep = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const rememberNameChoice = (c: Omit<NameChoice, 'at'>, now = Date.now()) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...c, at: now }));
  } catch {
    /* private mode: the user picks again on Choose your handle */
  }
  fire();
};
export const pendingNameChoice = (now = Date.now()): NameChoice | null => {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null') as NameChoice | null;
    if (!c || !(now - c.at < TTL_MS) || !NAME_SUFFIX[c.provider]) return null;
    return c.alias.endsWith(`.${NAME_SUFFIX[c.provider]}`) ? c : null;
  } catch {
    return null;
  }
};
export const clearNameChoice = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
  fire();
};

/** What has to happen next for a held choice, given the sign-in this account now holds. */
export function nextNameStep(
  choice: NameChoice | null,
  proof: { profile: Pick<SocialProfile, 'provider' | 'id_token'> } | null,
): 'none' | 'claim' | 'confirm-linkedin' | 'sign-in-again' {
  if (!choice) return 'none';
  if (!proof || proof.profile.provider !== choice.provider) return 'sign-in-again';
  // LinkedIn names are bound by a LinkedIn-signed token for THIS wallet's key, which only exists after the wallet does.
  if (choice.provider === 'linkedin' && !proof.profile.id_token) return 'confirm-linkedin';
  return 'claim';
}

/** On-screen copy (owner, 28 Oct 2026): one or two plain sentences; no "invest", "returns", "yield", "earn". */
export const CHOOSE_NAME_TITLE = 'Choose your name';
export const CHOOSE_NAME_EXPLAINER =
  'This name is your account, and it is provably yours through the account you sign in with. It also becomes your first token, your name token, which we mint for you free.';
export const PLAIN_NAME_LINK = 'or choose a plain name';
