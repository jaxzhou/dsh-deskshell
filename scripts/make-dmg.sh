#!/bin/sh
#
# Build a drag-to-install DMG from an already packaged .app using only macOS
# tooling.
#
# electron-builder's own `dmg` target downloads a `dmgbuild` bundle from GitHub
# Releases, which fails on networks that cannot reach GitHub. `npm run dist:mac`
# still produces the .app and the .zip in that case; this script turns the .app
# into a plain DMG containing the app plus an /Applications shortcut.
#
# Usage:
#   scripts/make-dmg.sh [app-path] [dmg-path]
#
set -eu

cd "$(dirname "$0")/.."

APP="${1:-release/mac/DSH-D.app}"
if [ ! -d "$APP" ]; then
  echo "未找到应用包：$APP" >&2
  echo "请先运行：npm run pack   （或 npx electron-builder --mac --dir）" >&2
  exit 1
fi

NAME="$(node -p "require('./package.json').productName")"
VERSION="$(node -p "require('./package.json').version")"
OUT="${2:-release/${NAME}-${VERSION}.dmg}"
STAGE="release/.dmg-stage"

echo "应用包：$APP"
echo "输出：  $OUT"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$(dirname "$OUT")"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# UDZO = compressed, read-only image (what most apps ship).
rm -f "$OUT"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"

echo "完成：$OUT"
hdiutil verify "$OUT"
