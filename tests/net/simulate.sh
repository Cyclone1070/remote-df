#!/usr/bin/env bash
# Shapes the network the browser sees, deterministically.
#
# Why this exists: every measurement so far was taken over a bare LAN, where the
# link is effectively free. That cannot tell us what a user on a real connection
# experiences, and it cannot distinguish "the code is slow" from "the code is only
# fast because the network hides the cost".
#
# Design notes, all deliberate:
#
#  * Only the game's ports are shaped. SSH stays on the untouched band, so a
#    mistake here cannot cost access to the machine.
#  * There is always a self-destruct timer. Whatever happens, the shaping is
#    removed after the window, without needing a working session.
#  * The delay follows a fixed repeating pattern rather than netem's random
#    jitter, so two runs are comparable. Reproducibility is worth more than
#    physical realism here: random jitter would mean two runs could not be
#    compared at all.
#
# Usage:  simulate.sh apply [seconds] | clear | status
set -u

DEV="${DEV:-wlp0s20f3}"
IFB="${IFB:-ifb0}"
PORTS_TCP="8484 8000"
PORTS_UDP="8485 8486"

# Deterministic delay pattern in milliseconds, cycled. Mean 45ms, spread 25-70ms,
# which is a plausible consumer-internet round trip without being pathological.
PATTERN=(30 55 38 62 41 48 29 70 44 35 58 33)
TICK_MS="${TICK_MS:-250}"

# Bandwidth ceiling on the shaped band. A LAN is not infinite and a real uplink is
# nothing like one; 25 mbit is a normal domestic download for a single stream.
RATE="${RATE:-25mbit}"

qdisc_clear() {
  tc qdisc del dev "$DEV" root 2>/dev/null
  tc qdisc del dev "$DEV" ingress 2>/dev/null
  tc qdisc del dev "$IFB" root 2>/dev/null
  ip link set "$IFB" down 2>/dev/null
  ip link del "$IFB" 2>/dev/null
  pkill -f "simulate.sh pattern" 2>/dev/null
}

apply() {
  local seconds="${1:-300}"
  qdisc_clear

  # unshaped band for everything else (ssh), shaped band only for game traffic
  tc qdisc add dev "$DEV" root handle 1: prio bands 3 || return 1
  tc qdisc add dev "$DEV" parent 1:3 handle 30: netem delay "${PATTERN[0]}ms" rate "$RATE" || return 1

  # Downstream: a reply leaving the host carries the game port as its SOURCE, so
  # matching dport here silently shapes nothing - which is exactly what happened.
  for p in $PORTS_TCP; do
    tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
      match ip protocol 6 0xff match ip sport "$p" 0xffff flowid 1:3 2>/dev/null
  done
  for p in $PORTS_UDP; do
    tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
      match ip protocol 17 0xff match ip sport "$p" 0xffff flowid 1:3 2>/dev/null
  done

  # upstream (browser -> host) for the same ports, via a redirect to an ifb device
  modprobe ifb 2>/dev/null
  ip link add "$IFB" type ifb 2>/dev/null
  ip link set "$IFB" up 2>/dev/null
  tc qdisc add dev "$DEV" handle ffff: ingress 2>/dev/null
  # Upstream: a request arriving from the browser carries the game port as its
  # destination, so this direction matches dport.
  for p in $PORTS_TCP $PORTS_UDP; do
    tc filter add dev "$DEV" parent ffff: protocol ip u32 \
      match ip dport "$p" 0xffff action mirred egress redirect dev "$IFB" 2>/dev/null
  done
  tc qdisc add dev "$IFB" root netem delay "${PATTERN[0]}ms" rate "$RATE" 2>/dev/null

  # Self-destruct: shaping always comes off at the end of the window, whether or
  # not anyone is still able to run the clean-up.
  setsid bash -c "sleep $((seconds + 30)); $(declare -f qdisc_clear); DEV=$DEV IFB=$IFB qdisc_clear" \
    </dev/null >/dev/null 2>&1 &

  # Walk the fixed pattern so jitter is repeatable.
  (
    i=0
    while :; do
      d="${PATTERN[$((i % ${#PATTERN[@]}))]}"
      tc qdisc change dev "$DEV" parent 1:3 handle 30: netem delay "${d}ms" rate "$RATE" 2>/dev/null
      tc qdisc change dev "$IFB" root netem delay "${d}ms" rate "$RATE" 2>/dev/null
      i=$((i + 1))
      sleep "$(awk "BEGIN{print $TICK_MS/1000}")"
    done
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null
  echo $! > /tmp/df-sim-pattern.pid
  echo "shaping on $DEV: ports tcp($PORTS_TCP) udp($PORTS_UDP), pattern ${PATTERN[*]} ms every ${TICK_MS}ms, rate $RATE, auto-clear in $((seconds + 30))s"
}

case "${1:-status}" in
  apply) apply "${2:-300}" ;;
  clear) qdisc_clear; echo "shaping cleared" ;;
  status)
    tc qdisc show dev "$DEV" | head -4
    tc class show dev "$DEV" 2>/dev/null | head -4
    ;;
  *) echo "usage: $0 apply [seconds] | clear | status"; exit 2 ;;
esac
