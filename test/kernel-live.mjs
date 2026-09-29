#!/usr/bin/env node
/**
 * Live verification of the dsh core (内核) update mechanism.
 *
 * It performs the exact operation the shell performs — a version-pinned global
 * install through the machine's own npm — but into a temporary prefix, so the
 * dsh the user actually runs is never touched. Both installs are verified by
 * executing the resulting binary and reading its version, i.e. the same test the
 * shell's "切换版本" button performs, end to end.
 *
 * Run with: npm run test:kernel
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const { resolveShellEnv, runCapture } = require('../src/main/shell-env.js');
const { findExecutable } = require('../src/main/dsh-detect.js');
const kernel = require('../src/main/kernel.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const workDir = path.join(os.tmpdir(), `dsh-d-kernel-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

console.log('DSH-D dsh 内核安装验证（临时前缀，不影响本机全局安装）');

const resolved = await resolveShellEnv();
const npm = findExecutable('npm', resolved.env) ?? 'npm';
check('找到 npm', Boolean(npm), String(npm));
const env = { ...resolved.env, npm_config_prefix: workDir, npm_config_global_prefix: workDir, npm_config_cache: path.join(workDir, '.npm-cache') };

// Pick two real published versions to move between.
const catalogResult = await kernel.fetchKernelCatalog({});
check('获取官方版本目录', catalogResult.ok === true, catalogResult.ok ? `${catalogResult.catalog.versions.length} 个版本` : catalogResult.error);
if (!catalogResult.ok) process.exit(1);
const { catalog } = catalogResult;
const tags = catalog.distTags;
const target = tags.latest;
const other = catalog.versions.map((row) => row.version).find((version) => version !== target && row0(catalog, version)?.installable !== false && kernel.classifyVersion(version) === 'rc');
function row0(cat, version) {
  return cat.versions.find((row) => row.version === version);
}
check('选定两个可安装的 RC 版本', Boolean(target) && Boolean(other), `${target} / ${other}`);

async function installAndRead(version) {
  const args = kernel.buildKernelInstallArgs({ version });
  const started = Date.now();
  const result = await runCapture(npm, [...args], { env, cwd: workDir, timeoutMs: 20 * 60_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const done = result.code === 0;
  const binary = path.join(workDir, 'bin', 'dsh');
  if (!done) return { ok: false, version, error: `${(result.stderr ?? '').trim().split('\n').slice(-2).join(' / ')}`, seconds };
  if (!existsSync(binary)) return { ok: false, version, error: `未生成 ${binary}`, seconds };
  const probe = await runCapture(binary, ['--version'], { env, timeoutMs: 120_000 });
  const raw = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim().split('\n').filter(Boolean)[0] ?? '';
  const detected = (raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/) ?? [null])[0];
  return { ok: probe.code === 0, version, detected, raw, seconds };
}

const first = await installAndRead(target);
check(`安装 ${target}（npm install -g @deepseek-ai/dsh@${target}）`, first.ok, first.ok ? `${first.seconds}s` : first.error);
check('安装后的二进制报告目标版本', first.detected === target, `${first.detected} ← ${first.raw}`);

const second = await installAndRead(other);
check(`切换到 ${other}`, second.ok, second.ok ? `${second.seconds}s` : second.error);
check('切换后版本确实变化', second.detected === other && second.detected !== first.detected, `${first.detected} → ${second.detected}`);

if (first.ok && first.detected) {
  const view = kernel.kernelRows({ installed: first.detected, catalog });
  console.log(`    · 若本机 dsh 为 ${first.detected}：${view.recommendation.reason}`);
  check('目录推荐逻辑与本机实际版本一致', view.rows.some((row) => row.version === first.detected), view.recommendation.status);
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
rmSync(workDir, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
