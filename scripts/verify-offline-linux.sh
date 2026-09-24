#!/bin/sh
#
# Verify the offline Linux payload in a *network-less* Linux container:
#
#   1. the bundled Node / npm / pnpm / dsh all run
#   2. the seeded DSH_HOME profile already contains the plugin
#   3. `dsh web` boots with no network and serves the Web UI over loopback —
#      the strongest available proof that the bundle is self-contained
#
# The container script arrives over stdin (`bash -s`) so that neither the host
# shell nor this file's quoting can corrupt it.
#
# Usage:
#   scripts/verify-offline-linux.sh [vendor-dir]
#
set -eu

cd "$(dirname "$0")/.."
VENDOR="$(pwd)/${1:-vendor}"
IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

if [ ! -x "$VENDOR/node/bin/node" ]; then
  echo "找不到离线 payload：${VENDOR}（先运行 scripts/build-offline-linux.sh）" >&2
  exit 1
fi

# Docker Desktop's credential helper needs the macOS keychain, which a sandboxed
# shell cannot reach; a config without credsStore still pulls public images.
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

echo "离线 payload 验证：$VENDOR"
echo "（容器网络已关闭：--network none）"

docker run --rm -i --network none -v "$VENDOR:/vendor:ro" -v "$(pwd):/repo:ro" "$IMAGE" bash -euo pipefail -s <<'CONTAINER_SCRIPT'
pass=0
fail=0
check() {
  if [ "$1" = "1" ]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$2"
  else
    fail=$((fail + 1))
    printf '  ✗ %s %s\n' "$2" "${3:+— $3}"
  fi
}

echo
echo "1. 运行时（断网）"
export PATH=/vendor/node/bin:$PATH
node_version="$(node -v 2>/dev/null || true)"
check "$([ -n "$node_version" ] && echo 1 || echo 0)" "node 可用" "$node_version"
npm_version="$(npm -v 2>/dev/null || true)"
check "$([ -n "$npm_version" ] && echo 1 || echo 0)" "npm 可用" "$npm_version"
pnpm_version="$(pnpm -v 2>/dev/null || true)"
check "$([ -n "$pnpm_version" ] && echo 1 || echo 0)" "pnpm 可用" "$pnpm_version"
dsh_version="$(dsh --version 2>/dev/null | head -1 || true)"
check "$([ -n "$dsh_version" ] && echo 1 || echo 0)" "dsh 可用" "$dsh_version"

echo
echo "2. 种子 DSH_HOME 与离线安装素材"
plugin_version="$(node -e 'try { process.stdout.write(require("/vendor/dsh-home/profiles/web/node_modules/@jaxzhou/dsh-file-explorer/package.json").version); } catch {}' || true)"
check "$([ -n "$plugin_version" ] && echo 1 || echo 0)" "profile 内已装 @jaxzhou/dsh-file-explorer" "$plugin_version"
bundles="$(node -e 'const m = require("/vendor/dsh-home/profiles/web/package.json"); process.stdout.write((m.dsh.profile.bundles || []).join(","));' || true)"
case "$bundles" in
  *@jaxzhou/dsh-file-explorer*) check 1 "插件已列入 bundles 层" "$bundles" ;;
  *) check 0 "插件已列入 bundles 层" "$bundles" ;;
esac
store_bytes="$(stat -c %s /vendor/pnpm-store.tgz 2>/dev/null || echo 0)"
check "$([ "${store_bytes:-0}" -gt 100000 ] && echo 1 || echo 0)" "pnpm store 已内置" "${store_bytes} bytes"
tarball="$(ls /vendor/plugins/*.tgz 2>/dev/null | head -1 || true)"
check "$([ -n "$tarball" ] && echo 1 || echo 0)" "插件 tarball 已内置" "$tarball"

