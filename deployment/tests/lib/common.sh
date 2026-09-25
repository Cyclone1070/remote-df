#!/bin/sh
set -e

# Core Assertion Helpers modeled after socialradio/deployment/tests/lib/common.sh

fail() {
  echo "  FAIL: $*" >&2
  exit 1
}

req() {
  METHOD="$1"
  URL="$2"
  shift 2

  HEADER_FILE=$(mktemp)
  BODY_FILE=$(mktemp)

  REQ_TIME=$(curl -s --max-time 15 -w "%{time_total}" -X "$METHOD" "$URL" "$@" \
    -D "$HEADER_FILE" \
    -o "$BODY_FILE")

  STATUS=$(grep -i '^HTTP/' "$HEADER_FILE" | tail -1 | awk '{print $2}')
  HEADERS=$(cat "$HEADER_FILE")
  BODY=$(cat "$BODY_FILE")

  rm -f "$HEADER_FILE" "$BODY_FILE"
}

assert_status() {
  METHOD="$1"
  URL="$2"
  EXPECTED="$3"
  shift 3

  req "$METHOD" "$URL" "$@"
  if [ "$EXPECTED" = "2xx" ]; then
    case "$STATUS" in
      2*) ;;
      *)
        echo "  Body: $BODY"
        fail "expected 2xx status, got $STATUS"
        ;;
    esac
    echo "  Status: $STATUS (expected 2xx) [${REQ_TIME}s]"
  else
    if [ "$STATUS" != "$EXPECTED" ]; then
      echo "  Body: $BODY"
      fail "expected $EXPECTED, got $STATUS"
    fi
    echo "  Status: $STATUS (expected $EXPECTED) [${REQ_TIME}s]"
  fi
}

assert_jq() {
  expr="$1"
  desc="$2"
  if ! echo "$BODY" | jq -e "$expr" >/dev/null 2>&1; then
    echo "  Body: $BODY"
    fail "jq assertion failed: $expr ($desc)"
  fi
  echo "  ✓ $desc"
}

assert_empty_body() {
  if [ -n "$BODY" ]; then
    fail "expected empty body, got: $BODY"
  fi
  echo "  ✓ empty body"
}

BASE_URL="${TARGET_URL:-http://localhost:8484}"
