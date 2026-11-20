#!/bin/bash
# Downloads the official PostgREST release binary (macOS, Apple silicon) into
# ~/gplink-tools/au-local/postgrest/ and checks its fingerprint. Safe to re-run.
set -euo pipefail

AU_HOME="${AU_LOCAL_HOME:-$HOME/gplink-tools/au-local}"
VERSION="v14.5"   # the version production runs (read from the live API description)
ASSET="postgrest-${VERSION}-macos-aarch64.tar.xz"
SHA256="754b462c2b3e0d7a7defe44161c0d56233f41de6307e5cb136ef7d2e7ecc0124"
RELEASE_HOST="github.com"
URL="https://${RELEASE_HOST}/PostgREST/postgrest/releases/download/${VERSION}/${ASSET}"
# The macOS build of PostgREST needs libpq; the copy bundled with the local Postgres is used.
PG_LIB="$AU_HOME/node_modules/@embedded-postgres/darwin-arm64/native/lib"
BIN="$AU_HOME/postgrest/postgrest"

if [ -x "$BIN" ] && DYLD_LIBRARY_PATH="$PG_LIB" "$BIN" --version 2>/dev/null | grep -q "${VERSION#v}"; then
  echo "  already installed."
  exit 0
fi

mkdir -p "$AU_HOME/dl" "$AU_HOME/postgrest"
echo "  downloading PostgREST ${VERSION}..."
curl -fsSL -o "$AU_HOME/dl/$ASSET" "$URL"
ACTUAL="$(shasum -a 256 "$AU_HOME/dl/$ASSET" | awk '{print $1}')"
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "  STOP: the downloaded PostgREST file does not match the expected fingerprint." >&2
  echo "  expected $SHA256" >&2
  echo "  got      $ACTUAL" >&2
  exit 1
fi
tar -xJf "$AU_HOME/dl/$ASSET" -C "$AU_HOME/postgrest"
chmod +x "$BIN"
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
echo "  installed: $(DYLD_LIBRARY_PATH="$PG_LIB" "$BIN" --version)"
