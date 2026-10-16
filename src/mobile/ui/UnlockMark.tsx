import xGlyph from '../brand/bwalletx-glyph.svg';
import storeGlyph from '../brand/bwallet-glyph.svg';
import { B_OUTLINE_COUNTER, B_OUTLINE_OUTER, B_OUTLINE_VIEWBOX } from '../brand/bOutline';
import { isBWalletX } from '../storeBuild';
import { DEFAULT_ACCENT, accentById } from '../theme/accents';
import { useAccentId } from '../theme/useAccent';

/**
 * The bare gold b above "Welcome back" (owner, 12 Oct 2026): no black tile behind it, and larger
 * than the old tile's letter. bWalletX builds show the b+x glyph (the Desktop shell's mark); the
 * store edition shows the plain gold b. Light packs (White and the paper packs) show the clean
 * outline b in the pack's ink, as their splash does (owner, 16 Oct 2026).
 */
export const UnlockMark = ({ width = '7.5rem' }: { width?: string }) => {
  const pack = accentById(useAccentId());
  if (pack.id !== DEFAULT_ACCENT && pack.kind !== 'colour' && pack.scheme === 'light')
    return (
      <svg
        data-testid="unlock-mark-outline"
        viewBox={B_OUTLINE_VIEWBOX}
        aria-hidden
        className="block select-none"
        style={{ width, height: width }}
        fill="none"
        stroke={pack.group === 'mono' ? pack.text : pack.accent}
        strokeWidth={4}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d={B_OUTLINE_OUTER} />
        <path d={B_OUTLINE_COUNTER} />
      </svg>
    );
  return (
    <img
      src={isBWalletX() ? xGlyph : storeGlyph}
      alt=""
      aria-hidden
      draggable={false}
      className="block select-none"
      style={{ width, height: width, objectFit: 'contain' }}
    />
  );
};
