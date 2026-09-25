#!/bin/sh
set -e

# Usage:
#   ./run-docker-test.sh [all|01|02|03]
#   01: Healthcheck & SPA Routing
#   02: Games Discovery & Dynamic Tags
#   03: Session Lifecycle & Zombie Process Verification

cd "$(dirname "$0")"

TARGET="${1:-all}"

# If running directly on host, invoke docker-test.sh directly
TEST_SUITE="$TARGET" /bin/sh ./docker-test.sh
