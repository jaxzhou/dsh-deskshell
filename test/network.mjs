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
  installNodeRuntime,
  managedNpmCommand,
  managedRuntimeEnv,
} = require('../src/main/node-runtime.js');
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

console.log(`\n${'─'.repeat(58)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`（回退版本常量：${FALLBACK_NODE_VERSION}，仅在版本索引不可达时使用）`);
if (failed > 0) process.exitCode = 1;
