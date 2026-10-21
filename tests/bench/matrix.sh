#!/usr/bin/env bash
# The mainstream bench: both transports, two networks, one command.
#
# This is the bench that answers "is it fast enough, and for whom". It exists
# because every earlier smoothness number was taken while panning a still title
# screen: the matching input did nothing, so the bench passed on an image that was
# not moving. Anything in here has first been shown to move the picture.
#
# Four runs, as asked for:
#   1. instruction transport, real network
#   2. pixel transport,     real network
#   3. instruction transport, shaped network
#   4. pixel transport,     shaped network
#
# Runs 1 and 2 happen in one pass of the matrix (it drives both pages), and runs
# 3 and 4 in a second pass while the network is shaped. Each pass writes
# results.json plus a timestamped per-step log under
# evidence/bench/interaction-matrix/<network>-<time>/.
#
# The shaped network is not a bare link with a delay bolted on: it has a real
# bandwidth ceiling and a fixed, repeating delay pattern, so two runs can be
# compared. tests/net/simulate.sh owns that and always removes itself.
set -euo pipefail

cd "$(dirname "$0")/../.."

SECONDS_PER_INTERACTION="${DF_MATRIX_SECONDS:-10}"
SHAPE_HOST="${DF_SHAPE_HOST:-}"
SHAPE_SECONDS="${DF_SHAPE_SECONDS:-1500}"

run_pass() {
  local label="$1"
  echo "== $label"
  DF_NET_LABEL="$label" DF_MATRIX_SECONDS="$SECONDS_PER_INTERACTION" \
    node tests/diagnostics/interaction-matrix.mjs
}

run_pass "lan"

if [ -n "$SHAPE_HOST" ]; then
  echo "== shaping the network through $SHAPE_HOST"
  ssh "$SHAPE_HOST" "cat > /tmp/df-simulate.sh && chmod +x /tmp/df-simulate.sh" < tests/net/simulate.sh
  ssh "$SHAPE_HOST" "sudo -n /tmp/df-simulate.sh apply $SHAPE_SECONDS" </dev/null
  trap 'ssh "$SHAPE_HOST" "sudo -n /tmp/df-simulate.sh clear" </dev/null >/dev/null 2>&1 || true' EXIT
  run_pass "simulated"
  ssh "$SHAPE_HOST" "sudo -n /tmp/df-simulate.sh clear" </dev/null
  trap - EXIT
else
  echo "== skipped the shaped network: set DF_SHAPE_HOST=user@host to include it"
fi

echo
echo "== summary"
node tests/bench/summarise.mjs
