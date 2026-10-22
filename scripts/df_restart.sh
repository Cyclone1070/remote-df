#!/usr/bin/env bash
# Restart the game session so every bench run starts cold.
#
# Both sides cache: the host remembers every picture it has sent, and the client
# holds the artwork it has received. A second run against a live session is
# therefore not measuring the same thing as the first - it skips the connect
# handover and the artwork fetches that dominate the cold path.
set -euo pipefail
HOST="${1:?usage: df_restart.sh <host:port>}"
curl -s -X POST --max-time 30 "http://$HOST/api/session/stop" >/dev/null 2>&1 || true
sleep 3
curl -s -X POST --max-time 30 -H 'Content-Type: application/json' \
  -d '{"gameId":"dwarf-fortress"}' "http://$HOST/api/session/start" >/dev/null 2>&1
for _ in $(seq 1 40); do
  sleep 2
  if curl -s --max-time 5 "http://$HOST/api/session" | grep -q '"state":"running"'; then
    sleep 8   # let the game reach its first screen before anyone connects
    exit 0
  fi
done
echo "session did not come up" >&2
exit 1
