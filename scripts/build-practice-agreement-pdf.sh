#!/bin/bash
# Rebuilds assets/legal/gp-link-practice-agreement-2026.pdf from the HTML
# source at assets/legal/src/agreement-2026.html.
#
# The HTML uses {{LOGO}} / {{STRIP}} placeholders which are replaced with
# base64 data URIs of assets/legal/src/logo.png and strip.png, then printed
# to PDF with headless Chrome (A4, no margins — the page handles its own).
#
# Usage: bash scripts/build-practice-agreement-pdf.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/legal/src"
OUT="$ROOT/assets/legal/gp-link-practice-agreement-2026.pdf"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP_HTML="$(mktemp -t agreement-2026).html"

python3 - "$SRC/agreement-2026.html" "$SRC/logo.png" "$SRC/strip.png" "$TMP_HTML" <<'PY'
import base64, sys
html_path, logo_path, strip_path, out_path = sys.argv[1:5]
html = open(html_path, encoding='utf-8').read()
def data_uri(p):
    return 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
html = html.replace('{{LOGO}}', data_uri(logo_path)).replace('{{STRIP}}', data_uri(strip_path))
open(out_path, 'w', encoding='utf-8').write(html)
PY

"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$OUT" "file://$TMP_HTML" 2>/dev/null

rm -f "$TMP_HTML"
echo "Built: $OUT"
