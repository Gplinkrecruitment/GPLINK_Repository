#!/bin/bash
# Applies every supabase/migrations/*au_gp* file, in filename order, to the
# LOCAL test database only, then lists what each one added. Safe to re-run.
# This is how a migration is tried against the live-shaped structure before
# the owner is asked to apply it to production.
#   scripts/au-local/apply-migrations.sh            apply anything new
#   scripts/au-local/apply-migrations.sh --redo     apply every au_gp file again (they must be re-runnable)
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
echo "GP Link local test stack: Australian GP migrations (local database only)"
node "$AU_SCRIPTS/lib/stack.js" setup-db >/dev/null
node "$AU_SCRIPTS/lib/apply-migrations.js" "$@"