echo
echo "3. 断网启动 dsh web（种子复制到可写目录）"
export DSH_HOME=/tmp/dsh-home
cp -a /vendor/dsh-home/. "$DSH_HOME"/
dsh web --no-open --port 0 >/tmp/dsh-web.log 2>&1 &
pid=$!
url=""
for _ in $(seq 1 60); do
  url="$(sed -n 's/.*dsh web: \(http[^ ]*\).*/\1/p' /tmp/dsh-web.log | head -1)"
  [ -n "$url" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
check "$([ -n "$url" ] && echo 1 || echo 0)" "打印了就绪地址" "$url"

if [ -n "$url" ]; then
  # The served page sits behind a token cookie: the first request answers with a
  # redirect that mints it, so a 2xx/3xx answer from the bundled node is the
  # signal that the Web UI is really being served.
  status=""
  for _ in $(seq 1 20); do
    status="$(node -e 'fetch(process.argv[1], { redirect: "manual" }).then((r) => process.stdout.write(String(r.status))).catch((e) => process.stdout.write("ERR:" + e.message));' "$url" 2>&1 || true)"
    case "$status" in
      200 | 301 | 302 | 303 | 307 | 308) break ;;
    esac
    sleep 1
  done
  case "$status" in
    200 | 301 | 302 | 303 | 307 | 308) check 1 "Web 服务可访问（HTTP $status）" ;;
    *) check 0 "Web 服务可访问" "$status" ;;
  esac
fi

kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

echo
echo "--- dsh web 日志（尾部）"
tail -6 /tmp/dsh-web.log | sed 's/^/    /'

echo
echo "4. 客户端离线模式（用 payload 的 node 运行应用自身的逻辑）"
cat > /tmp/offline-driver.mjs <<'DRIVER'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ShellController } = require('/repo/src/main/controller.js');
const { describeVendor, resolveVendorDir } = require('/repo/src/main/offline.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const vendorDir = resolveVendorDir({ env: { DSH_D_VENDOR_DIR: '/vendor' } });
const vendor = describeVendor({ vendorDir });
check('客户端发现离线 payload', vendor.available === true, String(vendorDir));
check('payload 版本清单可读', vendor.manifest?.dsh === '0.1.5-rc.3' && /dsh-file-explorer/.test(vendor.manifest?.plugin ?? ''), JSON.stringify(vendor.manifest));

const controller = new ShellController({
  cwd: '/tmp',
  offline: { enabled: true, vendor, homeDir: '/tmp/dsh-home', storeDir: '/tmp/pnpm-store', seeded: true },
});
// Any of these firing would mean the offline build tried to reach the network.
controller.runProvisionRuntime = async () => { throw new Error('离线模式不应下载 Node'); };
controller.ensurePnpm = async () => { throw new Error('离线模式不应安装 pnpm'); };
controller.runInstall = () => { throw new Error('离线模式不应安装 dsh'); };

await controller.check({ autostart: false });
const state = controller.getState();
check('检测到内置 dsh', state.detection.dsh.installed === true, `${state.detection.dsh.version} @ ${state.detection.dsh.command}`);
check('检测到内置 pnpm', state.detection.pnpm?.available === true, String(state.detection.pnpm?.version));
check('进入 ready-to-start（无需任何安装）', state.phase === 'ready-to-start', state.phase);
check('离线模式信息完整', state.offline?.enabled === true && state.offline.dsh === '0.1.5-rc.3', JSON.stringify({ dsh: state.offline?.dsh, plugin: state.offline?.plugin }));
check('DSH_HOME 指向展开的离线 home', controller.env.DSH_HOME === '/tmp/dsh-home', String(controller.env.DSH_HOME));
check('PATH 首位为 payload bin', String(controller.env.PATH).startsWith('/vendor/node/bin'), String(controller.env.PATH).split(':')[0]);

const installed = controller.getInstalledPlugins();
const plugin = installed.plugins.find((p) => p.package === '@jaxzhou/dsh-file-explorer');
check('内置插件已被识别为已安装', Boolean(plugin), installed.plugins.map((p) => `${p.package}@${p.version}`).join(', '));
check('插件版本正确', plugin?.version === '0.1.6', String(plugin?.version));

await controller.dispose();
const failed = results.filter((r) => !r.ok).length;
console.log(`  （客户端离线检查：${results.length - failed}/${results.length}）`);
if (failed > 0) process.exit(1);
DRIVER
if node /tmp/offline-driver.mjs; then
  check 1 "客户端离线流程（无网络）全部通过"
else
  check 0 "客户端离线流程（无网络）"
fi

echo
echo "通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ]
CONTAINER_SCRIPT
