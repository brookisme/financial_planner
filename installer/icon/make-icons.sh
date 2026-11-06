#!/usr/bin/env bash
# Render the app icon (financial-planner.svg) and the menu-bar icon (tray.svg) into the
# package's assets: AppIcon.icns (macOS), app_icon.png (1024) and tray.png.
#
#   bash installer/icon/make-icons.sh
#
# Rasterizer (first found): rsvg-convert (brew install librsvg), then headless Google Chrome.
# .icns needs iconutil (macOS). The generated files are committed, so building the app
# doesn't need any of this; run it only after changing the SVGs.
#
# License: BSD 3-Clause
set -euo pipefail
cd "$(dirname "$0")"
OUT="../../src/financial_planner/assets"
TMP="$(mktemp -d)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

rasterize() {  # rasterize <svg> <px> <out.png>
  local svg="$1" px="$2" out="$3"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$px" -h "$px" "$svg" -o "$out"
  elif [ -x "$CHROME" ]; then
    printf '<html><body style="margin:0"><img src="file://%s" width="%s" height="%s"></body></html>' \
      "$PWD/$svg" "$px" "$px" > "$TMP/page.html"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --default-background-color=00000000 --window-size="$px,$px" \
      --screenshot="$out" "file://$TMP/page.html" >/dev/null 2>&1
  else
    echo "need rsvg-convert (brew install librsvg) or Google Chrome" >&2; exit 1
  fi
}

mkdir -p "$OUT"
rasterize financial-planner.svg 1024 "$OUT/app_icon.png"
ICONSET="$TMP/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  rasterize financial-planner.svg "$s" "$ICONSET/icon_${s}x${s}.png"
  rasterize financial-planner.svg "$((s * 2))" "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$OUT/AppIcon.icns"
rasterize tray.svg 64 "$OUT/tray.png"
rm -rf "$TMP"
echo "wrote $OUT/AppIcon.icns, app_icon.png, tray.png"
