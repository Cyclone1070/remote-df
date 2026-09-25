#!/bin/sh
set -e

. "$(dirname "$0")/../lib/common.sh"

echo "ℹ INFO: Suite 02: Games Discovery & Dynamic Tags ($BASE_URL)"

# 1. /api/games
assert_status GET "$BASE_URL/api/games" 200
assert_jq '.[] | select(.id == "dwarf-fortress") | .name' "Found 'dwarf-fortress' in game library"
assert_jq '.[] | select(.id == "dwarf-fortress") | .tags[] | select(.name == "Simulation" and .level == "genre")' "Validated dynamic genre tag: Simulation"
assert_jq '.[] | select(.id == "dwarf-fortress") | .tags[] | select(.name == "Colony Sim" and .level == "subgenre")' "Validated dynamic subgenre tag: Colony Sim"
