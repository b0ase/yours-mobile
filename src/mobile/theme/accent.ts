import { DEFAULT_ACCENT, accentById, accentVars, type AccentId } from './accents';

/**
 * Applies and stores the app accent (Theme → App colours). Per account on this device only, nothing leaves it.
 * The last-applied accent is also kept under a boot key so main.ts can paint it before the first frame, before
 * the account is known; useAccountAccent then settles on the open account's own choice.
 */
const BOOT_KEY = 'bwx.accent.boot';
const keyFor = (account: string) => `bwx.accent.${account}`;
export const ACCENT_EVENT = 'bwx-accent';

let applied: AccentId = DEFAULT_ACCENT;
/** The accent currently painted on <html> (for art drawn in JS, e.g. bAvatar tint). */
export const currentAccentId = (): AccentId => applied;

const announce = () => {
  try {
    window.dispatchEvent(new Event(ACCENT_EVENT));
  } catch {
    /* no window (tests) */
  }
};

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked or full: the accent still applies for this session */
  }
};

/** Sets the accent's CSS variables on <html>. Gold clears them, so src/accent.css's defaults apply. */
export function applyAccent(id: string | null | undefined): AccentId {
  const a = accentById(id);
  applied = a.id;
  if (typeof document === 'undefined') return a.id;
  const root = document.documentElement;
  if (a.id === DEFAULT_ACCENT) delete root.dataset.bwTheme;
  else root.dataset.bwTheme = a.id;
  const s = root.style;
  for (const [k, v] of Object.entries(accentVars(a))) {
    if (a.id === DEFAULT_ACCENT) s.removeProperty(k);
    else s.setProperty(k, v);
  }
  return a.id;
}

/** Startup: paint the last-used accent before the first frame. */
export const applyBootAccent = (): AccentId => applyAccent(read(BOOT_KEY));

export const loadAccent = (account: string): AccentId => accentById(read(keyFor(account))).id;

/** Applies an account's accent and remembers it for the next startup. */
export function switchToAccountAccent(account: string): AccentId {
  const before = applied;
  const id = applyAccent(account ? read(keyFor(account)) : read(BOOT_KEY));
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  if (id !== before) announce();
  return id;
}

/** Saves and applies an account's accent. */
export function saveAccent(account: string, id: AccentId): void {
  if (account) write(keyFor(account), id === DEFAULT_ACCENT ? null : id);
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  applyAccent(id);
  announce();
}
