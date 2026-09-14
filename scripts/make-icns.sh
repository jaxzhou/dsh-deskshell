#!/bin/sh
#
# Generate assets/icon.icns from assets/icon.png using only macOS tooling.
#
# electron-builder's macOS target otherwise downloads an "icons" tool bundle
# from GitHub Releases to do this conversion, which fails on networks that
# cannot reach GitHub. Shipping the .icns removes that download.
#
set -eu

cd "$(dirname "$0")/.."

SRC="assets/icon.png"
OUT="assets/icon.icns"
SET="assets/icon.iconset"

if [ ! -f "$SRC" ]; then
  echo "未找到源图标：$SRC" >&2
  exit 1
fi

rm -rf "$SET"
mkdir -p "$SET"

# iconutil expects these exact names: base size plus @2x retina variants.
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  size="${spec%% *}"
  name="${spec##* }"
  sips -z "$size" "$size" "$SRC" --out "$SET/$name.png" >/dev/null
done

iconutil -c icns "$SET" -o "$OUT"
rm -rf "$SET"

echo "已生成 $OUT"
ls -lh "$OUT"
