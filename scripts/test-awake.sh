#!/usr/bin/env bash
# Run `bun test` with the Mac kept awake, and say so when it slept anyway:
#   bash scripts/test-awake.sh src
#   bash scripts/test-awake.sh src site/test relay/e2e
#
# Why (5 Nov 2026): three full-suite runs each had one test "time out" after ~903 s (seedChange liveness, indexFund
# overlayStatus, kdfUpgrade), and passed alone. `pmset -g log` shows the Mac in Maintenance Sleep for 903 s over each
# of those runs: the bun process was suspended, its timers fired late on wake, and whichever test was running failed.
# Not the code. caffeinate holds idle sleep (-i) and system sleep on AC power (-s) off while the tests run. A thermal
# emergency or a closed lid can still sleep the machine, so after a failed run this prints any sleep in the run's
# window (pmset logs local time).
set -uo pipefail
cd "$(dirname "$0")/.."
start=$(date '+%Y-%m-%d %H:%M:%S')
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -s bun test "$@"
else
  bun test "$@"
fi
rc=$?
if [[ $rc -ne 0 ]] && command -v pmset >/dev/null 2>&1; then
  end=$(date '+%Y-%m-%d %H:%M:%S')
  slept=$(pmset -g log | awk -v s="$start" -v e="$end" '{ t = $1 " " $2 } t >= s && t <= e' |
    grep -E 'Entering Sleep|DarkWake from|Wake from' || true)
  if [[ -n $slept ]]; then
    echo "test-awake: the machine slept during this run. A test that timed out across a sleep is not a code failure:" >&2
    echo "$slept" >&2
  fi
fi
exit $rc
