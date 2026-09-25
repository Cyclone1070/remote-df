#!/bin/sh
set -e

. "$(dirname "$0")/lib/common.sh"

TARGET="${TEST_SUITE:-all}"
echo "============================================="
echo "  Remote-DF E2E Suite — Running: $TARGET"
echo "============================================="

run_suite() {
  SUITE_FILE="$1"
  if [ -f "$SUITE_FILE" ]; then
    /bin/sh "$SUITE_FILE"
  else
    fail "Suite file $SUITE_FILE not found"
  fi
}

case "$TARGET" in
  01|health|healthcheck)
    run_suite "$(dirname "$0")/suites/01-healthcheck.sh"
    ;;
  02|game|games)
    run_suite "$(dirname "$0")/suites/01-healthcheck.sh"
    run_suite "$(dirname "$0")/suites/02-games.sh"
    ;;
  03|session)
    run_suite "$(dirname "$0")/suites/01-healthcheck.sh"
    run_suite "$(dirname "$0")/suites/02-games.sh"
    run_suite "$(dirname "$0")/suites/03-session.sh"
    ;;
  all|"")
    run_suite "$(dirname "$0")/suites/01-healthcheck.sh"
    run_suite "$(dirname "$0")/suites/02-games.sh"
    run_suite "$(dirname "$0")/suites/03-session.sh"
    ;;
  *)
    fail "Unknown test suite: $TARGET (Valid options: 01, 02, 03, all)"
    ;;
esac

echo ""
echo "============================================="
echo "  OK - All requested E2E checks passed"
echo "============================================="
