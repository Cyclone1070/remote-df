#!/bin/bash
set -e

HOST="${STREAM_HOST:-user@localhost}"
RECORD="${1:-0}"

echo "=== Restarting single-process C++ stream on ${HOST} (RECORD_FRAMES=${RECORD}) ==="
ssh "${HOST}" "/tmp/start_df.sh"
echo "=== Single-Process C++ Stack Ready ==="
