#!/usr/bin/env bash
# Assemble an (unsigned) "Financial Planner.app" at the given path. The one place that knows
# what goes inside the app, so local and distributable builds can't drift apart.
#
#   PIXI_BIN=/path/to/pixi FP_SOURCE=/path/to/checkout bash assemble-app.sh "/dest/Financial Planner.app"
#
# PIXI_BIN   the pixi binary to bundle (default: the pixi on PATH)
# FP_SOURCE  optional local checkout to install instead of the GitHub repository
#
# License: BSD 3-Clause
set -euo pipefail
INSTALLER="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$INSTALLER/.." && pwd)"
DEST="${1:?usage: assemble-app.sh \"/path/to/Financial Planner.app\"}"
PIXI_BIN="${PIXI_BIN:-$(command -v pixi || true)}"
[ -n "$PIXI_BIN" ] && [ -x "$PIXI_BIN" ] || { echo "need PIXI_BIN or pixi on PATH" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$INSTALLER/macos/app/Financial Planner.app" "$DEST"
RES="$DEST/Contents/Resources"
mkdir -p "$RES/payload"
cp "$INSTALLER/shared/bootstrap.sh" "$RES/bootstrap.sh"
cp "$REPO/src/financial_planner/assets/AppIcon.icns" "$RES/AppIcon.icns"
cp "$PIXI_BIN" "$RES/payload/pixi"
( cd "$RES/payload" && shasum -a 256 pixi > pixi.sha256 )
if [ -n "${FP_SOURCE:-}" ]; then
  src="$(cd "$FP_SOURCE" && pwd)"
  sed "s#^financial-planner = .*#financial-planner = { path = \"$src\", extras = [\"desktop\"] }#" \
    "$INSTALLER/manifest/pixi.toml" > "$RES/payload/pixi.toml"
else
  cp "$INSTALLER/manifest/pixi.toml" "$RES/payload/pixi.toml"
fi
chmod +x "$DEST/Contents/MacOS/launch" "$RES/payload/pixi"
