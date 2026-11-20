#!/bin/bash
# Shared by the au-local scripts. Sets up Node and the folder names.
export AU_LOCAL_HOME="${AU_LOCAL_HOME:-$HOME/gplink-tools/au-local}"
export PATH="$HOME/gplink-tools/node-v22/bin:$PATH"
AU_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AU_REPO="$(cd "$AU_SCRIPTS/../.." && pwd)"
export AU_SCRIPTS AU_REPO

if ! command -v node >/dev/null 2>&1; then
  echo "STOP: Node was not found at ~/gplink-tools/node-v22/bin." >&2
  exit 1
fi
