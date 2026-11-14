#!/usr/bin/env bash
# Run the two-device simulation (src/incident/twoDeviceSim.test.ts + src/testing/twoDeviceSim/) against any git ref,
# without touching that ref's own checkout:
#   scripts/two-device-sim.sh origin/bwallet
#   SIM_FIXED=fix/unsent-auto-release scripts/two-device-sim.sh fix/unsent-auto-release
#   SIM_FIXED=all scripts/two-device-sim.sh <ref>      (every known-bug case run as a plain test: all must pass)
# A temporary detached worktree of <ref> gets this checkout's harness files and a symlink to this checkout's
# node_modules (nothing is installed), runs bun test, and is removed. Extra arguments go to bun test (e.g. -t seed).
set -euo pipefail
ref="${1:?usage: scripts/two-device-sim.sh <git ref> [bun test args]}"
shift
here="$(cd "$(dirname "$0")/.." && pwd)"
modules="$(cd "$here/node_modules" && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/two-device-sim.XXXXXX")"
cleanup() { git -C "$here" worktree remove --force "$tmp/wt" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
git -C "$here" worktree add --detach "$tmp/wt" "$ref" >/dev/null
ln -s "$modules" "$tmp/wt/node_modules"
mkdir -p "$tmp/wt/src/testing/twoDeviceSim" "$tmp/wt/src/incident"
cp "$here"/src/testing/twoDeviceSim/*.ts "$tmp/wt/src/testing/twoDeviceSim/"
cp "$here/src/incident/twoDeviceSim.test.ts" "$tmp/wt/src/incident/"
echo "two-device sim on $ref ($(git -C "$tmp/wt" rev-parse --short HEAD)), SIM_FIXED=${SIM_FIXED:-}" >&2
cd "$tmp/wt"
bun test src/incident/twoDeviceSim.test.ts "$@"
