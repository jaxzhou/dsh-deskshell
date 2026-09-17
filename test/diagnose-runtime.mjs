#!/usr/bin/env node
/**
 * Diagnose the Node.js runtime bootstrap on a machine where it misbehaves.
 *
 * It reproduces a machine without a usable Node.js — clean HOME, minimal PATH,
 * a shell that does not load nvm — then runs the real controller flow and
 * prints every detection result, the environment handed to the managed npm, and
 * each individual npm command with its exit code and output.
 *
 * Usage:
 *   npm run diagnose                 # temp dirs, cleaned up at the end
 *   npm run diagnose -- --keep       # keep them for inspection
 *   npm run diagnose -- --root DIR   # reuse a specific runtime root
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const {
  installNodeRuntime,
  managedRuntimeEnv,
  managedNpmCommand,
  findManagedRuntime,
  runtimePaths,
} = require('../src/main/node-runtime.js');
const { detectDsh } = require('../src/main/dsh-detect.js');
const { resolveShellEnv, runCapture } = require('../src/main/shell-env.js');
const { ShellController } = require('../src/main/controller.js');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const rootFlag = argv.indexOf('--root');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

/** Set in the re-executed child; the parent only prepares the bare machine. */
const IS_CHILD = process.env.DSH_D_DIAGNOSE_CHILD === '1';

const workDir = rootFlag >= 0 && argv[rootFlag + 1]
  ? path.resolve(argv[rootFlag + 1])
  : path.join(os.tmpdir(), `dsh-d-diagnose-${stamp}`);
const fakeHome = path.join(workDir, 'home');
const runtimeRoot = path.join(workDir, 'runtime');

/** An environment that looks like a machine with no Node.js at all. */
function bareEnvironment() {
  const env = {
    PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin',
    HOME: fakeHome,
    SHELL: '/bin/sh',
    DSH_D_DIAGNOSE_CHILD: '1',
    DSH_D_DIAGNOSE_DIR: workDir,
    // Keep mirror/proxy settings so the download behaves like on the real host.
    ...(process.env.DSH_D_NODE_MIRROR ? { DSH_D_NODE_MIRROR: process.env.DSH_D_NODE_MIRROR } : {}),
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
  };
  return env;
}

