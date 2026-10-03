#!/usr/bin/env bash
# Render the bWalletX (b + x) marks for the full-feature channels (android-direct, ios-private, web/dev)
# from src/mobile/brand/bwalletx-{mark,glyph}.svg. The store builds keep the plain b (gen-brand-mark.sh).
#   Android: launcher icons + splash in the direct flavour's res (overrides src/main/res)
#   iOS:     AppIconX + SplashX asset sets (channel-build.sh selects them for ios-private)
#   In-app:  src/mobile/brand/bcorpx/white-logo.png (unlock screen; vite.brand.ts)
# Needs rsvg-convert and magick.
set -euo pipefail
cd "$(dirname "$0")/.."
B=src/mobile/brand
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

rsvg-convert -w 1024 -h 1024 $B/bwalletx-mark.svg -o "$T/icon.png"
rsvg-convert -w 506 -h 506 $B/bwalletx-glyph.svg -o "$T/g.png"
magick -size 1024x1024 xc:none "$T/g.png" -gravity center -composite "$T/fg.png"
rsvg-convert -w 760 -h 760 $B/bwalletx-glyph.svg -o "$T/s.png"
magick -size 2732x2732 xc:black "$T/s.png" -gravity center -composite "$T/splash.png"

mkdir -p $B/bcorpx
rsvg-convert -w 76 -h 76 $B/bwalletx-glyph.svg -o $B/bcorpx/white-logo.png
rsvg-convert -w 512 -h 512 $B/bwalletx-mark.svg -o $B/bcorpx/icon.png # YoursIcon (welcome / unlock)

# Android (direct flavour)
RES=android/app/src/direct/res
for pair in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
  d=${pair%%:*}; s=${pair##*:}
  px=$(awk "BEGIN{print int(48*$s)}"); fg=$(awk "BEGIN{print int(108*$s)}")
  mkdir -p "$RES/mipmap-$d"
  magick "$T/icon.png" -resize ${px}x${px} "$RES/mipmap-$d/ic_launcher.png"
  magick "$T/icon.png" -alpha set -resize ${px}x${px} \( -size ${px}x${px} xc:none -fill white -draw "circle $((px/2)),$((px/2)) $((px/2)),0" \) \
    -compose DstIn -composite "$RES/mipmap-$d/ic_launcher_round.png"
  magick "$T/fg.png" -resize ${fg}x${fg} "$RES/mipmap-$d/ic_launcher_foreground.png"
done
splash() { mkdir -p "$(dirname "$3")"; magick "$T/splash.png" -resize "${1}x${2}^" -gravity center -extent "${1}x${2}" "$3"; }
splash 480 320 "$RES/drawable/splash.png"
for spec in mdpi:320x480 hdpi:480x800 xhdpi:720x1280 xxhdpi:960x1600 xxxhdpi:1280x1920; do
  d=${spec%%:*}; wh=${spec##*:}; w=${wh%x*}; h=${wh#*x}
  splash "$w" "$h" "$RES/drawable-port-$d/splash.png"
  splash "$h" "$w" "$RES/drawable-land-$d/splash.png"
done

# iOS
X=ios/App/App/Assets.xcassets
mkdir -p $X/AppIconX.appiconset $X/SplashX.imageset
magick "$T/icon.png" -alpha remove -alpha off $X/AppIconX.appiconset/AppIcon-512@2x.png
cp $X/AppIcon.appiconset/Contents.json $X/AppIconX.appiconset/
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do cp "$T/splash.png" "$X/SplashX.imageset/$f"; done
cp $X/Splash.imageset/Contents.json $X/SplashX.imageset/
# Chrome extension icons (scripts/build.ts)
E=assets/bwalletx-ext
mkdir -p $E
for s in 16 32 48 128 192 512; do rsvg-convert -w "$s" -h "$s" $B/bwalletx-mark.svg -o "$E/icon$s.png"; done
cp "$E/icon512.png" "$E/maskable-512.png"
magick "$E/icon16.png" "$E/icon32.png" "$E/icon48.png" "$E/favicon.ico"
echo "bWalletX marks generated"
