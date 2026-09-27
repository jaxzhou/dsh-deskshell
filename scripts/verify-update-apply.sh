#!/bin/sh
#
# Prove that the self-update *replacement* step really works.
#
# The helper scripts run after the shell exits, so they are hard to observe in
# normal use. This script exercises them in a throwaway directory instead:
#
#   macOS   : a stub .app is replaced by the locally built zip
#             (release/DSH-D-<version>-mac.zip) — the stub's version must change
#   Linux   : a stub AppImage is replaced by a local file, and must stay +x
#
# A non-existent pid (999999) stands in for "the shell has already exited", so
# the `kill -0` wait returns immediately. Nothing outside the temp dir is touched.
#
# Usage: scripts/verify-update-apply.sh [version]
#
set -eu

cd "$(dirname "$0")/.."
VERSION="${1:-$(node -p "require('./package.json').version")}"
WORK="${TMPDIR:-/tmp}/dsh-d-update-apply"
rm -rf "$WORK"
mkdir -p "$WORK/dl" "$WORK/unpacked"
FAILED=0

ok() { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; FAILED=1; }

make_stub_app() {
  mkdir -p "$1/Contents"
  cat > "$1/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.deepseek.dsh.desktop</string>
<key>CFBundleShortVersionString</key><string>0.0.1-stub</string>
</dict></plist>
PLIST
}

read_version() { /usr/bin/defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?"; }

if [ "$(uname -s)" = "Darwin" ]; then
  ZIP="release/DSH-D-${VERSION}-mac.zip"
  if [ ! -f "$ZIP" ]; then
    echo "缺少 ${ZIP}（先 npm run dist）" >&2
    exit 2
  fi
  TARGET="$WORK/Applications/DSH-D.app"
  mkdir -p "$WORK/Applications"
  make_stub_app "$TARGET"
  BEFORE="$(read_version "$TARGET")"
  node -e '
    const path = require("node:path");
    const fs = require("node:fs");
    const updater = require("./src/main/updater.js");
    const [zip, target, unpack, script] = process.argv.slice(1);
    const asset = { platform: "darwin", arch: "x64", kind: "zip", file: path.basename(zip), url: "https://example.invalid/x", sha256: "0".repeat(64), size: fs.statSync(zip).size };
    const plan = updater.planUpdate({ platform: "darwin", asset, isPackaged: true, appPath: target, directoryWritable: true });
    const body = updater.helperScriptFor(plan, { newFile: zip, target, pid: 999999, relaunch: false, unpackDir: unpack });
    fs.writeFileSync(script, body, { mode: 0o700 });
    console.log(`  计划：${plan.kind}（${plan.note}）`);
  ' "$(pwd)/$ZIP" "$TARGET" "$WORK/unpacked" "$WORK/apply-update.sh"
  sh "$WORK/apply-update.sh"
  AFTER="$(read_version "$TARGET")"
  [ "$BEFORE" = "0.0.1-stub" ] && ok "起始为占位包（${BEFORE}）" || bad "起始状态异常：${BEFORE}"
  [ "$AFTER" = "$VERSION" ] && ok "替换后版本变为 ${AFTER}" || bad "替换后版本为 ${AFTER}（期望 ${VERSION}）"
  [ "$(/usr/bin/defaults read "$TARGET/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "com.deepseek.dsh.desktop" ] \
    && ok "appId 正确" || bad "appId 异常"
  [ -x "$TARGET/Contents/MacOS/DSH-D" ] && ok "可执行权限保留" || bad "可执行文件缺失或不可执行"
fi

# Linux / AppImage 原地替换（脚本本身是 POSIX sh，可在任意平台演练）
TARGET_AI="$WORK/DSH-D.AppImage"
printf 'old-appimage' > "$TARGET_AI"
printf 'new-appimage-binary' > "$WORK/new.AppImage"
node -e '
  const path = require("node:path");
  const fs = require("node:fs");
  const updater = require("./src/main/updater.js");
  const [target, newFile, script] = process.argv.slice(1);
  const asset = { platform: "linux", arch: "x64", kind: "appimage", file: "DSH-D.AppImage", url: "https://example.invalid/x", sha256: "0".repeat(64), size: 1024 };
  const plan = updater.planUpdate({ platform: "linux", asset, isPackaged: true, appImagePath: target, directoryWritable: true });
  const body = updater.helperScriptFor(plan, { newFile, target, pid: 999999, relaunch: false, unpackDir: "" });
  fs.writeFileSync(script, body, { mode: 0o700 });
  console.log(`  计划：${plan.kind}（${plan.note}）`);
' "$TARGET_AI" "$WORK/new.AppImage" "$WORK/apply-appimage.sh"
sh "$WORK/apply-appimage.sh"
[ "$(cat "$TARGET_AI")" = "new-appimage-binary" ] && ok "AppImage 内容已替换" || bad "AppImage 内容未替换（$(cat "$TARGET_AI")）"
[ -x "$TARGET_AI" ] && ok "AppImage 保持可执行" || bad "AppImage 丢失可执行权限"

rm -rf "$WORK"
if [ "$FAILED" -eq 0 ]; then
  echo "替换验证通过 ✓"
else
  echo "替换验证失败 ✗" >&2
  exit 1
fi
