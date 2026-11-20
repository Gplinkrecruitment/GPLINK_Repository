#!/bin/bash
# Renders the DRAFT Australian-GP presentation of the practice agreement to a PDF
# so its layout can be checked. LOCAL CHECK ONLY.
#
# DRAFT - FOR LEGAL REVIEW - NOT FOR SIGNATURE. The output must not be sent to a
# practice and must not be committed. See docs/au-gp/agreement-au-variant-legal-review.md.
#
# This is deliberately a separate script from build-practice-agreement-pdf.sh:
#   - that script writes into assets/legal/, and everything under assets/ is
#     served publicly by server.js and shipped to Vercel;
#   - this one reads the draft source from docs/ (never served) and refuses to
#     write anywhere inside assets/.
#
# Usage: bash scripts/build-au-draft-agreement-pdf.sh [output.pdf]
#   default output: $TMPDIR/gp-link-practice-agreement-2026-au-DRAFT.pdf
#
# Needs python3 and Google Chrome, like the real build. No network.
#
# .page is a fixed 297mm box with overflow:hidden, so text that runs past the
# footer is silently clipped. After any edit, measure each page (the legal-review
# document says how) before trusting the render.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="$ROOT/docs/au-gp/legal-draft/agreement-2026-au-draft.html"
IMG="$ROOT/assets/legal/src"
OUT="${1:-${TMPDIR:-/tmp}/gp-link-practice-agreement-2026-au-DRAFT.pdf}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

case "$OUT" in
  /*) ;;
  *) OUT="$PWD/$OUT" ;;
esac
case "$OUT" in
  "$ROOT"/assets/*)
    echo "Refusing to write the draft into assets/ (publicly served): $OUT" >&2
    exit 1
    ;;
esac

if [ ! -f "$IN" ]; then
  echo "No such draft source: $IN" >&2
  exit 1
fi

TMP_HTML="$(mktemp -t agreement-2026-au-draft).html"

python3 - "$IN" "$IMG/logo.png" "$IMG/strip.png" "$TMP_HTML" <<'PY'
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
echo "Built DRAFT (do not send, do not commit): $OUT"
