#!/bin/sh
# Update this running copy from GitHub. Develop in ~/Developer/repos/sitegeist, push to main, then run this here.
set -eu
cd "$(dirname "$0")"
LABEL=""  # no launchd job: unpacked extension loaded in Brave from dist-chrome/
TEST="npm test && npm run typecheck"  # not check.sh: biome --write would edit this copy
INSTALL="npm ci --no-audit --no-fund"
DEPS="package.json package-lock.json"
BUILD="npm run build"
AFTER="Reload Sitegeist in brave://extensions to pick up the new build."

if ! git diff --quiet HEAD; then
  echo "The running copy has local edits. Make changes in the working copy and push instead:" >&2
  git status --short >&2
  exit 1
fi

before=$(git rev-parse HEAD)
git pull --ff-only
git diff --quiet "$before" HEAD -- $DEPS || sh -c "$INSTALL"

if ! sh -c "$TEST"; then
  git reset -q --hard "$before"
  sh -c "$INSTALL"
  [ -z "$BUILD" ] || sh -c "$BUILD"
  echo "Tests failed; rolled back to $(git log -1 --format='%h %s')" >&2
  exit 1
fi
[ -z "$BUILD" ] || sh -c "$BUILD"

if [ -n "$LABEL" ] && ! git diff --quiet "$before" HEAD -- launchd/; then
  cp "launchd/$LABEL.plist" ~/Library/LaunchAgents/
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/"$LABEL.plist"
fi

echo "Deployed $(git log -1 --format='%h %s')"
[ -z "$AFTER" ] || echo "$AFTER"
