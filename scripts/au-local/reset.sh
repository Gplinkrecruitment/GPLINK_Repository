#!/bin/bash
# Wipes the LOCAL test database, stored files and Outbox, then rebuilds them
# clean with the fake test data. Refuses to run against anything that is not
# the local test database. Does not touch production in any way.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

echo "GP Link local test stack: reset"
case "$AU_LOCAL_HOME" in
  */gplink-tools/au-local*) ;;
  *) echo "STOP: the data folder ($AU_LOCAL_HOME) is not the local test stack folder. Nothing was changed." >&2; exit 1 ;;
esac
if [ -n "${SUPABASE_URL:-}" ] || [ -n "${DATABASE_URL:-}" ]; then
  echo "  note: SUPABASE_URL / DATABASE_URL in this terminal are ignored. Only the local database is reset."
fi

echo "Step 1 of 4: wiping the local database, stored files and Outbox"
node "$AU_SCRIPTS/lib/stack.js" wipe
echo "Step 2 of 4: rebuilding the database from the production-shaped structure"
node "$AU_SCRIPTS/lib/stack.js" setup-db
echo "Step 3 of 4: Australian GP migrations (local database only)"
node "$AU_SCRIPTS/lib/apply-migrations.js"
echo "Step 4 of 4: fake test data"
node "$AU_SCRIPTS/seed.js"
node "$AU_SCRIPTS/lib/stack.js" stop >/dev/null 2>&1 || true
echo
echo "Reset finished. Start again with: scripts/au-local/start.sh"
