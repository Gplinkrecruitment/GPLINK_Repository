#!/bin/bash
# Rebuilds a practice-agreement PDF from its HTML source in assets/legal/src.
#
# The HTML uses {{LOGO}} / {{STRIP}} placeholders which are replaced with
# base64 data URIs of assets/legal/src/logo.png and strip.png, then printed
# to PDF with headless Chrome (A4, no margins — the page handles its own).
#
# Usage: bash scripts/build-practice-agreement-pdf.sh [variant]
#   (no argument)      -> agreement-2026.html            -> gp-link-practice-agreement-2026.pdf
#   discounted         -> agreement-2026-discounted.html -> gp-link-practice-agreement-2026-discounted.pdf
#
# Variants are registered in lib/agreement-variants.js — add a row there too, or
# the app will never serve the file this builds.
#
# ⚠️ .page is a fixed 297mm box with `overflow:hidden`. Content that runs past the
# footer is silently CLIPPED and the page count does NOT change, so a page-count
# check cannot catch a layout break. After any edit that changes height, measure
# each page's content against its footer line before shipping.
set -euo pipefail

VARIANT="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/legal/src"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ -z "$VARIANT" ]; then
  IN="$SRC/agreement-2026.html"
  OUT="$ROOT/assets/legal/gp-link-practice-agreement-2026.pdf"
else
  IN="$SRC/agreement-2026-$VARIANT.html"
  OUT="$ROOT/assets/legal/gp-link-practice-agreement-2026-$VARIANT.pdf"
fi

if [ ! -f "$IN" ]; then
  echo "No such agreement source: $IN" >&2
  exit 1
fi

TMP_HTML="$(mktemp -t agreement-2026).html"

python3 - "$IN" "$SRC/logo.png" "$SRC/strip.png" "$TMP_HTML" <<'PY'
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
