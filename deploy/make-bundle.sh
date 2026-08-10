#!/bin/bash
# Build a deployable tarball for the Pi — runtime files only, no node_modules,
# no electron, no build artefacts. Run from anywhere:
#
#   ./deploy/make-bundle.sh      -> dist/synthony-cue-pi-<version>.tar.gz
#
# The colleague receiving it only needs:
#   tar xzf synthony-cue-pi-<version>.tar.gz
#   cd synthony-cue-pi-<version> && ./deploy/install-pi.sh
# ...with README.md sitting right there at the top level.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION="$(node -p "require('./package.json').version")"
NAME="synthony-cue-pi-${VERSION}"
OUT="$DIR/dist/${NAME}.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$DIR/dist" "$STAGE/$NAME"

# Runtime only. electron/, build/ and dist/ are macOS packaging concerns.
for item in server.js package.json package-lock.json start-linux.sh public tc video output data config.json deploy; do
  [ -e "$item" ] && cp -R "$item" "$STAGE/$NAME/"
done

# The Pi guide is the bundle's front-door README so it is the first thing seen.
# It ships once, at the top level — not also buried in deploy/.
mv "$STAGE/$NAME/deploy/README-PI.md" "$STAGE/$NAME/README.md"

# make-bundle.sh is a build tool, not something the Pi needs.
rm -f "$STAGE/$NAME/deploy/make-bundle.sh"

find "$STAGE" -name '.DS_Store' -delete
chmod +x "$STAGE/$NAME/deploy/install-pi.sh" \
         "$STAGE/$NAME/deploy/synthony-kiosk.sh" \
         "$STAGE/$NAME/start-linux.sh"

tar czf "$OUT" -C "$STAGE" "$NAME"

echo "built  $OUT"
echo "size   $(du -h "$OUT" | cut -f1)"
echo
echo "send it:"
echo "  scp $OUT pi@raspberrypi.local:~/"
