#!/bin/sh
# Tier 1: unit tests. No game, no browser, no network, no deployment.
#
# Everything here runs in seconds and answers a question about a rule, not about
# a running system. If a claim can be checked here, it must be checked here -
# this is the tier that a code change is developed against, and the higher tiers
# are confirmation rather than the primary loop.
#
#   sh tests/tier1-unit/run.sh
#
# Exit code is 0 only if every test in every group passed.
set -e

cd "$(dirname "$0")/../.."
ROOT=$(pwd)

DF_HOST="${DF_HOST:-cyc@192.168.1.111}"
BUILD_IMAGE="${DF_BUILD_IMAGE:-localhost/df-interposer-zlib:latest}"
REMOTE_DIR="${DF_TIER1_DIR:-/tmp/df_tier1}"

PASS=0
FAIL=0
FAILED=""

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED\n  - $1"; printf '  FAIL  %s\n' "$1"; }

echo ""
echo "=== Tier 1: unit ==="
echo ""

# ── Interposer (C++) ─────────────────────────────────────────────────────────
#
# Compiled on the build host because the tests include the real headers and one
# of them needs zstd, which is not installed on a developer's machine. The point
# of these is that they include the shipping headers rather than a copy: a test
# against a reimplementation proves only that the copy works.
echo "interposer (C++)"

ssh -o ConnectTimeout=8 "$DF_HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR/inc $REMOTE_DIR/bin" >/dev/null

# Headers the tests include.
for h in stamp_slot.hpp wire_log.hpp texture_queue.hpp raw_jpeg.hpp raw_png.hpp; do
    cat "interposer/$h" | ssh "$DF_HOST" "cat > $REMOTE_DIR/inc/$h"
done

for t in tests/tier1-unit/interposer/*.cpp; do
    name=$(basename "$t" .cpp)
    cat "$t" | ssh "$DF_HOST" "cat > $REMOTE_DIR/$name.cpp"
    if ssh "$DF_HOST" "podman run --rm -v $REMOTE_DIR:/t:Z -w /t \
        $BUILD_IMAGE sh -c 'g++ -std=c++17 -O1 -Wall -I/t/inc -I/t \
            $name.cpp -o bin/$name -lzstd -lz -ljpeg 2>&1'" >/tmp/tier1_$name.log 2>&1 \
        && ssh "$DF_HOST" "podman run --rm -v $REMOTE_DIR:/t:Z -w /t $BUILD_IMAGE ./bin/$name" >/tmp/tier1_$name.run 2>&1; then
        ok "$name"
    else
        bad "$name (see /tmp/tier1_$name.log and /tmp/tier1_$name.run)"
    fi
done

# ── Client (JS) ──────────────────────────────────────────────────────────────
#
# Colocated with the source it tests, which is also where a developer expects to
# find them. Run from client/ so their relative imports resolve.
echo "client (JS)"
if ( cd client && npm test --silent >/tmp/tier1_client.log 2>&1 ); then
    n=$(grep -E '^# pass|^ℹ pass' /tmp/tier1_client.log | head -1 | awk '{print $3}')
    ok "client suite (${n:-?} tests)"
else
    bad "client suite (see /tmp/tier1_client.log)"
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
    printf '%b\n' "$FAILED"
    exit 1
fi
