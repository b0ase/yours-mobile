#!/usr/bin/env bash
# Build release-signed Android artifacts: an APK for direct download and an
# AAB for Google Play. The upload key lives outside the repo
# (~/.yours-mobile/upload-keystore.jks); its password is read from the macOS
# Keychain entry "yours-mobile-android-upload" and never written to disk.
#
#   bash scripts/android-release.sh      → dist/bcorp-wallet-<version>.apk/.aab + SHA256SUMS
#
# The APK (direct download) uses the default build; the AAB (Google Play) uses the store build
# (VITE_STORE_BUILD=1, src/mobile/storeBuild.ts, docs/STORE-AUDIT.md).
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
export YOURS_UPLOAD_KEYSTORE=${YOURS_UPLOAD_KEYSTORE:-$HOME/.yours-mobile/upload-keystore.jks}
YOURS_UPLOAD_PASSWORD=$(security find-generic-password -s yours-mobile-android-upload -a upload -w)
export YOURS_UPLOAD_PASSWORD

pnpm cap:sync >/dev/null
(cd android && ./gradlew --quiet clean assembleRelease)
pnpm cap:sync:store >/dev/null
(cd android && ./gradlew --quiet bundleRelease)
# Restore the default build in android/ and ios/ so later iOS/dev builds aren't the store variant.
pnpm cap:sync >/dev/null

VERSION=$(sed -nE 's/.*versionName "([^"]+)".*/\1/p' android/app/build.gradle)
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk "dist/bcorp-wallet-$VERSION.apk"
cp android/app/build/outputs/bundle/release/app-release.aab "dist/bcorp-wallet-$VERSION.aab"
(cd dist && shasum -a 256 "bcorp-wallet-$VERSION.apk" "bcorp-wallet-$VERSION.aab" > SHA256SUMS)

# Refuse to ship anything not signed with the upload key.
APKSIGNER=$(ls -d "$HOME"/Library/Android/sdk/build-tools/*/apksigner | tail -1)
"$APKSIGNER" verify --print-certs "dist/bcorp-wallet-$VERSION.apk" | grep -q "Yours Wallet Mobile (unofficial)"
echo "built dist/bcorp-wallet-$VERSION.{apk,aab}"
cat dist/SHA256SUMS
