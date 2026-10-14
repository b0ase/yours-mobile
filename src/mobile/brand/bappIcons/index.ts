/**
 * The bApp icon library (Option 1, "Monogram + glyph"): black tile, glyph in the app colour, gold b badge.
 * Use <BappIcon slug size />, or bappIconUrl(slug, size) where an image src is needed.
 */
export { BAPP_ICONS, bappIconDef, hasGlyph, initialOf, type BappIconDef } from './registry';
export { GLYPHS, type GlyphSlug } from './glyphs';
export { ICON_SIZES, iconDataUrl, iconSvg, layout, type IconContent } from './render';
export { ALL_BAPP_ICON_SLUGS, bappIconContent, bappIconSvg, bappIconUrl } from './api';
export { BappIcon } from './BappIcon';
