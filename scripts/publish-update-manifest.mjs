#!/usr/bin/env node
/**
 * Build the shell's release manifest (`latest.json`).
 *
 * The desktop shell checks this file to discover its own updates. It is written
 * next to the artifacts it describes, so the two are always published together:
 *
 *   node scripts/publish-update-manifest.mjs --version 0.1.8 --notes "…"
 *
 * Every entry carries a SHA-256 and byte size, which the shell verifies after
 * downloading. Missing files are skipped with a warning, so a partial build
 * still produces a manifest that only advertises what actually exists.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ORIGIN = process.env.DSH_D_SITE_ORIGIN || 'https://dsh.textwork.cn';

/** platform/arch/kind → artifact name for a version. */
function assetPlan(v) {
  return [
    { platform: 'win32', arch: 'x64', kind: 'nsis', file: `DSH-D-Setup-${v}.exe`, dir: 'release' },
    { platform: 'win32', arch: 'x64', kind: 'zip', file: `DSH-D-${v}-win.zip`, dir: 'release' },
    { platform: 'darwin', arch: 'x64', kind: 'zip', file: `DSH-D-${v}-mac.zip`, dir: 'release' },
    { platform: 'linux', arch: 'x64', kind: 'appimage', file: `DSH-D-${v}.AppImage`, dir: 'release' },
    { platform: 'linux', arch: 'x64', kind: 'deb', file: `dsh-d_${v}_amd64.deb`, dir: 'release' },
    { platform: 'linux', arch: 'x64', kind: 'tarball', file: `dsh-d-${v}.tar.gz`, dir: 'release' },
    {
      platform: 'linux-offline',
      arch: 'x64',
      kind: 'appimage',
      file: `DSH-D-Offline-${v}-linux-x64.AppImage`,
      dir: 'release-offline',
    },
    {
      platform: 'linux-offline',
      arch: 'x64',
      kind: 'tarball',
      file: `DSH-D-Offline-${v}-linux-x64.tar.gz`,
      dir: 'release-offline',
    },
  ];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || process.cwd());
const version = String(args.version || '').trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('用法：node scripts/publish-update-manifest.mjs --version 0.1.8 [--notes "说明"] [--out latest.json]');
  process.exit(2);
}

let notes = '';
if (typeof args.notes === 'string') notes = args.notes;
else if (typeof args['notes-file'] === 'string') notes = readFileSync(path.resolve(root, args['notes-file']), 'utf8');

const assets = [];
const missing = [];
for (const entry of assetPlan(version)) {
  const file = path.join(root, entry.dir, entry.file);
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size === 0) throw new Error('不是有效文件');
    assets.push({
      platform: entry.platform,
      arch: entry.arch,
      kind: entry.kind,
      file: entry.file,
      url: `${ORIGIN}/download/${entry.file}`,
      sha256: sha256(file),
      size: info.size,
    });
  } catch {
    missing.push(`${entry.dir}/${entry.file}`);
  }
}

if (!assets.length) {
  console.error(`没有找到 ${version} 的任何产物，先执行构建（npm run dist / dist:linux / build-offline-linux.sh）`);
  process.exit(1);
}

const manifest = {
  schema: 1,
  version,
  releasedAt: args['released-at'] || new Date().toISOString(),
  site: ORIGIN,
  notes: notes.trim(),
  assets,
};

const outFile = path.resolve(root, typeof args.out === 'string' ? args.out : 'latest.json');
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`已写入 ${path.relative(root, outFile)}：${manifest.version}`);
for (const asset of assets) {
  console.log(`  ${asset.platform.padEnd(14)} ${asset.kind.padEnd(9)} ${String(asset.size).padStart(12)}  ${asset.sha256.slice(0, 16)}…  ${asset.file}`);
}
if (missing.length) {
  console.log(`跳过 ${missing.length} 个缺失产物：${missing.join('、')}`);
}
console.log(`\n上传：rsync -av ${path.relative(root, outFile)} root@117.72.118.5:/opt/dsh/downloads/`);
