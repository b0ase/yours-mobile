/** The tiny ☰ badge on the top-left bAvatar shows until the menu has been opened this many times. */
export const MENU_HINT_OPENS = 3;
export const MENU_HINT_KEY = 'bw.menuAvatar.opens';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const menuOpens = (s: Store | null = store()): number => {
  try {
    const n = Number.parseInt(s?.getItem(MENU_HINT_KEY) ?? '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
};

export const showMenuHint = (s: Store | null = store()) => menuOpens(s) < MENU_HINT_OPENS;

/** Counts one menu open (stops counting once the hint is gone); returns the new count. */
export const countMenuOpen = (s: Store | null = store()): number => {
  const n = menuOpens(s);
  if (n >= MENU_HINT_OPENS) return n;
  try {
    s?.setItem(MENU_HINT_KEY, String(n + 1));
  } catch {
    /* storage blocked: the hint just stays */
  }
  return n + 1;
};
