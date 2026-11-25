#!/bin/bash
# Starts the whole local test stack: Postgres, PostgREST, the gateway and the app.
#   scripts/au-local/start.sh
#   AU_PATHWAY_ENABLED=false scripts/au-local/start.sh   (Australian pathway switched OFF)
#   AU_LOCAL_ALLOW_AI=1 scripts/au-local/start.sh        (lets REAL AI calls through; see LOCAL-STACK.md)
#   AHPRA_LOOKUP_PROVIDER=fixture scripts/au-local/start.sh   (the Ahpra register lookup, answered from made-up
#                                                         test numbers only; the real register is never asked)
#
# The app is started with a fixed, explicit list of settings and does not read
# any .env file, so it cannot be pointed at the live database by accident.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

echo "GP Link local test stack: starting"
if [ ! -f "$AU_LOCAL_HOME/pgdata/PG_VERSION" ]; then
  echo "STOP: not set up yet. Run scripts/au-local/setup.sh first." >&2
  exit 1
fi
if [ ! -d "$AU_REPO/node_modules" ]; then
  echo "STOP: the app's node_modules folder is missing. In the project folder run:" >&2
  echo '  ln -s "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/node_modules" node_modules' >&2
  exit 1
fi
if [ -f "$AU_REPO/.env" ]; then
  echo "  note: a .env file exists in this folder. It is IGNORED by the local stack."
fi
if [ "${AU_LOCAL_ALLOW_AI:-0}" = "1" ]; then
  echo
  echo "  WARNING: AU_LOCAL_ALLOW_AI=1. AI features will send test content to Anthropic"
  echo "  using the real key from the main project folder, and will cost money."
  echo
fi

node "$AU_SCRIPTS/lib/stack.js" stop >/dev/null 2>&1 || true
node "$AU_SCRIPTS/lib/stack.js" start-db
if [ "${AU_LOCAL_SKIP_MIGRATIONS:-0}" != "1" ]; then
  node "$AU_SCRIPTS/lib/apply-migrations.js" --quiet
fi
AU_PATHWAY_ENABLED="${AU_PATHWAY_ENABLED:-true}" AU_LOCAL_ALLOW_AI="${AU_LOCAL_ALLOW_AI:-0}" node "$AU_SCRIPTS/lib/stack.js" start-app

cat <<EOF

Ready. Open these in Chrome:

  Doctor app (sign in / sign up)   http://localhost:3000/pages/signin
  CEO dashboard (super admin)      http://localhost:3000/pages/ceo-dashboard
  Admin dashboard (super admin)    http://localhost:3000/pages/admin
  Staff sign-in (CEO, consultant)  http://localhost:3000/pages/admin-signin
  Staff sign-in (RSO)              http://127.0.0.1:3000/pages/admin-signin
  Outbox (every message "sent")    http://localhost:54321/outbox

Seeded logins (password for all: GpLink-Test-2026!)
  ceo@gplink-test.local            super admin      use http://localhost:3000
  consultant@gplink-test.local     consultant       use http://localhost:3000
  rso@gplink-test.local            RSO / staff      use http://127.0.0.1:3000
  uk.doctor@gplink-test.local      overseas doctor  http://localhost:3000/pages/signin

Logs: $AU_LOCAL_HOME/logs/     Stop: scripts/au-local/stop.sh
EOF
