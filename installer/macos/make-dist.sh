#!/usr/bin/env bash
# Build downloadable, unsigned app zips for both Mac types, each bundling the matching pinned
# pixi (the rest of the app is scripts; the environment installs on first launch):
#   installer/dist/FinancialPlanner-macos-arm64.zip    Apple Silicon
#   installer/dist/FinancialPlanner-macos-x86_64.zip   Intel
# Attach them to a GitHub release. Unsigned: people right-click → Open the first time.
#
#   bash installer/macos/make-dist.sh
#
# License: BSD 3-Clause
set -euo pipefail
cd "$(dirname "$0")/.."
PIXI_VERSION="0.81.0"
DIST="$PWD/dist"
mkdir -p "$DIST"

build_arch() {  # $1 = label (arm64 | x86_64), $2 = pixi target triple
  local label="$1" target="$2" tmp stage zip base want got
  tmp="$(mktemp -d)"; stage="$(mktemp -d)"
  base="https://github.com/prefix-dev/pixi/releases/download/v$PIXI_VERSION/pixi-$target"
  echo "› [$label] fetching pixi $PIXI_VERSION"
  curl -fsSL "$base.tar.gz" -o "$tmp/pixi.tar.gz"
  curl -fsSL "$base.tar.gz.sha256" -o "$tmp/pixi.sha256"
  want="$(awk '{print $1}' "$tmp/pixi.sha256")"
  got="$(shasum -a 256 "$tmp/pixi.tar.gz" | awk '{print $1}')"
  [ "$want" = "$got" ] || { echo "  checksum FAILED for $label" >&2; exit 1; }
  tar xzf "$tmp/pixi.tar.gz" -C "$tmp"
  PIXI_BIN="$tmp/pixi" bash macos/assemble-app.sh "$stage/Financial Planner.app"
  codesign -s - --deep --force "$stage/Financial Planner.app" >/dev/null 2>&1 || true
  zip="$DIST/FinancialPlanner-macos-$label.zip"
  rm -f "$zip"
  ( cd "$stage" && ditto -c -k --keepParent "Financial Planner.app" "$zip" )
  echo "✓ $zip ($(du -h "$zip" | cut -f1))"
  rm -rf "$tmp" "$stage"
}

build_arch arm64 aarch64-apple-darwin
build_arch x86_64 x86_64-apple-darwin
echo "Upload both zips to a GitHub release (arm64 = Apple Silicon, x86_64 = Intel)."
