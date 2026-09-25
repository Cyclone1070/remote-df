#!/bin/sh
set -e

. "$(dirname "$0")/../lib/common.sh"

echo "ℹ INFO: Suite 01: Healthcheck & SPA Routing ($BASE_URL)"

# 1. /api/config
assert_status GET "$BASE_URL/api/config" 200
assert_jq '.mode == "self-hosted"' "JSON field 'mode' == 'self-hosted'"

# 2. Web root
assert_status GET "$BASE_URL/" 200
if ! echo "$BODY" | grep -q "<html"; then
  fail "expected <html in root index"
fi
echo "  ✓ Web root serves valid index.html"

# 3. SPA fallback
assert_status GET "$BASE_URL/df" 200
if ! echo "$BODY" | grep -q "<html"; then
  fail "expected <html for SPA fallback"
fi
echo "  ✓ SPA fallback for /df serves index.html"
