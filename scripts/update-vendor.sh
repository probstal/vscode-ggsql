#!/usr/bin/env bash
#
# Sync the vendored upstream pieces from posit-dev/ggsql: the
# tree-sitter-ggsql grammar (rebuilt to wasm, used by the standalone/dbt
# query split in src/treeSplit.ts) and the builtin datasets
# (ggsql:penguins & co., served to duckdb by the standalone engine).
#
# Usage: scripts/update-vendor.sh [ref]
#
# `ref` is the upstream tag/branch to pin — keep it matching the
# ggsql-wasm version in package.json so the grammar the extension splits
# with is the grammar ggsql itself parses with. Requires the tree-sitter
# CLI (devDependency); on the first wasm build it downloads wasi-sdk
# (~100MB) into ~/.cache/tree-sitter. Commit the resulting vendor/
# changes, including tree-sitter-ggsql.wasm, so regular builds don't
# need this toolchain.
set -euo pipefail

REF="${1:-v0.4.1}"
REPO="https://github.com/posit-dev/ggsql"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/tree-sitter-ggsql"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $REPO @ $REF (sparse: tree-sitter-ggsql/, src/data/) ..."
git clone --quiet --depth 1 --branch "$REF" --filter=blob:none --sparse "$REPO" "$TMP/ggsql"
git -C "$TMP/ggsql" sparse-checkout set --no-cone /tree-sitter-ggsql /src/data >/dev/null

SRC="$TMP/ggsql/tree-sitter-ggsql"
[ -f "$SRC/grammar.js" ] || { echo "error: no tree-sitter-ggsql/grammar.js at $REF" >&2; exit 1; }

DATA="$TMP/ggsql/src/data"
DATASETS="$ROOT/vendor/ggsql-datasets"
[ -d "$DATA" ] || { echo "error: no src/data at $REF" >&2; exit 1; }
rm -rf "$DATASETS"
mkdir -p "$DATASETS"
cp "$DATA"/*.parquet "$DATASETS/"
cat > "$DATASETS/UPSTREAM" <<EOF
repo: $REPO
ref: $REF
commit: $(git -C "$TMP/ggsql" rev-parse HEAD)
source: src/data/
EOF
echo "Datasets: $(ls "$DATASETS" | grep -c '\.parquet$') parquet files → $DATASETS"

rm -rf "$VENDOR"
mkdir -p "$VENDOR"
cp "$SRC/grammar.js" "$VENDOR/"
[ -f "$SRC/tree-sitter.json" ] && cp "$SRC/tree-sitter.json" "$VENDOR/"
[ -d "$SRC/queries" ] && cp -R "$SRC/queries" "$VENDOR/queries"
[ -d "$SRC/test" ] && cp -R "$SRC/test" "$VENDOR/test"

cat > "$VENDOR/UPSTREAM" <<EOF
repo: $REPO
ref: $REF
commit: $(git -C "$TMP/ggsql" rev-parse HEAD)
EOF

# Generated parser sources are rebuilt on every sync; only the wasm
# artifact is committed.
cat > "$VENDOR/.gitignore" <<EOF
src/
node_modules/
package-lock.json
EOF

cd "$VENDOR"
echo "Generating parser ..."
npx tree-sitter generate

echo "Building tree-sitter-ggsql.wasm ..."
npx tree-sitter build --wasm --output tree-sitter-ggsql.wasm .

echo "Running upstream corpus tests ..."
npx tree-sitter test || echo "warning: corpus tests failed (grammar still built)" >&2

echo "Done: $VENDOR (pinned to $REF)"
