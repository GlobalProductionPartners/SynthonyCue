#!/bin/bash
# Build the Pi bundle and publish it as a GitHub release asset, so venue
# servers can pull updates with Settings → Updates → Check Source pointed at
#   github:<owner>/<repo>
#
#   ./deploy/publish-release.sh [owner/repo]
#
# Requires: gh CLI, authenticated with access to the repo.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${1:-$(git -C "$DIR" remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]##; s#\.git$##')}"
[ -n "$REPO" ] || { echo "No repo given and no origin remote"; exit 1; }

"$DIR/deploy/make-bundle.sh" >/dev/null
BUNDLE=$(ls -t "$DIR"/dist/synthony-cue-pi-*.tar.gz | head -1)
# bsdtar (macOS) has no --wildcards; extract VERSION to a temp dir instead.
_tmp=$(mktemp -d)
tar xzf "$BUNDLE" -C "$_tmp" 2>/dev/null
VER=$(cat "$_tmp"/*/VERSION 2>/dev/null | head -1)
rm -rf "$_tmp"
[ -n "$VER" ] || { echo "could not read VERSION from bundle"; exit 1; }
TAG="build-${VER//+/-}"

echo "publishing $BUNDLE as $TAG to $REPO"
gh release create "$TAG" "$BUNDLE" --repo "$REPO" \
  --title "Synthony Cue $VER" \
  --notes "Pi bundle $VER — servers pull this via Settings → Updates (github:$REPO)"
echo "done — servers with source github:$REPO will stage this on next Check"
