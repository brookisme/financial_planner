#!/usr/bin/env bash
# Build "Financial Planner.app" on this Mac and put it in /Applications (no certificates needed;
# it's ad-hoc signed so it runs here). First launch installs the environment (a few minutes).
#
#   bash installer/macos/make-local-app.sh                 # installs the GitHub version
#   FP_SOURCE=. bash installer/macos/make-local-app.sh     # installs this checkout instead
#   bash installer/macos/make-local-app.sh ~/Applications  # another destination folder
#
# License: BSD 3-Clause
set -euo pipefail
# resolve paths given relative to where the command was run, before changing folders
[ -n "${FP_SOURCE:-}" ] && FP_SOURCE="$(cd "$FP_SOURCE" && pwd)" && export FP_SOURCE
# default: /Applications (what Finder shows), or ~/Applications if that isn't writable
DEFAULT_DIR="/Applications"; [ -w "$DEFAULT_DIR" ] || DEFAULT_DIR="$HOME/Applications"
DEST_DIR="${1:-$DEFAULT_DIR}"
mkdir -p "$DEST_DIR"
DEST="$(cd "$DEST_DIR" && pwd)/Financial Planner.app"
cd "$(dirname "$0")/.."
echo "› building $DEST"
bash macos/assemble-app.sh "$DEST"
codesign -s - --deep --force "$DEST" >/dev/null 2>&1 || true
# a changed app at the same path can keep its old icon until Finder notices
touch "$DEST"
echo "✓ built $DEST"
echo "  Open it from Applications (or Spotlight: Financial Planner)."
echo "  Logs: ~/Library/Application Support/FinancialPlanner/"
