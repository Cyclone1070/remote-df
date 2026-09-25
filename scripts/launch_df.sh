#!/bin/bash
set -e

DF_DIR="/tmp/df_install"
INTERPOSER_SO="${DF_DIR}/libdf_streamer.so"

echo "=== Starting Dwarf Fortress in Headless Stream Mode ==="
pkill -9 -f Xvfb 2>/dev/null || true
pkill -9 -f dwarfort 2>/dev/null || true

# 1. Start Xvfb virtual framebuffer
echo "[1/3] Starting Xvfb :99 (2560x1440x24)..."
Xvfb :99 -screen 0 2560x1440x24 &
XVFB_PID=$!
sleep 1

# 2. Start Dwarf Fortress with interposer
echo "[2/3] Launching Dwarf Fortress with libdf_streamer.so..."
cd "${DF_DIR}"
DISPLAY=:99 LD_PRELOAD="${INTERPOSER_SO}" LD_LIBRARY_PATH=. ./dwarfort &
DF_PID=$!

echo "[3/3] Dwarf Fortress running (PID: ${DF_PID})."
echo "Press Ctrl+C to terminate."

trap "echo 'Stopping...'; kill -9 ${DF_PID} 2>/dev/null; kill -9 ${XVFB_PID} 2>/dev/null; exit 0" INT TERM
wait ${DF_PID}
