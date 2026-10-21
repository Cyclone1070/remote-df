#!/bin/bash
# Runs the whole comparison at one pinned window size.
#
# Every earlier comparison was taken across a window that changed whenever a
# client connected, so the raw baseline's cost moved without the code changing.
# The pin in the interposer fixes the number of pixels; this script fixes
# everything else by running all three configurations back to back in one
# session.
set -u
H=192.168.1.111
CD=/Users/mac/repos/remote-df
cd "$CD"

say() { printf '\n########## %s ##########\n' "$1"; }
toggle() { ssh -o BatchMode=yes cyc@$H "podman exec remote-df $1" >/dev/null 2>&1; }

# The pin exists so two bench runs measure the same pixels. It is a property of
# the RUN, not of the machine: left behind, it silently overrides every client's
# window size, so the game renders at 1280x720 inside whatever window the page
# actually has and the picture covers only part of it. That failure looks like a
# rendering bug, is nowhere near the code that caused it, and outlives the bench
# by days - so removing it is part of the run, not an afterthought.
cleanup() {
    toggle "rm -f /tmp/df_window_size"
    toggle "rm -f /tmp/df_raw_on /tmp/df_raw_lossless /tmp/df_pic_lossless"
}
trap cleanup EXIT

say "pin window to 1280x720, enable lossless pictures"
toggle "sh -c 'echo 1280x720 > /tmp/df_window_size'"
toggle "touch /tmp/df_raw_on /tmp/df_pic_lossless"

say "restart DF session"
curl -s -X POST --max-time 30 -H 'Content-Type: application/json' \
  -d '{"gameId":"dwarf-fortress"}' http://$H:8484/api/session/start >/dev/null 2>&1
sleep 40
ssh -o BatchMode=yes cyc@$H "podman logs remote-df 2>&1 | grep -a 'WINDOW\] pinned\|New window size' | tail -3"

# ---------------------------------------------------------------- smart
say "SMART + zstd pictures : wire bytes"
node scripts/df_wire_compare.mjs http://$H:8484/df http://$H:8000/ 2>&1 | tail -20

say "SMART + zstd pictures : m2p latency"
for A in zoom pan elevation; do
  N=25 node scripts/df_m2p.mjs http://$H:8484/df smart "$A" 2>&1 | grep -E "===|latency|surface"
done

# ---------------------------------------------------------------- raw JPEG
say "RAW JPEG q80 : m2p latency + bytes/frame"
toggle "rm -f /tmp/df_raw_lossless"
sleep 4
for A in zoom pan elevation; do
  N=25 node scripts/df_raw_codec_ab.mjs http://$H:8000/ "JPEG q80 $A" 2>&1 | tail -3
done

# ---------------------------------------------------------------- raw PNG
say "RAW lossless PNG : m2p latency + bytes/frame"
toggle "touch /tmp/df_raw_lossless"
sleep 4
for A in zoom pan elevation; do
  N=25 node scripts/df_raw_codec_ab.mjs http://$H:8000/ "lossless PNG $A" 2>&1 | tail -3
done

# ---------------------------------------------------------------- summary line
say "done"
cleanup
ssh -o BatchMode=yes cyc@$H "podman logs remote-df 2>&1 | grep -a 'FRAME_STATS' | tail -1" | \
  grep -o 'RAW_sent=[0-9]* RAW_drop=[0-9]* RAW_kb=[0-9]* RAW_enc_us=[0-9]*'
