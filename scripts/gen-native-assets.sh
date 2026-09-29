#!/usr/bin/env bash
# Generate iOS/Android app icons and splash screens from assets/<brand>/ masters.
# Requires ImageMagick 7 (`magick`). Usually run via scripts/set-brand.sh.
#   bash scripts/gen-native-assets.sh yours|bwallet
set -euo pipefail
cd "$(dirname "$0")/.."

BRAND=${1:-yours}
ICON=assets/$BRAND/icon-only.png            # 1024x1024, opaque (iOS + legacy Android)
FG=assets/$BRAND/icon-foreground.png        # 1024x1024, transparent, mark inside centre 66%
SPLASH=assets/$BRAND/splash.png             # 2732x2732, logo centred on #010101
BG_COLOR=$([ "$BRAND" = bwallet ] && echo '#62E596' || echo '#010101')   # adaptive icon background
RES=android/app/src/main/res

# iOS
magick "$ICON" -alpha remove -alpha off -resize 1024x1024 ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
  cp "$SPLASH" "ios/App/App/Assets.xcassets/Splash.imageset/$f"
done

# Android launcher icons (legacy 48dp, adaptive foreground 108dp)
for pair in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
  d=${pair%%:*}; s=${pair##*:}
  px=$(awk "BEGIN{print int(48*$s)}"); fg=$(awk "BEGIN{print int(108*$s)}")
  magick "$ICON" -resize ${px}x${px} "$RES/mipmap-$d/ic_launcher.png"
  magick "$ICON" -alpha set -resize ${px}x${px} \( -size ${px}x${px} xc:none -fill white -draw "circle $((px/2)),$((px/2)) $((px/2)),0" \) \
    -compose DstIn -composite "$RES/mipmap-$d/ic_launcher_round.png"
  magick "$FG" -resize ${fg}x${fg} "$RES/mipmap-$d/ic_launcher_foreground.png"
done
cat > "$RES/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$BG_COLOR</color>
</resources>
XML

# Android splash (centre-crop the square master to each size)
splash() { magick "$SPLASH" -resize "${1}x${2}^" -gravity center -extent "${1}x${2}" "$3"; }
splash 480 320 "$RES/drawable/splash.png"
for spec in mdpi:320x480 hdpi:480x800 xhdpi:720x1280 xxhdpi:960x1600 xxxhdpi:1280x1920; do
  d=${spec%%:*}; wh=${spec##*:}; w=${wh%x*}; h=${wh#*x}
  splash "$w" "$h" "$RES/drawable-port-$d/splash.png"
  splash "$h" "$w" "$RES/drawable-land-$d/splash.png"
done
echo "native assets generated"
