#!/usr/bin/env node
/**
 * `npm run dist:linux` — build the Linux targets (AppImage, deb, tar.gz).
 *
 * Extra arguments are forwarded to electron-builder, e.g.
 *
 *     npm run dist:linux -- --arm64
 *
 * Why a wrapper at all: electron-builder builds the `deb` with fpm, and fpm
 * archives with GNU tar options (`--owner=0 --group=0`). macOS ships bsdtar,
 * which rejects them, so the deb fails unless GNU tar is installed. When no
 * GNU tar is found on a macOS host this script puts `scripts/gtar-shim` (a
 * small translator, see its header) at the front of PATH for the build.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shimDir = path.join(root, 'scripts', 'gtar-shim');

/** Run a command and return its stdout, or '' when it cannot run. */
function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout ?? '') : '';
}

/** True when some tar on this host understands GNU-only options. */
function hasGnuTar() {
  return /GNU tar/.test(output('gtar', ['--version'])) || /GNU tar/.test(output('tar', ['--version']));
}

const env = { ...process.env };
const notes = [];

if (process.platform === 'darwin' && !hasGnuTar()) {
  if (!existsSync(path.join(shimDir, 'gtar'))) {
    console.error(`找不到 GNU tar，且缺少垫片：${path.join(shimDir, 'gtar')}`);
    process.exit(1);
  }
  env.PATH = `${shimDir}${path.delimiter}${env.PATH ?? ''}`;
  notes.push('未检测到 GNU tar，已启用 scripts/gtar-shim 以完成 deb 打包（仅影响打包，不影响产物）');
}

if (!env.ELECTRON_MIRROR) {
  notes.push('提示：若无法访问 GitHub，可设置 ELECTRON_MIRROR 与 ELECTRON_BUILDER_BINARIES_MIRROR');
}

for (const note of notes) console.log(`[dist:linux] ${note}`);

const builder = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
if (!existsSync(builder)) {
  console.error('未找到 electron-builder，请先执行 npm install');
  process.exit(1);
}

const result = spawnSync(builder, ['--linux', ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
