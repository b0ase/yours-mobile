#!/usr/bin/env bash
# Build release-signed Android artifacts: an APK for direct download and an
# AAB for Google Play. The upload key lives outside the repo
# (~/.yours-mobile/upload-keystore.jks); its password is read from the macOS
# Keychain entry "yours-mobile-android-upload" and never written to disk.
#
#   bash scripts/android-release.sh      → dist/yours-wallet-mobile-<version>.apk/.aab + SHA256SUMS
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
export YOURS_UPLOAD_KEYSTORE=${YOURS_UPLOAD_KEYSTORE:-$HOME/.yours-mobile/upload-keystore.jks}
YOURS_UPLOAD_PASSWORD=$(security find-generic-password -s yours-mobile-android-upload -a upload -w)
export YOURS_UPLOAD_PASSWORD

pnpm cap:sync >/dev/null
(cd android && ./gradlew --quiet clean assembleRelease bundleRelease)

VERSION=$(sed -nE 's/.*versionName "([^"]+)".*/\1/p' android/app/build.gradle)
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk "dist/yours-wallet-mobile-$VERSION.apk"
cp android/app/build/outputs/bundle/release/app-release.aab "dist/yours-wallet-mobile-$VERSION.aab"
(cd dist && shasum -a 256 "yours-wallet-mobile-$VERSION.apk" "yours-wallet-mobile-$VERSION.aab" > SHA256SUMS)

# Refuse to ship anything not signed with the upload key.
APKSIGNER=$(ls -d "$HOME"/Library/Android/sdk/build-tools/*/apksigner | tail -1)
"$APKSIGNER" verify --print-certs "dist/yours-wallet-mobile-$VERSION.apk" | grep -q "Yours Wallet Mobile (unofficial)"
echo "built dist/yours-wallet-mobile-$VERSION.{apk,aab}"
cat dist/SHA256SUMS
