#!/usr/bin/env node
/**
 * Network-dependent verification for the Node.js runtime bootstrap.
 *
 * `npm test` stays offline and fast; this script does the real thing:
 * downloads the current Node.js LTS into a throwaway directory and checks the
 * two properties the whole feature rests on —
 *
 *   1. the runtime is usable (node/npm run), and
 *   2. its npm global prefix is inside the managed directory, so
 *      `npm install -g @deepseek-ai/dsh` needs no administrator rights and
 *      never touches a system Node.
 *
 * Run with: npm run test:network
 */

import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const {
  FALLBACK_NODE_VERSION,
  fetchText,
  installNodeRuntime,
  managedNpmCommand,
  managedRuntimeEnv,
} = require('../src/main/node-runtime.js');
const market = require('../src/main/plugin-market.js');
const { findExecutable } = require('../src/main/dsh-detect.js');
const { shellCommandFor } = require('../src/main/shell-env.js');
const { runCapture } = require('../src/main/shell-env.js');

const RUNTIME_ROOT = path.join(here, '.network-runtime');

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run a command in the managed runtime's environment. */
function runInRuntime(runtime, command, args, options = {}) {
  // The same environment the app builds: managed bin first, prefix and cache pinned.
  const env = managedRuntimeEnv(process.env, runtime, {
    cacheDir: path.join(RUNTIME_ROOT, '.npm-cache'),
  });
  return runCapture(command, args, { env, timeoutMs: options.timeoutMs ?? 300_000 });
}

console.log('D S H - D  ·  运行时自动配置 · 实网验证');
console.log(`运行时目录：${RUNTIME_ROOT}\n`);

console.log('1. 下载并配置 Node.js LTS');
const runtime = await installNodeRuntime({
  root: RUNTIME_ROOT,
  onLog: (entry) => {
    if (entry.stream !== 'stdout') console.log(`    ${entry.line}`);
  },
  onProgress: (snapshot) => {
    if (snapshot.percent % 20 < 2) console.log(`    [${String(snapshot.percent).padStart(3)}%] ${snapshot.phase} ${snapshot.detail}`);
  },
});

