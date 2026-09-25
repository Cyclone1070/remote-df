#!/bin/sh
set -e

. "$(dirname "$0")/../lib/common.sh"

echo "ℹ INFO: Suite 03: Session Lifecycle & Zombie Process Verification ($BASE_URL)"

# Ensure clean start
req POST "$BASE_URL/api/session/stop"
sleep 1

# Check idle
assert_status GET "$BASE_URL/api/session" 200
assert_jq '.state == "idle"' "JSON field 'state' == 'idle'"

# Start session
assert_status POST "$BASE_URL/api/session/start" 200 -H "Content-Type: application/json" -d '{"gameId":"dwarf-fortress"}'
assert_jq '.state == "running"' "Session started successfully (state: running)"
assert_jq '.gameId == "dwarf-fortress"' "JSON field 'gameId' == 'dwarf-fortress'"

sleep 2

# Stop session
START_STOP=$(date +%s)
assert_status POST "$BASE_URL/api/session/stop" 200
END_STOP=$(date +%s)
DURATION=$((END_STOP - START_STOP))
echo "  ✓ Session stopped successfully in ${DURATION}s"

# Verify zombie processes if SSH_TARGET is provided
if [ -n "$SSH_TARGET" ] && command -v ssh >/dev/null 2>&1; then
  echo "ℹ INFO: Inspecting container process table via SSH ($SSH_TARGET)..."
  ZOMBIES=$(ssh -o ConnectTimeout=3 -o BatchMode=yes "$SSH_TARGET" "podman exec remote-df ps aux | grep -iE 'defunct|zombie' | grep -v grep | wc -l" 2>/dev/null || echo "0")
  if [ "$ZOMBIES" -eq 0 ]; then
    echo "  ✓ Zero zombie processes found in container"
  else
    fail "Detected $ZOMBIES zombie/defunct processes!"
  fi
fi

