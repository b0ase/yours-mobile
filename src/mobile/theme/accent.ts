import { ALL_VARS, DEFAULT_ACCENT, accentById, accentVars, packVars, setCustomAccent, type AccentId } from './accents';
import { deriveMix, normaliseMix, type MixSpec } from './mixer';

/**
 * Applies and stores the app accent (Theme → App colours). Per account on this device only, nothing leaves it.
 * The last-applied accent is also kept under a boot key so main.ts can paint it before the first frame, before
 * the account is known; useAccountAccent then settles on the open account's own choice.
 */
const BOOT_KEY = 'bwx.accent.boot';
const keyFor = (account: string) => `bwx.accent.${account}`;
const MIX_BOOT_KEY = 'bwx.mix.boot';
const mixKeyFor = (account: string) => `bwx.mix.${account}`;
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

/** Sets the pack's CSS variables on <html>. Gold clears them all, so src/accent.css's defaults apply. */
export function applyAccent(id: string | null | undefined): AccentId {
  const a = accentById(id);
  applied = a.id;
  if (typeof document === 'undefined') return a.id;
  const root = document.documentElement;
  const gold = a.id === DEFAULT_ACCENT;
  if (gold) delete root.dataset.bwTheme;
  else root.dataset.bwTheme = a.id;
  // Full packs and the mixer restyle the whole app; accent-only colours keep the Gold base.
  const full = !gold && a.kind !== 'colour';
  if (full) root.dataset.bwPack = a.scheme;
  else delete root.dataset.bwPack;
  // Mono / Duo / Tri: themes.css paints Mono's white cards and tinted buttons from this.
  if (full && a.group) root.dataset.bwTone = a.group;
  else delete root.dataset.bwTone;
  const s = root.style;
  for (const k of ALL_VARS) s.removeProperty(k);
  if (!gold) for (const [k, v] of Object.entries(full ? packVars(a) : accentVars(a))) s.setProperty(k, v);
  s.colorScheme = full && a.scheme === 'light' ? 'light' : '';
  return a.id;
}

const readMix = (k: string): MixSpec | null => {
  try {
    const v = read(k);
    return v ? normaliseMix(JSON.parse(v) as Partial<MixSpec>) : null;
  } catch {
    return null;
  }
};
/** Loads a mix into the 'custom' pack so accentById('custom') can paint it. */
const primeMix = (m: MixSpec | null) => setCustomAccent(m ? deriveMix(m) : null);

/** Startup: paint the last-used accent before the first frame. */
export const applyBootAccent = (): AccentId => {
  primeMix(readMix(MIX_BOOT_KEY));
  return applyAccent(read(BOOT_KEY));
};

/** The account's saved mix, if it has one. */
export const loadMix = (account: string): MixSpec | null => readMix(mixKeyFor(account));

export const loadAccent = (account: string): AccentId => accentById(read(keyFor(account))).id;

/** Applies an account's accent and remembers it for the next startup. */
export function switchToAccountAccent(account: string): AccentId {
  const before = applied;
  const m = readMix(account ? mixKeyFor(account) : MIX_BOOT_KEY);
  primeMix(m);
  const id = applyAccent(account ? read(keyFor(account)) : read(BOOT_KEY));
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  write(MIX_BOOT_KEY, id === 'custom' && m ? JSON.stringify(m) : null);
  if (id !== before) announce();
  return id;
}

/** Saves and applies an account's mix (Mix your own); the account's pack becomes 'custom'. */
export function saveMix(account: string, mix: MixSpec): void {
  const m = normaliseMix(mix);
  const json = JSON.stringify(m);
  if (account) write(mixKeyFor(account), json);
  write(MIX_BOOT_KEY, json);
  primeMix(m);
  saveAccent(account, 'custom');
}

/** Paints a mix without saving it (live preview while sliding). */
export function previewMix(mix: MixSpec): void {
  primeMix(normaliseMix(mix));
  applyAccent('custom');
  announce();
}

/** Saves and applies an account's accent. */
export function saveAccent(account: string, id: AccentId): void {
  if (account) write(keyFor(account), id === DEFAULT_ACCENT ? null : id);
  write(BOOT_KEY, id === DEFAULT_ACCENT ? null : id);
  applyAccent(id);
  announce();
}