if (!runtime.ok) {
  console.error(`\n下载失败：${runtime.error}`);
  process.exitCode = 1;
} else {
  console.log(`\n    ${runtime.dir}\n`);
  check('运行时下载并解压成功', true);
  check('版本为最新 LTS（或回退版本）', /^v\d+\.\d+\.\d+$/.test(runtime.version), runtime.version);
  check('node 可执行', existsSync(runtime.nodePath));
  check('npm 可执行', existsSync(runtime.npmPath));

  console.log('\n2. 运行时自检');
  const nodeVersion = await runInRuntime(runtime, runtime.nodePath, ['--version']);
  check('node --version 可用', nodeVersion.ok, nodeVersion.stdout.trim());
  const npmVersion = await runInRuntime(runtime, managedNpmCommand(runtime), ['--version']);
  check('npm --version 可用', npmVersion.ok, npmVersion.stdout.trim());

  console.log('\n3. 全局安装目录必须落在托管目录内（无需管理员权限的关键）');
  const prefix = await runInRuntime(runtime, managedNpmCommand(runtime), ['prefix', '-g']);
  const npmRoot = await runInRuntime(runtime, managedNpmCommand(runtime), ['root', '-g']);
  const prefixPath = prefix.stdout.trim();
  const rootPath = npmRoot.stdout.trim();
  console.log(`    prefix -g: ${prefixPath}`);
  console.log(`    root   -g: ${rootPath}`);
  check('npm 全局 prefix 位于托管目录内', prefixPath.startsWith(runtime.dir), `${prefixPath} vs ${runtime.dir}`);
  check('npm 全局 node_modules 位于托管目录内', rootPath.startsWith(runtime.dir), rootPath);

  console.log('\n4. 真实执行一次 dsh 的全局安装（可写、无需 sudo）');
  const install = await runInRuntime(runtime, managedNpmCommand(runtime), [
    'install',
    '-g',
    '@deepseek-ai/dsh',
    '--no-fund',
    '--no-audit',
    '--loglevel=error',
  ]);
  check('npm install -g @deepseek-ai/dsh 成功', install.ok, install.stderr.trim().slice(0, 300) || `exit ${install.code}`);

  const dshCommand = path.join(runtime.binDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  check('dsh 可执行文件落在托管目录内', existsSync(dshCommand), dshCommand);
  if (existsSync(dshCommand)) {
    const dshVersion = await runInRuntime(runtime, dshCommand, ['--version']);
    check('托管目录内的 dsh 可运行', dshVersion.ok, dshVersion.stdout.trim());
  }

  console.log('\n5. 清理');
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  check('测试目录已清理', !existsSync(RUNTIME_ROOT));
}

// ---------------------------------------------------------------- 插件市场

console.log('\n6. 插件市场目录（客户端读取 dsh.textwork.cn）');
const liveMarket = await market.fetchCatalog({});
check('默认目录地址指向 dsh.textwork.cn 的 plugins.json', market.DEFAULT_MARKET_URL === 'https://dsh.textwork.cn/plugins/plugins.json', market.DEFAULT_MARKET_URL);
check('目录可下载并解析', liveMarket.ok === true, liveMarket.ok ? '' : liveMarket.error);
if (liveMarket.ok) {
  const { catalog } = liveMarket;
  console.log(`    条数：${catalog.plugins.length} · 更新于：${catalog.updatedAt}`);
  check('目录含至少一个插件', catalog.plugins.length > 0, String(catalog.plugins.length));
  check(
    '每个条目都有合法包名与版本',
    catalog.plugins.every((plugin) => market.isSafePackageName(plugin.package) && market.isSafeVersion(plugin.version)),
    catalog.plugins.map((plugin) => `${plugin.package}@${plugin.version}`).join(', '),
  );
  console.log(`    自身 ${catalog.groups['first-party'].length} 个 / 社区 ${catalog.groups.community.length} 个`);
  check('目录包含自身与社区两组', catalog.groups['first-party'].length > 0 && catalog.groups.community.length > 0, JSON.stringify(market.marketRows(catalog, { plugins: [] }).groupCounts));
  check('社区段带来源与统计口径', Boolean(catalog.community?.metric), JSON.stringify(catalog.community ?? null));

  // Drift check: the catalog is published by the site tooling, so a plugin that
  // moved on npm would leave the market offering an outdated version.
  // The host npm is enough for a read-only `npm view`, and stays valid after
  // the managed runtime has been cleaned up.
  const hostNpm = findExecutable('npm', process.env) ?? 'npm';
  const drifted = [];
  for (const plugin of catalog.plugins) {
    const latest = await runCapture(shellCommandFor(hostNpm), ['view', plugin.package, 'version'], {
      env: process.env,
      timeoutMs: 60_000,
    });
    const version = latest.stdout.trim();
    if (latest.ok && version && version !== plugin.version) {
      drifted.push(`${plugin.package}: 目录 ${plugin.version} / npm ${version}`);
    } else {
      console.log(`    ${plugin.package}@${plugin.version} 与 npm 一致`);
    }
  }
  if (drifted.length) {
    console.log(`    ⚠ 目录版本落后于 npm（需要更新目录）：${drifted.join('；')}`);
  } else {
    console.log('    ✓ 目录版本与 npm 最新一致');
  }

  // The human page must list what the machine catalog offers.
  try {
    const page = await fetchText('https://dsh.textwork.cn/plugins/', { timeoutMs: 30_000 });
    const missing = catalog.plugins.filter((plugin) => !page.includes(plugin.package)).map((plugin) => plugin.package);
    check('站点插件页与目录条目一致', missing.length === 0, missing.length ? `页面缺少：${missing.join(', ')}` : '');
  } catch (error) {
    console.log(`    （跳过插件页一致性检查：${error instanceof Error ? error.message : String(error)}）`);
  }
}

console.log(`\n${'─'.repeat(58)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`（回退版本常量：${FALLBACK_NODE_VERSION}，仅在版本索引不可达时使用）`);
if (failed > 0) process.exitCode = 1;
