#!/usr/bin/env bash
# Build one release channel (src/mobile/channel.ts):
#
#   bash scripts/channel-build.sh android-play     → dist/bwallet-<ver>-play.aab (Play) + .apk (testing)
#   bash scripts/channel-build.sh android-direct   → dist/bwallet-<ver>-direct.apk (site download)
#   bash scripts/channel-build.sh ios-store        → dist/bwallet-<ver>-ios-store.xcarchive (App Store)
#   bash scripts/channel-build.sh ios-private      → dist/bwallet-<ver>-ios-private.xcarchive (Ad Hoc / EU)
#
# INSTALL=1 installs and launches it on every connected target for that platform instead: Android phones and
# emulators (release-signed, so existing data is kept), booted iPhone simulators and USB iPhones (Debug builds).
#
# App IDs: the store channels keep com.bitcoincorp.bwallet; android-direct is .direct and ios-private is .private,
# named "bWallet ✦", so a private build sits beside the store one (separate wallets; restore from the phrase).
# The Android upload key lives outside the repo (~/.yours-mobile/upload-keystore.jks); its password is read from
# the macOS Keychain entry "yours-mobile-android-upload" and never written to disk.
# Afterwards android/ and ios/ hold the default (dev) web build again.
set -euo pipefail
cd "$(dirname "$0")/.."

CH=${1:-}
case "$CH" in
  ios-store | android-play) STORE=1 ;;
  ios-private | android-direct) STORE= ;;
  *) echo "usage: $0 <ios-store|ios-private|android-play|android-direct>" >&2; exit 2 ;;
esac

restore() { pnpm build:mobile >/dev/null && pnpm exec cap sync >/dev/null; }

# retry "<what>" cmd…: up to 3 tries, 5 s apart; on the last failure print the tool's own error.
retry() {
  local what=$1 out
  shift
  for n in 1 2 3; do
    if out=$("$@" 2>&1); then return 0; fi
    [[ $n -lt 3 ]] && sleep 5
  done
  echo "    ✗ $what failed:" >&2
  echo "$out" | grep -iE "error|fail|locked|unable|not" | head -5 >&2
  return 1
}
trap restore EXIT

echo "▸ web build ($CH)"
VITE_CHANNEL=$CH VITE_STORE_BUILD=${STORE:+1} pnpm build:mobile >/dev/null
pnpm exec cap sync >/dev/null
mkdir -p dist

if [[ $CH == android-* ]]; then
  FLAVOR=${CH#android-}
  CAP=$(tr '[:lower:]' '[:upper:]' <<<"${FLAVOR:0:1}")${FLAVOR:1}
  APP_ID=com.bitcoincorp.bwallet$([[ $FLAVOR == direct ]] && echo .direct || true)
  VERSION=$(sed -nE 's/.*versionName "([^"]+)".*/\1/p' android/app/build.gradle)
  export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
  export YOURS_UPLOAD_KEYSTORE=${YOURS_UPLOAD_KEYSTORE:-$HOME/.yours-mobile/upload-keystore.jks}
  YOURS_UPLOAD_PASSWORD=$(security find-generic-password -s yours-mobile-android-upload -a upload -w)
  export YOURS_UPLOAD_PASSWORD

  echo "▸ gradle $FLAVOR release"
  TASKS=("assemble${CAP}Release")
  [[ $FLAVOR == play && -z ${INSTALL:-} ]] && TASKS+=("bundlePlayRelease")
  (cd android && ./gradlew --quiet "${TASKS[@]}")
  APK=android/app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release.apk

  # Refuse anything not signed with the upload key.
  APKSIGNER=$(ls -d "$HOME"/Library/Android/sdk/build-tools/*/apksigner | tail -1)
  "$APKSIGNER" verify --print-certs "$APK" | grep -q "Yours Wallet Mobile (unofficial)"

  if [[ -n ${INSTALL:-} ]]; then
    ADB=${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb
    for S in $("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}'); do
      echo "  · $S $("$ADB" -s "$S" install -r "$APK" 2>&1 | tail -1)"
      "$ADB" -s "$S" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
        || echo "    (couldn't launch: is the device locked?)"
    done
  else
    cp "$APK" "dist/bwallet-$VERSION-$FLAVOR.apk"
    OUT=("bwallet-$VERSION-$FLAVOR.apk")
    if [[ $FLAVOR == play ]]; then
      cp android/app/build/outputs/bundle/playRelease/app-play-release.aab "dist/bwallet-$VERSION-play.aab"
      OUT+=("bwallet-$VERSION-play.aab")
    fi
    (cd dist && shasum -a 256 "${OUT[@]}" >"SHA256SUMS-$FLAVOR")
    echo "built dist/${OUT[*]}"
    cat "dist/SHA256SUMS-$FLAVOR"
  fi
else
  APP_ID=com.bitcoincorp.bwallet
  NAME=bWallet
  if [[ $CH == ios-private ]]; then APP_ID=$APP_ID.private; NAME="bWallet ✦"; fi
  TEAM=${DEVELOPMENT_TEAM:-ZQ4NX9NJ89}
  VERSION=$(sed -nE 's/.*MARKETING_VERSION = ([^;]+);.*/\1/p' ios/App/App.xcodeproj/project.pbxproj | head -1)
  OVR=(PRODUCT_BUNDLE_IDENTIFIER="$APP_ID" BWALLET_DISPLAY_NAME="$NAME" BWALLET_CHANNEL="$CH" DEVELOPMENT_TEAM="$TEAM")
  XB=(xcodebuild -project ios/App/App.xcodeproj -scheme App -allowProvisioningUpdates -quiet)

  if [[ -n ${INSTALL:-} ]]; then
    for SIM in $(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}'); do
      echo "▸ iOS simulator $SIM"
      "${XB[@]}" -configuration Debug -destination "id=$SIM" -derivedDataPath "/tmp/bw-$CH-sim" build "${OVR[@]}"
      xcrun simctl install "$SIM" "/tmp/bw-$CH-sim/Build/Products/Debug-iphonesimulator/App.app"
      xcrun simctl launch --terminate-running-process "$SIM" "$APP_ID" >/dev/null
    done
    xcrun devicectl list devices 2>/dev/null | awk '/available \(paired\)|connected/' \
      | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | while read -r DEV; do
      UDID=$(xcrun devicectl device info details --device "$DEV" 2>/dev/null | awk -F': ' '/udid/ {print $2; exit}')
      echo "▸ iPhone $DEV"
      "${XB[@]}" -configuration Debug -destination "id=$UDID" -derivedDataPath "/tmp/bw-$CH-dev" build "${OVR[@]}"
      # A USB / Wi-Fi iPhone drops out now and then (locked, asleep, tunnel restarting): retry, and say why.
      retry "install on $DEV" xcrun devicectl device install app --device "$DEV" "/tmp/bw-$CH-dev/Build/Products/Debug-iphoneos/App.app"
      retry "launch on $DEV (unlock the iPhone)" xcrun devicectl device process launch --terminate-existing --device "$DEV" "$APP_ID" \
        || echo "    installed; open it on the phone"
    done
  else
    ARCHIVE="dist/bwallet-$VERSION-$CH.xcarchive"
    echo "▸ xcodebuild archive"
    "${XB[@]}" -configuration Release -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" archive "${OVR[@]}"
    echo "built $ARCHIVE (export from Xcode › Organizer: App Store Connect for ios-store, Ad Hoc for ios-private)"
  fi
fi
