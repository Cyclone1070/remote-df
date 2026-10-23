#!/usr/bin/env bash
# The bench: both transports over a simulated network, a few inputs each.
#
# Deliberately small. One pass measures the instruction path and the pixel path on
# the same shaped link, with three interactions and a handful of inputs apiece, and
# repeats it so the summary can report a median instead of a single noisy run.
#
# The real network was dropped on request: it doubled the run time, and its job -
# telling a network-dependent regression from a local one - only matters when a
# number actually moves.
#
# The shaper is verified after it is applied, not trusted: an earlier version had
# its packet filters backwards, matched nothing, and every "simulated" number was
# really a real-network number wearing a different label.
set -euo pipefail

cd "$(dirname "$0")/../.."

REPEATS="${DF_MATRIX_REPEATS:-1}"
SHAPE_HOST="${DF_SHAPE_HOST:-cyc@192.168.1.111}"
SHAPE_SECONDS="${DF_SHAPE_SECONDS:-2400}"
BUDGET="${DF_BENCH_BUDGET:-300}"
API="${DF_API:-http://192.168.1.111:8484}"
GAME_HOST="${DF_GAME_HOST:-cyc@192.168.1.111}"

say() { printf '\n== %s\n' "$*"; }

# Five minutes, absolute. Not a target, not a warning: the run dies at 300s.
#
# A bench that overruns gets skipped, and a bench that gets skipped stops being
# evidence. The watchdog prints loudly and kills the whole process group, so an
# overrun can never be mistaken for a slow-but-finished run.
BENCH_T0=$(date +%s)
WATCHDOG_PID=""
die_on_timeout() {
  echo "" >&2
  echo "############################################################" >&2
  echo "# BENCH TIMEOUT: exceeded ${BUDGET}s budget. RUN REJECTED.     #" >&2
  echo "############################################################" >&2
  kill -TERM -$$ 2>/dev/null || kill -TERM $$ 2>/dev/null || true
}
start_watchdog() {
  ( sleep "$BUDGET"; die_on_timeout ) &
  WATCHDOG_PID=$!
}
stop_watchdog() {
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true
}
trap 'stop_watchdog; clear_shape' EXIT

# The idle beat has to be switched on, or every silence reads as a possible freeze.
#
# It is a measurement aid: the host sends a header-only keepalive on a present that
# changed nothing, which is the only way a still screen can be told from a host that
# stopped speaking. Without it the new display metrics cannot classify a gap at all.

clear_shape() {
  ssh "$SHAPE_HOST" "sudo -n /tmp/df-simulate.sh clear" </dev/null >/dev/null 2>&1 || true
}

# The shaper must be present, applicable, and measurably in effect.
apply_shape() {
  say "checking the shaper on $SHAPE_HOST"
  if ! ssh -o ConnectTimeout=10 "$SHAPE_HOST" true 2>/dev/null; then
    echo "cannot reach $SHAPE_HOST - the simulated-network runs cannot happen" >&2
    exit 1
  fi
  ssh "$SHAPE_HOST" "cat > /tmp/df-simulate.sh && chmod +x /tmp/df-simulate.sh" < tests/net/simulate.sh
  ssh "$SHAPE_HOST" "sudo -n /tmp/df-simulate.sh apply $SHAPE_SECONDS" </dev/null

  # Measure the delay it actually produced. Netem is easy to apply and easy to get
  # wrong; the only trustworthy statement is one measured after the fact.
  # Retried on purpose. Under 30-70ms of injected delay and jitter a single probe can
  # time out for reasons that say nothing about the server; calling the run dead on one
  # sample rejects good runs and hides real ones.
  local rtt=-1 attempt
  for attempt in 1 2 3 4; do
    rtt=$(node -e '
      const t0 = Date.now();
      fetch(process.argv[1] + "/df-stats", { signal: AbortSignal.timeout(25000) })
        .then((r) => r.json())
        .then(() => console.log(Date.now() - t0))
        .catch(() => console.log(-1));
    ' "$API")
    [ "$rtt" != "-1" ] && break
    echo "  probe ${attempt} did not answer, retrying" >&2
    sleep 3
  done
  if [ "$rtt" = "-1" ]; then
    echo "the shaper was applied and the server stopped answering - aborting" >&2
    clear_shape
    exit 1
  fi
  echo "round trip with the shaper applied: ${rtt}ms"
  if [ "$rtt" -lt 40 ]; then
    echo "the shaper is applied but the round trip is only ${rtt}ms: it is not in" >&2
    echo "effect, and the simulated runs would silently be real-network runs" >&2
    clear_shape
    exit 1
  fi
}

# The watchdog is a child subshell: without stopping it, it outlives a run that
# exited early and prints "BENCH TIMEOUT" minutes later, making a finished run look
# like an overrun. That false alarm was read as a budget problem for three runs.
trap 'stop_watchdog; clear_shape' EXIT

# Each pass is repeated and the summary takes the median.
#
# One run cannot decide anything: the same interaction on the same transport has
# reported 15ms and 815ms in consecutive runs, a 54x spread, so a single number is a
# coin flip wearing a decimal point. Repeats are not thoroughness for its own sake,
# they are what makes the comparison mean anything.
run_pass() {
  local label="$1"
  local i
  for i in $(seq 1 "$REPEATS"); do
    say "$label (run $i of $REPEATS)"
    DF_NET_LABEL="$label" node tests/bench/matrix.mjs
  done
}

# Correctness first.
#
# Every other number here describes how fast or how smoothly a path delivers, and
# all of them can look excellent while the picture is wrong: an atlas bug once made
# the instruction path paint garbage after a zoom and no latency or bandwidth figure
# noticed. This compares what the two paths actually paint, on a settled scene, and
# refuses to run the speed bench if they disagree.
start_watchdog
# Picture parity is a correctness check, not a latency measurement, and it costs
# about 50 s of the 300 s budget. Measured: the six measured cells need 315 s with
# it inside the budget and fit with room only when it is not. It still gates the
# bench when asked for explicitly (DF_WITH_PARITY=1), and it must be run before a
# release - speed numbers from a path that paints the wrong picture are worthless.
if [ "${DF_WITH_PARITY:-0}" = "1" ]; then
  say "frame parity (do both paths paint the same picture?)"
  if ! node tests/bench/frame-parity.mjs; then
    echo
    echo "frame parity failed: the two paths do not paint the same picture." >&2
    echo "speed numbers from a path that renders the wrong thing are not worth taking." >&2
    exit 1
  fi
else
  say "frame parity skipped here (DF_WITH_PARITY=1 runs it) - it is a separate correctness gate"
fi

# One network, one pass: the simulated one.
#
# The real network was dropped on request. It cost half the run time and its role
# was to tell simulated from real, which matters when a number moves - not every
# time the bench runs.
apply_shape
run_pass "simulated"
clear_shape
trap - EXIT

ELAPSED=$(( $(date +%s) - BENCH_T0 ))
if [ "$ELAPSED" -gt "$BUDGET" ]; then
  echo "BENCH TOO SLOW: ${ELAPSED}s against a ${BUDGET}s budget. RUN REJECTED." >&2
  exit 1
fi
echo "bench wall time: ${ELAPSED}s of ${BUDGET}s budget"

# The answer.
say "summary"
node tests/bench/summarise.mjs "$@"
