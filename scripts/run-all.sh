#!/usr/bin/env bash
# Build bWallet once and install + launch it on every connected target:
# iPhone simulators (booted), USB iPhones, USB Android phones and Android emulators.
#   bash scripts/run-all.sh            # all targets
#   SKIP_ANDROID=1 bash scripts/run-all.sh
set -uo pipefail
cd "$(dirname "$0")/.."

APP_ID=com.bitcoincorp.bwallet
ACTIVITY=org.yours.wallet.MainActivity
TEAM=${DEVELOPMENT_TEAM:-ZQ4NX9NJ89}
ADB=${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}

echo "▸ web build + cap sync"
pnpm cap:sync >/tmp/run-all-sync.log 2>&1 || { tail -20 /tmp/run-all-sync.log; exit 1; }

if [ -z "${SKIP_ANDROID:-}" ]; then
  echo "▸ android release APK"
  bash scripts/android-release.sh >/tmp/run-all-android.log 2>&1 || { tail -20 /tmp/run-all-android.log; exit 1; }
  APK=$(ls -t dist/*.apk | head -1)
  for S in $("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}'); do
    echo "  · $S"
    "$ADB" -s "$S" install -r "$APK" | tail -1
    "$ADB" -s "$S" shell am start -n "$APP_ID/$ACTIVITY" >/dev/null 2>&1 \
      || echo "    (couldn't launch — is the device locked?)"
  done
fi

if [ -z "${SKIP_IOS:-}" ]; then
  for SIM in $(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}'); do
    echo "▸ iOS simulator $SIM"
    xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
      -destination "id=$SIM" -derivedDataPath /tmp/run-all-sim build >/tmp/run-all-sim.log 2>&1 \
      || { tail -20 /tmp/run-all-sim.log; continue; }
    xcrun simctl install "$SIM" /tmp/run-all-sim/Build/Products/Debug-iphonesimulator/App.app
    xcrun simctl terminate "$SIM" "$APP_ID" 2>/dev/null
    xcrun simctl launch "$SIM" "$APP_ID" >/dev/null
  done
  xcrun devicectl list devices 2>/dev/null | grep connected | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | while read -r DEV; do
    UDID=$(xcrun devicectl device info details --device "$DEV" 2>/dev/null | awk -F': ' '/udid/ {print $2; exit}')
    echo "▸ iPhone $DEV"
    xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -destination "id=$UDID" \
      -derivedDataPath /tmp/run-all-dev -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" build \
      >/tmp/run-all-dev.log 2>&1 || { tail -20 /tmp/run-all-dev.log; continue; }
    xcrun devicectl device install app --device "$DEV" /tmp/run-all-dev/Build/Products/Debug-iphoneos/App.app >/dev/null
    xcrun devicectl device process launch --device "$DEV" "$APP_ID" >/dev/null
  done
fi
echo "✓ done"
