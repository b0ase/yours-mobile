#!/usr/bin/env bash
# Build bWallet and install + launch it on every connected target: Android phones and emulators,
# booted iPhone simulators and USB iPhones. Private channels by default (src/mobile/channel.ts):
#   bash scripts/run-all.sh
#   CHANNELS="android-play ios-store" bash scripts/run-all.sh
#   SKIP_ANDROID=1 bash scripts/run-all.sh
set -uo pipefail
cd "$(dirname "$0")/.."
for CH in ${CHANNELS:-android-direct ios-private}; do
  [[ $CH == android-* && -n ${SKIP_ANDROID:-} ]] && continue
  [[ $CH == ios-* && -n ${SKIP_IOS:-} ]] && continue
  LOG=/tmp/run-all-$CH.log
  INSTALL=1 bash scripts/channel-build.sh "$CH" 2>&1 | tee "$LOG"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || { echo "✗ $CH failed (full log: $LOG):"; grep -iE "error|✗|fail" "$LOG" | tail -8; }
done
echo "✓ done"
