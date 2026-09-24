#!/bin/sh
#
# Run the *packaged* offline Linux app inside a Linux container:
#
#   1. extract release-offline/DSH-D-Offline-<version>-linux-x64.tar.gz
#   2. install Electron's runtime libraries plus xvfb (the container has no
#      display, so the app runs under `xvfb-run`)
#   3. run `--self-test` with an unshared network namespace, so the run itself
#      has no connectivity — the app must be fully served by its own payload
#
# This is the closest thing to "does the offline build actually work on Linux"
# that can be checked without a Linux desktop.
#
# Usage:
#   scripts/verify-offline-app.sh [tarball]
#
set -eu

cd "$(dirname "$0")/.."
TARBALL="${1:-$(ls -1 release-offline/DSH-D-Offline-*-linux-x64.tar.gz 2>/dev/null | tail -1)}"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "找不到离线应用包（先构建：npx electron-builder --config electron-builder.offline.yml --linux）" >&2
  exit 1
fi

IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
WORK="${TMPDIR:-/tmp}/dsh-d-offline-app"
rm -rf "$WORK"
mkdir -p "$WORK"
echo "解压：$TARBALL"
tar xzf "$TARBALL" -C "$WORK"
APPDIR="$(find "$WORK" -maxdepth 1 -type d -name 'DSH-D*' | head -1)"
if [ -z "$APPDIR" ]; then
  echo "压缩包结构异常" >&2
  exit 1
fi
echo "应用目录：$APPDIR"
echo "payload：$(du -sh "$APPDIR/resources/vendor" 2>/dev/null | cut -f1)"

if [ -z "${DOCKER_CONFIG:-}" ] && [ -f "$HOME/.docker/config.json" ]; then
  DOCKER_CONFIG_TMP="${TMPDIR:-/tmp}/dsh-d-docker"
  mkdir -p "$DOCKER_CONFIG_TMP"
  cp -R "$HOME/.docker/contexts" "$DOCKER_CONFIG_TMP/" 2>/dev/null || true
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    delete config.credsStore;
    delete config.credHelpers;
    fs.writeFileSync(process.argv[2], JSON.stringify(config, null, 1));
  ' "$HOME/.docker/config.json" "$DOCKER_CONFIG_TMP/config.json"
  DOCKER_CONFIG="$DOCKER_CONFIG_TMP"
  export DOCKER_CONFIG
fi

# Electron needs its runtime libraries and a display. They are installed in the
# same container run that executes the app: the app itself then runs under
# `unshare -rn` (a fresh user+network namespace with only loopback brought up),
# so the self-test's local fixture server works while the app has no internet.
echo "在容器内运行打包后的应用自检（卸载外网，仅保留 loopback）…"
docker run --rm -i -v "$APPDIR:/app:ro" "${NODE_IMAGE:-node:24-bookworm-slim}" bash -euo pipefail -s <<'CONTAINER_SCRIPT'
echo "--- 安装 Electron 运行时依赖与 xvfb（仅容器内）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
  libgtk-3-0 libnss3 libasound2 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 \
  libcairo2 libatspi2.0-0 libx11-xcb1 libxshmfence1 libxcb-dri3-0 xvfb xauth iproute2 \
  >/dev/null

echo "--- payload 是否随包发布"
ls /app/resources/vendor >/dev/null
node -e 'console.log(JSON.stringify(require("/app/resources/vendor/manifest.json")));'

echo "--- 断网命名空间内运行应用自检"
export DSH_D_USER_DATA=/tmp/userdata
set +e
unshare -rn bash -c 'ip link set lo up 2>/dev/null || true; xvfb-run -a /app/dsh-d-offline --self-test --no-sandbox --disable-gpu' 2>&1 \
  | grep -vE "sandbox initialization failed|Failed to initialize sandbox|task_policy_set" \
  | tail -32
status=${PIPESTATUS[0]}
set -e
echo "self-test 退出码：${status}"
exit "${status}"
CONTAINER_SCRIPT
