#!/bin/sh
#
# Build the fully offline, self-contained Linux payload used by DSH-D's
# "offline" Linux build.
#
# It produces `vendor/`:
#
#   vendor/node/           Node.js runtime (linux-x64) + npm + pnpm + dsh
#   vendor/dsh-home/       DSH_HOME seed whose `web` profile already contains
#                          @jaxzhou/dsh-file-explorer, so nothing is downloaded
#                          on first run
#   vendor/pnpm-store.tgz  pnpm store, so plugin installs also work offline
#   vendor/plugins/        the bundled plugin's tarball
#   vendor/manifest.json   what was built (the client shows these versions)
#
# Everything is built inside a Linux container on purpose: a macOS cross-install
# (`npm install --os=linux`) can still pick darwin binaries for optional and
# native dependencies, and dsh's tree contains a native addon (node-pty).
#
# Usage:
#   scripts/build-offline-linux.sh [vendor-dir]
#
# Environment overrides: DSH_VERSION, PLUGIN_VERSION, PNPM_VERSION, NODE_IMAGE.
#
set -eu

cd "$(dirname "$0")/.."
OUT="$(pwd)/${1:-vendor}"

DSH_VERSION="${DSH_VERSION:-0.1.5-rc.3}"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.1.6}"
PNPM_VERSION="${PNPM_VERSION:-12.6.0}"
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

echo "离线 bundle 构建"
echo "  输出目录：$OUT"
echo "  dsh      ：$DSH_VERSION"
echo "  插件     ：@jaxzhou/dsh-file-explorer@$PLUGIN_VERSION"
echo "  pnpm     ：$PNPM_VERSION"
echo "  基础镜像 ：$NODE_IMAGE"

# Docker Desktop's credential helper talks to the macOS keychain, which a
# sandboxed shell cannot reach; a config without credsStore still pulls public
# images. Only set up when the caller has not chosen a docker config.
if [ -z "${DOCKER_CONFIG:-}" ] && [ -f "$HOME/.docker/config.json" ]; then
  DOCKER_CONFIG_TMP="${TMPDIR:-/tmp}/dsh-d-docker"
  rm -rf "$DOCKER_CONFIG_TMP"
  mkdir -p "$DOCKER_CONFIG_TMP"
  cp -R "$HOME/.docker/contexts" "$DOCKER_CONFIG_TMP/" 2>/dev/null || true
  node -e '
    const fs = require("node:fs");
    const source = process.argv[1];
    const target = process.argv[2];
    const config = JSON.parse(fs.readFileSync(source, "utf8"));
    delete config.credsStore;
    delete config.credHelpers;
    fs.writeFileSync(target, JSON.stringify(config, null, 1));
  ' "$HOME/.docker/config.json" "$DOCKER_CONFIG_TMP/config.json"
  DOCKER_CONFIG="$DOCKER_CONFIG_TMP"
  export DOCKER_CONFIG
  echo "  docker 配置：${DOCKER_CONFIG}（已移除钥匙串助手）"
fi

mkdir -p "$OUT"

# The container script arrives over stdin so that shell quoting inside it cannot
# be mangled by the host command line.
docker run --rm -i \
  -e DSH_VERSION="$DSH_VERSION" \
  -e PLUGIN_VERSION="$PLUGIN_VERSION" \
  -e PNPM_VERSION="$PNPM_VERSION" \
  -v "$OUT:/out" \
  "$NODE_IMAGE" \
  bash -euo pipefail -s <<'CONTAINER_SCRIPT'
echo "--- 1/5 拷贝 Node 运行时"
rm -rf /out/node /out/dsh-home /out/.pnpm-store /out/pnpm-store /out/pnpm-store.tgz /out/plugins /out/manifest.json
mkdir -p /out/node/bin /out/node/lib
cp -a /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /out/node/bin/
cp -a /usr/local/lib/node_modules /out/node/lib/
if [ -d /usr/local/include/node ]; then
  mkdir -p /out/node/include
  cp -a /usr/local/include/node /out/node/include/
fi

echo "--- 2/5 安装 pnpm 与 dsh 到同一 prefix"
export npm_config_cache=/tmp/npm-cache
npm install -g --prefix /out/node --no-fund --no-audit "pnpm@${PNPM_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}"

echo "--- 3/5 生成 DSH_HOME 种子并安装插件（从零开始，确保 store 被填充）"
export DSH_HOME=/out/dsh-home
export PATH=/out/node/bin:$PATH
dsh plugin --profile web add "@jaxzhou/dsh-file-explorer@${PLUGIN_VERSION}"

echo "--- 4/5 打包 pnpm store 与插件 tarball（供离线安装）"
# The store is a content-addressable tree of hard links; copying it onto a
# macOS-hosted bind mount fails silently, so it travels as a tar archive that
# the app extracts on first run. pnpm keeps the store beside the project when
# the project is on another device, so it is located by its index.
index="$(find /out -maxdepth 5 -type f -name index.db 2>/dev/null | head -1)"
store="$(dirname "${index:-}")"
if [ -z "$index" ]; then
  store="$(pnpm store path)"
fi
echo "    store: $store"
ls "$store" >/dev/null
tar czf /out/pnpm-store.tgz -C "$store" .
mkdir -p /out/plugins
(cd /out/plugins && npm pack --silent "@jaxzhou/dsh-file-explorer@${PLUGIN_VERSION}" >/dev/null)

echo "--- 5/5 清理与生成 manifest"
rm -rf /out/dsh-home/.credentials.yaml \
       /out/dsh-home/.anonymous-user-id \
       /out/dsh-home/sessions \
       /out/dsh-home/attachments \
       /out/dsh-home/llm-deepseek \
       /out/dsh-home/profiles/web/.dsh-module-fallback \
       /tmp/npm-cache

node -e '
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const first = (bin, args) => {
    try { return execFileSync(bin, args, { encoding: "utf8" }).trim().split("\n")[0]; } catch { return null; }
  };
  const plugin = require("/out/dsh-home/profiles/web/node_modules/@jaxzhou/dsh-file-explorer/package.json");
  const manifest = {
    schema: 1,
    builtAt: new Date().toISOString(),
    platform: "linux-x64",
    node: process.version,
    npm: first("/out/node/bin/npm", ["-v"]),
    pnpm: first("/out/node/bin/pnpm", ["-v"]),
    dsh: first("/out/node/bin/dsh", ["--version"]),
    plugin: "@jaxzhou/dsh-file-explorer@" + plugin.version,
    dshHome: "dsh-home",
    pnpmStore: "pnpm-store.tgz"
  };
  fs.writeFileSync("/out/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest));
'

echo
echo "--- 版本自检"
node -v
npm -v
pnpm -v
dsh --version
echo "插件清单："
cat /out/dsh-home/profiles/web/package.json
echo
echo "--- 体积"
du -sh /out/node /out/dsh-home /out/pnpm-store.tgz /out/plugins
CONTAINER_SCRIPT

echo
echo "完成：$OUT"
