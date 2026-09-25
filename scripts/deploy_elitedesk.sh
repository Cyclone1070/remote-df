#!/bin/bash
set -e

HOST="${DEPLOY_HOST:-user@localhost}"
REMOTE_DIR="/tmp/remote-df"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Deploying remote-df to ${HOST} ==="

ssh "${HOST}" "mkdir -p ${REMOTE_DIR}"

rsync -avz --exclude 'target' --exclude '.git' \
    "${SCRIPT_DIR}/" \
    "${HOST}:${REMOTE_DIR}/"

echo "=== Building single-process C++ streamer on elitedesk ==="
ssh "${HOST}" "
    set -e
    cd ${REMOTE_DIR}/interposer
    make clean
    make
    cp libdf_streamer.so /tmp/df_install/
    cp ${REMOTE_DIR}/scripts/run_streamer.sh /tmp/df_install/run_streamer.sh
    chmod +x /tmp/df_install/run_streamer.sh
    /tmp/df_install/run_streamer.sh
"

echo "=== Deployment Succeeded ==="
