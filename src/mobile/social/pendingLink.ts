/**
 * Link at sign-up (owner, 27 Oct 2026): "We ask the user to link on the first screen. The link persists until after
 * the wallet setup and then they finish the link after they've created their password and gotten their seedphrase."
 *
 * The OAuth round-trip itself is the normal one (socialLogin.ts): it leaves a pending sign-in owned by NEW_ACCOUNT
 * with `signup: true`. That pending sign-in holds only what binding needs (provider, the one-time ticket + this
 * device's secret, and the public profile) and lapses after SIGNUP_TTL_MS. Nothing is signed until the account
 * exists and its seed step is done; then FinishPendingLink signs it with the existing recordLink.
 *
 * This file keeps the other half: a sign-up link that expired or failed is remembered as "unfinished" (the provider
 * name and when, nothing else: no ticket, no secret, no profile), so Link your accounts can offer "Finish linking".
 */

/** How long a sign-in started on the first screen waits for the wallet to be created. */
export const SIGNUP_TTL_MS = 30 * 60_000;
/** Any other pending sign-in (Settings, picture sheet): unchanged. */
export const DEFAULT_TTL_MS = 10 * 60_000;

/** True when a pending sign-in started at `at` has lapsed. */
export const pendingExpired = (p: { at: number; signup?: boolean }, now = Date.now()): boolean =>
  !(now - p.at < (p.signup ? SIGNUP_TTL_MS : DEFAULT_TTL_MS));

/** An unfinished sign-up link stays offered for a week, then quietly drops. */
const UNFINISHED_TTL_MS = 7 * 24 * 60 * 60_000;
const KEY = 'bwallet.links.unfinished';
type Unfinished = Record<string, Record<string, number>>; // owner -> provider -> when

const listeners = new Set<() => void>();
export const onUnfinishedChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

const load = (): Unfinished => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as Unfinished;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const store = (v: Unfinished) => {
  try {
    if (Object.keys(v).length) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the reminder lasts this session only */
  }
  listeners.forEach((l) => l());
};

export function markUnfinished(owner: string, provider: string, now = Date.now()): void {
  if (!owner || !provider) return;
  const v = load();
  v[owner] = { ...(v[owner] || {}), [provider]: now };
  store(v);
}

/** Providers whose sign-up link still needs finishing for `owner`. */
export function unfinishedLinks(owner: string, now = Date.now()): string[] {
  const m = load()[owner] || {};
  return Object.keys(m).filter((p) => now - m[p] < UNFINISHED_TTL_MS);
}

export function clearUnfinished(owner: string, provider: string): void {
  const v = load();
  if (!v[owner]?.[provider]) return;
  delete v[owner][provider];
  if (!Object.keys(v[owner]).length) delete v[owner];
  store(v);
}

/** The account now exists: its sign-up reminders move from NEW_ACCOUNT to it. */
export function bindUnfinished(from: string, to: string): void {
  const v = load();
  if (!from || !to || !v[from]) return;
  v[to] = { ...(v[to] || {}), ...v[from] };
  delete v[from];
  store(v);
}
