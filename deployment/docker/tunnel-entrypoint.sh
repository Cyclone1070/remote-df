#!/bin/sh
set -e

ORIGIN="${ORIGIN_URL:-http://remote-df:8484}"

if [ -n "$CF_TUNNEL_TOKEN" ]; then
    echo "[Tunnel] Starting Named Cloudflare Tunnel with token..."
    exec cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN"
else
    echo "[Tunnel] No CF_TUNNEL_TOKEN provided. Starting Quick Tunnel for ${ORIGIN}..."
    echo "[Tunnel] Check logs below for your public https://*.trycloudflare.com URL."
    exec cloudflared tunnel --no-autoupdate --url "$ORIGIN"
fi
