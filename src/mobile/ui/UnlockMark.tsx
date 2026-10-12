import xGlyph from '../brand/bwalletx-glyph.svg';
import storeGlyph from '../brand/bwallet-glyph.svg';
import { isBWalletX } from '../storeBuild';

/**
 * The bare gold b above "Welcome back" (owner, 12 Oct 2026): no black tile behind it, and larger
 * than the old tile's letter. bWalletX builds show the b+x glyph (the Desktop shell's mark); the
 * store edition shows the plain gold b.
 */
export const UnlockMark = ({ width = '7.5rem' }: { width?: string }) => (
  <img
    src={isBWalletX() ? xGlyph : storeGlyph}
    alt=""
    aria-hidden
    draggable={false}
    className="block select-none"
    style={{ width, height: width, objectFit: 'contain' }}
  />
);
