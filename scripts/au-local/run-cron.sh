#!/bin/bash
# Runs one scheduled job against the LOCAL app, e.g.:
#   scripts/au-local/run-cron.sh onboarding-nudge
#   scripts/au-local/run-cron.sh --list
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
node "$AU_SCRIPTS/lib/run-cron.js" "$@"
