/**
 * Wallet look (first look for the owner, 8 Nov 2026: "more black… the navbar needs more attention"). Three directions
 * on one implementation, chosen by localStorage['bwallet:look'] = quiet | slab | chamfer. Unset = quiet with today's
 * navigation. The look only applies on Gold and the accent-only colours (look.css scopes on no data-bw-pack), so
 * full theme packs (White, Nautical…) render exactly as before.
 *
 * Setting the key also turns on the navigation preview for the comparison: the centre b opens Ask b. Slab and chamfer
 * reach the apps by swiping up on Ask b (owner, 8 Nov 2026); quiet keeps a grid icon in the top row.
 */
export type BwLook = 'quiet' | 'slab' | 'chamfer';
export const LOOK_KEY = 'bwallet:look';
const LOOKS: readonly string[] = ['quiet', 'slab', 'chamfer'];

const stored = (): string | null => {
  try {
    return localStorage.getItem(LOOK_KEY);
  } catch {
    return null;
  }
};

export const bwLook = (): BwLook => {
  const v = stored();
  return v && LOOKS.includes(v) ? (v as BwLook) : 'quiet';
};

/** A direction was picked on purpose: the b opens Ask b, and that direction's Apps button shows. */
export const lookNavPreview = (): boolean => {
  const v = stored();
  return !!v && LOOKS.includes(v);
};

try {
  document.documentElement.dataset.bwLook = bwLook();
} catch {
  /* no document (tests) */
}
