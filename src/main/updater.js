'use strict';

/**
 * Self-update for the desktop shell.
 *
 * The shell publishes the same artifacts it always does, plus one release
 * manifest (`latest.json`) that names the newest version and each platform's
 * file with its SHA-256. This module turns that manifest into a decision:
 *
 *   check   → is the manifest newer than what is running?
 *   select  → which asset belongs to this platform/arch?
 *   verify  → does the downloaded file hash to the published digest?
 *   plan    → how is it applied here (installer, bundle swap, AppImage swap,
 *             or "hand it to the user")?
 *
 * Planning is deliberately separated from doing: the plan is a plain object, so
 * every platform's decision can be tested without touching the running app.
 * Applying happens in the main process, and the shell always exits *before* the
 * replacement so nothing rewrites files that are in use.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fetchText } = require('./node-runtime');
const { compareVersions } = require('./plugin-market');

/** Where the shell looks for updates (published beside the downloads). */
const DEFAULT_MANIFEST_URL = 'https://dsh.textwork.cn/download/latest.json';

const MANIFEST_TIMEOUT_MS = 20_000;
/** Categories we know how to apply, per platform. */
const APPLY_KINDS = ['nsis', 'zip', 'appimage', 'deb', 'tarball'];

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/** Compare a candidate version against the running one. */
function isNewer(candidate, current) {
  if (!candidate || !current) return false;
  return compareVersions(String(candidate), String(current)) > 0;
}

/** True when the value is a version string we are willing to reason about. */
function isVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim());
}

/** Normalize one manifest asset, dropping anything incomplete or unsafe. */
function normalizeAsset(raw, context) {
  if (!raw || typeof raw !== 'object') return null;
  const platform = String(raw.platform ?? '').trim();
  const arch = String(raw.arch ?? '').trim() || 'x64';
  const kind = String(raw.kind ?? '').trim().toLowerCase();
  const file = String(raw.file ?? '').trim();
  const sha256 = String(raw.sha256 ?? '').trim().toLowerCase();
  const size = Number(raw.size);
  const rawUrl = String(raw.url ?? '').trim();

  if (!platform || !APPLY_KINDS.includes(kind)) return null;
  if (!file || !SHA256_PATTERN.test(sha256)) return null;
  if (!Number.isFinite(size) || size <= 0) return null;

  let url = rawUrl;
  if (!url) url = `${context.origin.replace(/\/+$/, '')}/download/${file}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Updates are only ever fetched over https (or http on a loopback host).
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;

  return {
    platform,
    arch,
    kind,
    file,
    url: parsed.href,
    sha256,
    size,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 500) : '',
  };
}

/**
 * Parse and validate a release manifest.
 *
 * @param {string} text raw JSON body.
 * @param {{origin?: string}} [options]
 * @returns {{schema: number, version: string, releasedAt: string, notes: string, minimumVersion: string|null, assets: object[]}}
 * @throws {Error} when the payload is not a usable manifest.
 */
function parseManifest(text, options = {}) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`发布清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('发布清单结构无效');
  const version = String(payload.version ?? '').trim();
  if (!isVersion(version)) throw new Error(`发布清单版本号无效：${version || '(空)'}`);
  const list = Array.isArray(payload.assets) ? payload.assets : [];
  if (!list.length) throw new Error('发布清单缺少 assets');

  const context = { origin: options.origin ?? (String(payload.site ?? '').trim() || 'https://dsh.textwork.cn') };
  const assets = list.map((entry) => normalizeAsset(entry, context)).filter(Boolean);
  if (!assets.length) throw new Error('发布清单中的 assets 均无效（需要 platform/kind/file/sha256/size）');

  return {
    schema: Number(payload.schema ?? 1) || 1,
    version,
    releasedAt: typeof payload.releasedAt === 'string' ? payload.releasedAt.slice(0, 40) : '',
    notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 4000) : '',
    minimumVersion: isVersion(payload.minimumVersion) ? String(payload.minimumVersion) : null,
    assets,
  };
}

/** Preference order per platform: the kind the shell can apply on its own first. */
const KIND_PREFERENCE = {
  win32: ['nsis', 'zip'],
  darwin: ['zip'],
  linux: ['appimage', 'deb', 'tarball'],
};

/**
 * Pick the asset for this machine.
 *
 * @param {object} manifest parsed manifest.
 * @param {{platform?: string, arch?: string, variant?: string|null}} [options]
 *   `variant` selects a build flavour such as `offline` (asset platform
 *   `linux-offline`), falling back to the plain platform when it is absent.
 * @returns {object|null} the chosen asset, or null when this machine has none.
 */
