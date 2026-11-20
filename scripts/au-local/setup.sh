#!/bin/bash
# One-time setup of the GP Link local test stack. Safe to run again.
#   - downloads Postgres 17 and PostgREST into ~/gplink-tools/au-local/ (outside the repo)
#   - creates a private, empty database on this Mac
#   - loads the production-shaped STRUCTURE (no production data)
#   - applies the Australian GP migrations and adds obviously fake test data
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

echo "GP Link local test stack: setup"
echo

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "STOP: this setup is written for an Apple-silicon Mac." >&2
  exit 1
fi

echo "Step 1 of 6: tools folder ($AU_LOCAL_HOME)"
mkdir -p "$AU_LOCAL_HOME"
if [ ! -f "$AU_LOCAL_HOME/package.json" ]; then
  printf '{\n  "name": "gplink-au-local-tools",\n  "private": true,\n  "description": "Binaries for the GP Link local test stack. Not part of the app."\n}\n' > "$AU_LOCAL_HOME/package.json"
fi

echo "Step 2 of 6: Postgres 17 (the same major version as production)"
if [ -x "$AU_LOCAL_HOME/node_modules/@embedded-postgres/darwin-arm64/native/bin/postgres" ] && [ -d "$AU_LOCAL_HOME/node_modules/pg" ]; then
  echo "  already installed."
else
  echo "  downloading (about 30 MB)..."
  (cd "$AU_LOCAL_HOME" && npm install --no-audit --no-fund --loglevel=error embedded-postgres@17.12.0-beta.19)
  echo "  installed."
fi

echo "Step 3 of 6: PostgREST (the same version as production)"
bash "$AU_SCRIPTS/lib/fetch-postgrest.sh"

echo "Step 4 of 6: local database with the production-shaped structure"
node "$AU_SCRIPTS/lib/stack.js" setup-db

echo "Step 5 of 6: Australian GP migrations (local database only)"
node "$AU_SCRIPTS/lib/apply-migrations.js"

echo "Step 6 of 6: fake test data"
node "$AU_SCRIPTS/seed.js"

node "$AU_SCRIPTS/lib/stack.js" stop >/dev/null 2>&1 || true
echo
echo "Setup finished. Start everything with:"
echo "  scripts/au-local/start.sh"
