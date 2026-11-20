#!/bin/bash
# Stops the local test stack. Data is kept; start.sh brings it back as it was.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
echo "GP Link local test stack: stopping"
node "$AU_SCRIPTS/lib/stack.js" stop
echo "Stopped."
