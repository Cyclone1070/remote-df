#!/bin/bash
pkill -9 -f Xvfb 2>/dev/null || true
pkill -9 -f dwarfort 2>/dev/null || true
pkill -9 -f remote-df 2>/dev/null || true
rm -rf /tmp/df_frames
mkdir -p /tmp/df_frames
sleep 1

nohup Xvfb :99 -screen 0 2560x1440x24 </dev/null >/tmp/xvfb.log 2>&1 &
sleep 1

cd /tmp/df_install
nohup env DISPLAY=:99 PORT=48600 WEB_ROOT=/tmp/remote-df/client LD_PRELOAD=/tmp/df_install/libdf_streamer.so LD_LIBRARY_PATH=. ./dwarfort </dev/null >/tmp/df_game.log 2>&1 &
sleep 3
