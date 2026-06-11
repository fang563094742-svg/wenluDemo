#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/verify_wenlu_frontdoor.sh"
"$ROOT/scripts/verify_wenlu_river_health.sh"