function selectAsset(manifest, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const variant = options.variant ? String(options.variant) : null;
  const preference = KIND_PREFERENCE[platform] ?? [];
  const all = manifest?.assets ?? [];
  // Prefer the current architecture, but accept an arch-agnostic entry.
  const matches = (assets) => assets.filter((asset) => asset.arch === arch || asset.arch === 'any');
  const pools = [];
  if (variant) pools.push(matches(all.filter((asset) => asset.platform === `${platform}-${variant}`)));
  pools.push(matches(all.filter((asset) => asset.platform === platform)));
  for (const pool of pools) {
    for (const kind of preference) {
      const hit = pool.find((asset) => asset.kind === kind);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Decide how an update would be applied on this machine.
 *
 * @param {{
 *   platform?: string, asset: object|null, appPath?: string, appImagePath?: string|null,
 *   isPackaged?: boolean, directoryWritable?: boolean, pid?: number,
 * }} options
 * @returns {{kind: string, applicable: boolean, note: string, command?: string, args?: string[], script?: string, target?: string}}
 */
function planUpdate(options) {
  const platform = options.platform ?? process.platform;
  const asset = options.asset;
  if (!asset) {
    return { kind: 'none', applicable: false, note: '该平台没有可用的更新包' };
  }
  if (!options.isPackaged) {
    return { kind: 'manual', applicable: false, note: '开发模式下不自动替换，请手动更新检出目录' };
  }

  if (platform === 'win32' && asset.kind === 'nsis') {
    return {
      kind: 'run-installer',
      applicable: true,
      note: '安装程序会静默替换应用并重新启动（/S --force-run）',
      command: asset.file,
      args: ['/S', '--force-run'],
    };
  }

  if (platform === 'darwin' && asset.kind === 'zip') {
    if (options.directoryWritable === false) {
      return {
        kind: 'manual',
        applicable: false,
        note: '应用所在目录不可写，请手动解压替换（把 .app 拖到应用程序目录）',
      };
    }
    return {
      kind: 'replace-bundle',
      applicable: true,
      note: '退出后由辅助脚本解压并替换 .app，然后重新启动',
      target: options.appPath ?? null,
      script: 'darwin-replace-bundle',
    };
  }

  if (platform === 'linux' && asset.kind === 'appimage') {
    const appImage = options.appImagePath ?? null;
    if (!appImage) {
      return {
        kind: 'manual',
        applicable: false,
        note: '当前不是 AppImage 运行方式，请手动安装下载的包',
      };
    }
    if (options.directoryWritable === false) {
      return { kind: 'manual', applicable: false, note: `AppImage 位置不可写：${appImage}` };
    }
    return {
      kind: 'replace-appimage',
      applicable: true,
      note: '退出后用新文件替换 AppImage 并重新启动',
      target: appImage,
      script: 'linux-replace-appimage',
    };
  }

  return {
    kind: 'manual',
    applicable: false,
    note: `请手动安装下载的包（${asset.file}）`,
    target: asset.file,
  };
}

/** Hash a file and compare it with the published digest. */
function verifySha256(file, expected) {
  try {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return { ok: actual === String(expected).toLowerCase(), actual };
  } catch (error) {
    return { ok: false, actual: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetch the release manifest. */
async function fetchManifest(options = {}) {
  const origin = String(options.origin ?? DEFAULT_MANIFEST_URL).replace(/\/latest\.json$/, '');
  const url = options.url ?? DEFAULT_MANIFEST_URL;
  try {
    const text = await fetchText(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      timeoutMs: options.timeoutMs ?? MANIFEST_TIMEOUT_MS,
      signal: options.signal,
    });
    return { ok: true, source: url, manifest: parseManifest(text, { origin }) };
  } catch (error) {
    return { ok: false, source: url, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Write the apply helper that runs *after* the shell exits. */
function helperScriptFor(plan, context) {
  const { newFile, target, pid, relaunch } = context;
  if (plan.kind === 'replace-appimage') {
    return [
      '#!/bin/sh',
      '# Wait for the shell to exit, swap the AppImage, relaunch.',
      'set -e',
      `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
      `mv -f "${newFile}" "${target}"`,
      `chmod +x "${target}"`,
      relaunch ? `"${target}" >/dev/null 2>&1 &` : ':',
      '',
    ].join('\n');
  }
  if (plan.kind === 'replace-bundle') {
    return [
      '#!/bin/sh',
      '# Wait for the shell to exit, unzip the new build over the .app, relaunch.',
      'set -e',
      `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
      `rm -rf "${context.unpackDir}"`,
      `mkdir -p "${context.unpackDir}"`,
      `ditto -x -k "${newFile}" "${context.unpackDir}"`,
      `APP="$(find "${context.unpackDir}" -maxdepth 1 -name '*.app' | head -1)"`,
      `[ -n "$APP" ] || exit 1`,
      `rm -rf "${target}"`,
      `cp -R "$APP" "${target}"`,
      relaunch ? `open "${target}" >/dev/null 2>&1 || true` : ':' ,
      '',
    ].join('\n');
  }
  return null;
}

module.exports = {
  APPLY_KINDS,
  DEFAULT_MANIFEST_URL,
  KIND_PREFERENCE,
  fetchManifest,
  helperScriptFor,
  isNewer,
  isVersion,
  normalizeAsset,
  parseManifest,
  planUpdate,
  selectAsset,
  verifySha256,
};
