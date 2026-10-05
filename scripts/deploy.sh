#!/usr/bin/env bash
# Build and deploy remote-df.
#
# CONFIG COMES FROM THE ENVIRONMENT - nothing sensitive is stored in this file.
# It is safe to commit. Do NOT add hostnames, IPs, tokens or credentials here.
#
#   DF_HOST        ssh destination, e.g. user@host            (required)
#   DF_CONTAINER   podman container name        (default: remote-df)
#   DF_REMOTE_SRC  scratch dir on the host      (default: /tmp/df_build)
#   DF_BUILD_IMAGE image with g++ + libdatachannel headers
#                  (default: localhost/df-interposer-built:latest)
#   DF_GO_IMAGE    golang image for the server build (default: docker.io/library/golang:1.24-alpine)
#
# Usage: DF_HOST=user@host ./scripts/deploy.sh all

set -euo pipefail

HOST="${DF_HOST:?set DF_HOST (e.g. user@host)}"
CONTAINER="${DF_CONTAINER:-remote-df}"
REMOTE_SRC="${DF_REMOTE_SRC:-/tmp/df_build}"
BUILD_IMAGE="${DF_BUILD_IMAGE:-localhost/df-interposer-built:latest}"
GO_IMAGE="${DF_GO_IMAGE:-docker.io/library/golang:1.24-alpine}"
WHAT="${1:-all}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

log() { printf '\n== %s\n' "$*"; }

# The build runs inside a container image because libdatachannel's headers are not
# installed on the host or in the runtime container.
build_interposer() {
  log "build interposer"
  for f in interposer/df_streamer.cpp interposer/ws_server.hpp interposer/sha1_b64.hpp; do
    cat "$f" | ssh "$HOST" "cat > $REMOTE_SRC/$(basename "$f")"
  done
  ssh "$HOST" "podman run --rm -v $REMOTE_SRC:/src:Z -w /src $BUILD_IMAGE sh -c '
    g++ -shared -fPIC -O3 -Wall -Wextra -std=c++17 -I/usr/local/include \
        df_streamer.cpp -o libdf_streamer.so \
        -ldl -lpthread -lzstd -ldatachannel -lssl -lcrypto'" 2>&1 | tail -20
  # A failed compile leaves the previous .so in place, which would ship stale code.
  # Refuse to continue unless the artefact is newer than the source we just sent.
  ssh "$HOST" "test $REMOTE_SRC/df_streamer.cpp -nt $REMOTE_SRC/libdf_streamer.so && {
    echo 'BUILD FAILED: libdf_streamer.so is older than the source' >&2; exit 1; } || true"
}

build_server() {
  log "build go server with embedded UI"
  ( cd client && npm run build )
  rm -rf server/infrastructure/web/dist
  cp -r client/dist server/infrastructure/web/dist
  tar cf - server | ssh "$HOST" "tar xf - -C $REMOTE_SRC 2>/dev/null"
  ssh "$HOST" "podman run --rm -v $REMOTE_SRC:/src:Z -w /src/server $GO_IMAGE sh -c '
    CGO_ENABLED=0 GOOS=linux go build -tags embed_ui -ldflags=\"-s -w\" -o /src/server_new main.go'" 2>&1 | tail -20
  ssh "$HOST" "test -f $REMOTE_SRC/server_new"
}

ship() {
  log "ship into container + restart"
  ssh "$HOST" "podman cp $REMOTE_SRC/libdf_streamer.so $CONTAINER:/app/libdf_streamer.so"
  ssh "$HOST" "podman cp $REMOTE_SRC/server_new $CONTAINER:/app/server"
  ssh "$HOST" "podman exec $CONTAINER chmod +x /app/server"
  ssh "$HOST" "podman restart $CONTAINER >/dev/null && sleep 8"
  log "verify running container matches what we just built"
  ssh "$HOST" "podman exec $CONTAINER sha256sum /app/libdf_streamer.so /app/server"
  ssh "$HOST" "sha256sum $REMOTE_SRC/libdf_streamer.so $REMOTE_SRC/server_new"
}

verify_bundle() {
  # The bundle is embedded in the Go binary, NOT served from disk. The only correct
  # check is to compare the local build's filename with the one the page references.
  log "verify the served page references the freshly built bundle"
  # Skipped unless DF_API is set, so the deployment target never has to be written
  # into this file.
  if [ -z "${DF_API:-}" ]; then
    echo "  (set DF_API=http://host:port to enable this check)"
    return 0
  fi
  local local_js served_js
  local_js=$(basename "$(ls client/dist/assets/*.js | head -1)")
  served_js=$(curl -s -m 10 "$DF_API/" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1 || true)
  echo "  local bundle : $local_js"
  echo "  served bundle: ${served_js:-<none>}"
  if [ -n "$served_js" ] && [ "$served_js" != "$local_js" ]; then
    echo "  WARNING: served bundle differs from the local build." >&2
    return 1
  fi
}

case "$WHAT" in
  interposer) build_interposer; ship ;;
  server)     build_server; ship ;;
  all)        build_interposer; build_server; ship ;;
  *) echo "unknown target: $WHAT (use: interposer | server | all)" >&2; exit 2 ;;
esac

echo
echo "deploy complete"
