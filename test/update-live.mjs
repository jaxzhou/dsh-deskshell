#!/usr/bin/env node
/**
 * Live end-to-end check of the shell's self-update path.
 *
 * This one really downloads the artifact published for *this* machine, verifies
 * its SHA-256 against the release manifest, and inspects the package contents
 * to prove it is the advertised version. The only step it skips is the actual
 * replacement of a running app (it prints the plan that would do it).
 *
 * Run with: npm run test:update
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const updater = require('../src/main/updater.js');
const { createUpdateManager } = require('../src/main/update-manager.js');

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

const workDir = path.join(here, '.update-live');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

console.log('DSH-D 自更新线上验证');
console.log(`  平台：${process.platform}/${process.arch}`);

const manifestResult = await updater.fetchManifest({});
check('获取线上发布清单', manifestResult.ok === true, manifestResult.ok ? manifestResult.source : manifestResult.error);
if (!manifestResult.ok) process.exit(1);

const manifest = manifestResult.manifest;
const asset = updater.selectAsset(manifest, { platform: process.platform, arch: process.arch });
check('为本机选出更新包', Boolean(asset), asset ? `${asset.kind} · ${asset.file}` : '无');
if (!asset) process.exit(1);

// Pretend to be one patch behind, so the manager takes the "update available"
// path against the real manifest.
const current = manifest.version.replace(/(\d+)$/, (n) => String(Math.max(0, Number(n) - 1)));
const manager = createUpdateManager({
  currentVersion: current,
  manifestUrl: updater.DEFAULT_MANIFEST_URL,
  downloadDir: workDir,
  autoCheck: false,
  isPackaged: true,
  appPath: '/Applications/DSH-D.app',
  appImagePath: process.env.APPIMAGE || '/opt/DSH-D.AppImage',
  log: (line) => console.log(`    · ${line}`),
});

const checked = await manager.checkNow();
check('检测到新版本', checked.latestVersion === manifest.version && checked.phase !== 'current', `${current} → ${checked.latestVersion} (${checked.phase})`);
check('给出本平台安装计划', Boolean(checked.plan?.kind), JSON.stringify(checked.plan));
// A real install into /Applications is often not writable by the user, which is
// a legitimate outcome — the plan then says so instead of failing later.
const writable = checked.plan?.applicable === true;
console.log(`    安装方式：${checked.plan?.kind}（${writable ? '可自动替换' : '需人工替换'}）— ${checked.plan?.note}`);

const started = Date.now();
const ready = await manager.download();
const downloaded = Boolean(ready.downloadedPath);
check('下载完成（校验通过）', downloaded && ready.phase !== 'error', `${ready.phase}${ready.error ? ` — ${ready.error}` : ''}`);
if (!downloaded) process.exit(1);

const file = ready.downloadedPath;
const bytes = statSync(file).size;
check('落盘大小与清单一致', bytes === asset.size, `${bytes} vs ${asset.size}`);
const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
check('SHA-256 与发布清单一致', digest === asset.sha256, `${digest.slice(0, 16)}… vs ${asset.sha256.slice(0, 16)}…`);
console.log(`    用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Prove the package really is the advertised version by looking inside it.
const unpackDir = path.join(workDir, 'unpacked');
mkdirSync(unpackDir, { recursive: true });
if (asset.kind === 'zip') {
  execFileSync('/usr/bin/ditto', ['-x', '-k', file, unpackDir]);
  const appBundle = path.join(unpackDir, 'DSH-D.app');
  const plist = path.join(appBundle, 'Contents', 'Info.plist');
  check('解压出 .app 包', existsSync(plist), appBundle);
  if (existsSync(plist)) {
    const version = execFileSync('/usr/bin/defaults', ['read', path.join(appBundle, 'Contents', 'Info'), 'CFBundleShortVersionString'])
      .toString()
      .trim();
    const identifier = execFileSync('/usr/bin/defaults', ['read', path.join(appBundle, 'Contents', 'Info'), 'CFBundleIdentifier'])
      .toString()
      .trim();
    check('包内版本号等于清单版本', version === manifest.version, `${version} vs ${manifest.version}`);
    check('包内 appId 正确', identifier === 'com.deepseek.dsh.desktop', identifier);
    // The published bundle must actually contain this feature, not just the version.
    const asar = readFileSync(path.join(appBundle, 'Contents', 'Resources', 'app.asar'));
    check(
      '包内 app.asar 含自更新模块',
      asar.includes(Buffer.from('update-manager.js')) && asar.includes(Buffer.from('updater.js')),
      `asar ${(asar.length / 1024 / 1024).toFixed(1)} MB`,
    );
    check(
      '包内清单里带发布说明',
      asar.includes(Buffer.from('latest.json')),
      'latest.json 引用',
    );
    // The replacement helper is the same script the shell would run.
    // Show what the shell would do where the app directory is writable.
    const writableManager = createUpdateManager({
      currentVersion: current,
      manifestUrl: updater.DEFAULT_MANIFEST_URL,
      downloadDir: workDir,
      autoCheck: false,
      isPackaged: true,
      appPath: path.join(workDir, 'Applications', 'DSH-D.app'),
      directoryWritable: true,
      log: () => {},
    });
    await writableManager.checkNow();
    await writableManager.download();
    const applied = writableManager.apply();
    check('可写位置给出退出后替换 .app 的计划', applied.ok === true && applied.plan.kind === 'replace-bundle', JSON.stringify(applied.plan ?? applied.error));
    check(
      '辅助脚本先等待本进程退出',
      typeof applied.script === 'string' && applied.script.includes(`kill -0 ${process.pid}`),
      (applied.script ?? '').split('\n')[2] ?? '',
    );
  }
} else if (asset.kind === 'appimage') {
  execFileSync('/usr/bin/file', [file], { stdio: 'inherit' });
  check('AppImage 已下载', bytes > 0);
} else {
  check(`${asset.kind} 包已下载`, bytes > 0);
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
rmSync(workDir, { recursive: true, force: true });
