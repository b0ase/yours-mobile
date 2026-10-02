#!/usr/bin/env bash
# Both Android release channels: the APK for direct download and the AAB for Google Play.
#   bash scripts/android-release.sh   → dist/bwallet-<ver>-direct.apk, dist/bwallet-<ver>-play.{aab,apk}
# See scripts/channel-build.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/channel-build.sh android-direct
bash scripts/channel-build.sh android-play
