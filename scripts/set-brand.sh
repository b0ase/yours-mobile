#!/usr/bin/env bash
# Switch the app's visible brand on both platforms: display name, Face ID
# text, icons and splash. The app ID (com.bitcoincorp.bwallet) never changes.
# Build the web layer with the same brand: MOBILE_BRAND=<brand> pnpm cap:sync
#
#   bash scripts/set-brand.sh bcorp     # "bWallet" (default; public store listings)
#   bash scripts/set-brand.sh bwallet   # "bWallet"
#   bash scripts/set-brand.sh yours     # "Yours Wallet Mobile" (personal / internal testing only)
set -euo pipefail
cd "$(dirname "$0")/.."
BRAND=${1:?usage: set-brand.sh bcorp|bwallet|yours}
case "$BRAND" in
  # SHORT is the home-screen label; longer names get cut off under the icon.
  bcorp) NAME="bWallet"; SHORT="bWallet" ;;
  yours) NAME="Yours Wallet Mobile"; SHORT="Yours Mobile" ;;
  bwallet) NAME="bWallet"; SHORT="bWallet" ;;
  *) echo "unknown brand: $BRAND" >&2; exit 1 ;;
esac

# Capacitor config
sed -i '' -E "s/^  appName: '[^']*',/  appName: '$NAME',/" capacitor.config.ts

# Android launcher label
sed -i '' -E "s#(<string name=\"app_name\">)[^<]*#\1$SHORT#; s#(<string name=\"title_activity_main\">)[^<]*#\1$SHORT#" \
  android/app/src/main/res/values/strings.xml

# iOS home-screen name and Face ID prompt
PLIST=ios/App/App/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $SHORT" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSFaceIDUsageDescription Unlock $NAME with Face ID instead of typing your password." "$PLIST"

bash scripts/gen-native-assets.sh "$BRAND"
echo "brand set to $NAME — now: MOBILE_BRAND=$BRAND pnpm cap:sync"
