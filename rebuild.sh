#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Stage + atomic swap: emptyOutDir on the live dist/web breaks requests mid-build and can leave it broken.
STAGE=dist/web.next
PREV=dist/web.prev

echo "Building UI..."
rm -rf "$STAGE"
npm run build -- --outDir "$STAGE" --emptyOutDir

# Swap: two renames, so dist/web is only ever the whole old tree or the new one.
rm -rf "$PREV"
if [ -d dist/web ]; then mv dist/web "$PREV"; fi
mv "$STAGE" dist/web
rm -rf "$PREV"

echo "Build complete."