// The controller resolves the login environment itself, so the only faithful
// way to reproduce a node-less machine is to re-run this script with a bare
// environment — then it cannot find the host's node/npm either.
if (!IS_CHILD) {
  mkdirSync(fakeHome, { recursive: true });
  console.log('DSH-D 运行时配置诊断（以“无 Node 环境”重新执行子进程）');
  console.log(`工作目录：${workDir}`);
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
    env: bareEnvironment(),
    stdio: 'inherit',
  });
  if (!keep) rmSync(workDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

function heading(text) {
  console.log(`\n${'='.repeat(68)}\n${text}\n${'='.repeat(68)}`);
}

function show(value) {
  console.log(JSON.stringify(value, null, 2));
}

console.log('DSH-D 运行时配置诊断');
console.log(`平台：${process.platform} / ${process.arch}`);
console.log(`Node（诊断进程）：${process.version}`);
console.log(`工作目录：${workDir}`);
console.log(`EUID：${typeof process.geteuid === 'function' ? process.geteuid() : 'n/a'}`);

mkdirSync(fakeHome, { recursive: true });
if (process.env.DSH_D_DIAGNOSE_DIR) process.chdir(process.env.DSH_D_DIAGNOSE_DIR);

// ---------------------------------------------------------------- 1. 检测

heading('1. 模拟“没有可用 Node”的机器环境');
const resolved = await resolveShellEnv({ home: fakeHome, baseEnv: process.env });
console.log('模拟环境的 PATH：', resolved.env.PATH);
console.log('环境来源：', resolved.notes.join('；'));

const before = await detectDsh(resolved.env);
console.log('\n配置前检测：');
show({
  node: { available: before.node.available, version: before.node.version, command: before.node.command, error: before.node.error },
  npm: { available: before.npm.available, version: before.npm.version, command: before.npm.command, error: before.npm.error },
  dsh: { installed: before.dsh.installed, error: before.dsh.error },
});

// ------------------------------------------------------- 2. 控制器完整流程

heading('2. 控制器流程（真实下载 + 真实检测）');
const controller = new ShellController({
  cwd: workDir,
  runtimeRoot,
  startDelayMs: 10,
});
const transitions = [];
controller.on('state', (state) => {
  if (transitions.at(-1)?.phase !== state.phase) {
    transitions.push({ phase: state.phase, statusText: state.statusText });
  }
});
controller.on('log', (entry) => {
  if (entry.stream !== 'stdout') console.log(`    [${entry.stream}] ${entry.line}`);
});

await controller.check({ autostart: false });
const state = controller.getState();

console.log('\n阶段变化：');
for (const item of transitions) console.log(`  ${item.phase}  — ${item.statusText}`);
console.log('\n最终阶段：', state.phase);
if (state.error) console.log('错误：', JSON.stringify(state.error, null, 2));
console.log('\n运行时信息：');
show(state.runtime ?? null);
console.log('\n配置后检测：');
show({
  node: state.detection?.node,
  npm: state.detection?.npm,
  dsh: state.detection?.dsh,
});

// ----------------------------------------- 3. 托管运行时与 npm 的逐项检查

heading('3. 托管运行时逐项检查');
const managed = controller.managedRuntime ?? findManagedRuntime(runtimeRoot);
if (!managed) {
  console.log('没有找到托管运行时（这本身就是一个问题）');
} else {
  const paths = runtimePaths(managed.dir);
  console.log('托管目录：', managed.dir);
  console.log('  binDir ：', managed.binDir);
  console.log('  结构化检查：');
  for (const [name, file] of [['node', paths.nodePath], ['npm', paths.npmPath]]) {
    const present = existsSync(file);
    console.log(`    ${name}: ${file} exists=${present}`);
  }

  const managedEnv = managedRuntimeEnv({ ...resolved.env }, managed, {
    cacheDir: path.join(runtimeRoot, '.npm-cache'),
  });
  console.log('\n交给托管 npm 的环境变量：');
  console.log('  PATH                =', managedEnv.PATH);
  console.log('  npm_config_prefix   =', managedEnv.npm_config_prefix);
  console.log('  npm_config_global_prefix =', managedEnv.npm_config_global_prefix);
  console.log('  npm_config_cache    =', managedEnv.npm_config_cache);
  console.log('  继承的 npm_config_* :', Object.keys(managedEnv).filter((key) => /^npm_config/i.test(key)).join(', ') || '(无)');

  const checks = [
    ['node --version', paths.nodePath, ['--version']],
    ['npm --version', managedNpmCommand(managed), ['--version']],
    ['npm prefix -g', managedNpmCommand(managed), ['prefix', '-g']],
    ['npm root -g', managedNpmCommand(managed), ['root', '-g']],
  ];
  console.log('\n逐条执行：');
  for (const [label, command, args] of checks) {
    const result = await runCapture(command, args, { env: managedEnv, timeoutMs: 120_000 });
    const out = result.stdout.trim() || result.stderr.trim();
    console.log(`  ${result.ok ? '✓' : '✗'} ${label}`);
    console.log(`      cmd : ${command} ${args.join(' ')}`);
    console.log(`      code: ${result.code}${result.error ? `  错误: ${result.error}` : ''}`);
    console.log(`      输出: ${out.slice(0, 400).replace(/\n/g, '\n            ')}`);
  }

  // 同一批命令在“原始环境 + 仅 PATH 前缀”下再跑一次，用于对比
  console.log('\n对照：不使用 prefix/cache 覆盖，仅前置 PATH');
  const plainEnv = { ...resolved.env, PATH: `${managed.binDir}${path.delimiter}${resolved.env.PATH}` };
  for (const [label, command, args] of [['npm --version', managedNpmCommand(managed), ['--version']]]) {
    const result = await runCapture(command, args, { env: plainEnv, timeoutMs: 120_000 });
    console.log(`  ${result.ok ? '✓' : '✗'} ${label} → code=${result.code} out=${(result.stdout.trim() || result.stderr.trim()).slice(0, 200)}`);
  }
}

await controller.dispose();

heading('结束');
console.log(`诊断目录：${workDir}（${keep ? '已保留' : '父进程结束后清理'}）`);
