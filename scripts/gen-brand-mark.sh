#!/usr/bin/env bash
# Render every bWallet (bcorp brand) mark PNG from the SVG masters in src/mobile/brand/:
#   bwallet-mark.svg / bwallet-mark-flat.svg    icon tile: b on solid black
#   bwallet-glyph.svg / bwallet-glyph-flat.svg  bare b (splash, logos)
# FILL picks the letter fill: gradient (default; metallic gold #FFE58A -> #FFD24D -> #C98F00)
# or flat (#FFD24D). Then regenerates native (iOS/Android) and extension icons.
#   bash scripts/gen-brand-mark.sh            # gradient
#   FILL=flat bash scripts/gen-brand-mark.sh  # flat gold
# Needs rsvg-convert and magick.
set -euo pipefail
cd "$(dirname "$0")/.."
B=src/mobile/brand
case "${FILL:-gradient}" in
  gradient) TILE=$B/bwallet-mark.svg; GLYPH=$B/bwallet-glyph.svg ;;
  flat) TILE=$B/bwallet-mark-flat.svg; GLYPH=$B/bwallet-glyph-flat.svg ;;
  *) echo "FILL must be gradient or flat" >&2; exit 1 ;;
esac
A=assets/bcorp
L=$B/bcorp
X=assets/bwallet-ext
T=$(mktemp -d)

# Native masters (consumed by gen-native-assets.sh). The store app (plain bWallet) flips the colours
# (owner, 4 Oct 2026): black b on yellow, where bWalletX is gold b on black. In-app logos stay gold.
STILE=$B/bwallet-store-mark.svg
SGLYPH=$B/bwallet-store-glyph.svg
rsvg-convert -w 1024 -h 1024 "$STILE" -o "$A/icon-only.png"
cp "$STILE" "$A/icon.svg"
magick -size 1024x1024 xc:'#F5B800' "$A/icon-background.png"
# Adaptive foreground: same letter size as the tile once Android masks to the 72dp view.
rsvg-convert -w 506 -h 506 "$SGLYPH" -o "$T/fg.png"
magick -size 1024x1024 xc:none "$T/fg.png" -gravity center -composite "$A/icon-foreground.png"
# Splash: bare black b centred on yellow (same in light and dark)
rsvg-convert -w 760 -h 760 "$SGLYPH" -o "$T/splash.png"
magick -size 2732x2732 xc:'#F5B800' "$T/splash.png" -gravity center -composite "$A/splash.png"
cp "$A/splash.png" "$A/splash-dark.png"

# In-app logos (swapped in by vite.brand.ts; icon.png is also the default avatar)
rsvg-convert -w 512 -h 512 "$TILE" -o "$L/icon.png"
rsvg-convert -w 76 -h 76 "$GLYPH" -o "$L/white-logo.png"
rsvg-convert -w 130 -h 130 "$GLYPH" -o "$T/h.png"
magick -size 513x130 xc:none "$T/h.png" -gravity west -composite "$L/horizontal-logo.png"

# Extension / web wallet icons (copied into the build by scripts/build.ts)
for s in 16 32 48 128 192 512; do rsvg-convert -w "$s" -h "$s" "$TILE" -o "$X/icon$s.png"; done
cp "$X/icon512.png" "$X/maskable-512.png" # the tile keeps the b inside the 80% safe zone
magick "$X/icon16.png" "$X/icon32.png" "$X/icon48.png" "$X/favicon.ico"
rm -rf "$T"

bash scripts/gen-native-assets.sh bcorp
echo "bWallet mark (${FILL:-gradient}) generated"
