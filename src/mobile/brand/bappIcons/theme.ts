import { accentById, DEFAULT_ACCENT, type Accent } from '../../theme/accents';
import { useAccentId } from '../../theme/useAccent';
import { isSetIcon, themedIconUrl, type IconLook } from './render';

/** The icon look for a pack: Gold (and accent-only colours) keep the original set. */
export const iconLookFor = (a: Accent): IconLook => {
  if (a.id === DEFAULT_ACCENT || a.kind === 'colour') return null;
  if (a.group === 'mono') return { mono: true, tile: '#FFFFFF', edge: a.line, ink: a.accent, hi: a.hi, lo: a.lo };
  return { mono: false, tile: a.bg, edge: a.line, ink: a.accent, hi: a.hi, lo: a.lo };
};

/** The active pack's icon look; re-renders when the theme changes. */
export const useIconLook = (): IconLook => iconLookFor(accentById(useAccentId()));

/**
 * An icon src that follows the theme: set icons are redrawn in the pack's look; own artwork (PNG logos) is
 * returned as-is with `paper: true` on Mono packs, so the caller puts it on a white tile with padding.
 */
export function useThemedIcon(src: string | undefined): { src: string | undefined; paper: boolean } {
  const look = useIconLook();
  if (!src) return { src, paper: false };
  if (isSetIcon(src)) return { src: themedIconUrl(src, look), paper: false };
  return { src, paper: !!look?.mono };
}
