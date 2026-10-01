#!/usr/bin/env bash
# Renders the bWallet extension / web wallet icons from the ring-b mark
# (assets/bwallet-ext/ring-b.svg) on black. Needs rsvg-convert and magick.
# Output: assets/bwallet-ext/icon{16,32,48,128,192,512}.png, maskable-512.png, favicon.ico
set -euo pipefail
cd "$(dirname "$0")/../assets/bwallet-ext"
# Same mark on a black square, so toolbar and store icons read on any theme.
sed 's#<defs>#<rect width="120" height="120" fill="\#000"/><defs>#' ring-b.svg > /tmp/bwallet-ring-b-black.svg
for s in 16 32 48 128 192 512; do
  rsvg-convert -w "$s" -h "$s" /tmp/bwallet-ring-b-black.svg -o "icon$s.png"
done
# Maskable (PWA): mark at 80% inside the safe zone on black.
rsvg-convert -w 410 -h 410 ring-b.svg -o /tmp/bwallet-mark-410.png
magick -size 512x512 xc:black /tmp/bwallet-mark-410.png -gravity center -composite maskable-512.png
magick icon16.png icon32.png icon48.png favicon.ico
rm -f /tmp/bwallet-ring-b-black.svg /tmp/bwallet-mark-410.png
ls -1
