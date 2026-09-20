'use strict';

/**
 * The shell's plugin market.
 *
 * The market is a feature of DSH-D itself — not a dsh plugin. It reads a plugin
 * catalog from dsh.textwork.cn, compares it against what the dsh profile
 * already has installed, and installs or updates plugins through dsh's own
 * plugin command.
 *
 * `dsh plugin` is a thin pnpm forwarder: it runs `pnpm <args>` inside the
 * profile directory and then reconciles the profile's `dsh.profile.bundles`
 * layer list, so a plugin installed here becomes an active layer on the next
 * `dsh web` boot — which is why installing anything triggers a dsh restart.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawn } = require('node:child_process');

const { findExecutable } = require('./dsh-detect');
const { fetchText } = require('./node-runtime');
const { createLineSplitter, terminate } = require('./process-tree');
const { IS_WINDOWS, runCapture, shellCommandFor } = require('./shell-env');

/** Catalog endpoint served by the project's download site. */
const DEFAULT_MARKET_URL = 'https://dsh.textwork.cn/plugins/index.json';

/** The profile the shell boots; plugins are installed into it. */
const DEFAULT_PROFILE = 'web';

/** First-party layers that ship with dsh and are not market plugins. */
const BUILTIN_PREFIX = '@deepseek-ai/';

/** Registry package names we are willing to put on a command line. */
const PACKAGE_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Versions, dist-tags and ranges accepted from the catalog. */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const CATALOG_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Where dsh keeps its profiles (`$DSH_HOME` or `~/.dsh`). */
function defaultDshHome(env = process.env) {
  const configured = String(env.DSH_HOME ?? '').trim();
  return configured || path.join(os.homedir(), '.dsh');
}

/**
 * Compare two versions the way semver does, without a dependency.
 *
 * Build metadata (`+…`) is ignored; prerelease identifiers make a version
 * smaller than the corresponding release, and are compared identifier by
 * identifier (numeric identifiers numerically).
 *
 * @returns {number} -1 when a < b, 0 when equal, 1 when a > b.
 */
function compareVersions(a, b) {
  const split = (value) => {
    const text = String(value ?? '').trim().replace(/^[v=]+/, '');
    const [core, ...rest] = text.split('+');
    const [numbers, ...pre] = core.split('-');
    return {
      numbers: numbers.split('.').map((part) => {
        const digits = part.match(/^\d+/);
        return digits ? Number(digits[0]) : 0;
      }),
      prerelease: pre.length ? pre.join('-').split('.') : null,
      raw: text,
    };
  };

  const left = split(a);
  const right = split(b);
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.numbers[index] ?? 0;
    const r = right.numbers[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  // A release outranks any prerelease of the same core version.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const max = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < max; index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
    } else if (ln !== rn) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** True for a package name we are willing to pass to pnpm. */
function isSafePackageName(name) {
  return typeof name === 'string' && name.length <= 214 && PACKAGE_PATTERN.test(name);
}

/** True for a version, dist-tag or range we are willing to pass to pnpm. */
function isSafeVersion(version) {
  return typeof version === 'string' && version.length <= 64 && VERSION_PATTERN.test(version);
}

/** Trim and collapse a display string. */
function cleanText(value, max = 400) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Normalize a list of strings, dropping empties. */
function cleanList(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, max);
}

/**
 * Parse and validate a catalog payload.
 *
 * Anything unsafe or malformed is dropped rather than trusted: the catalog is
 * remote input that ends up on a command line.
 *
 * @param {string} text raw JSON body.
 * @returns {{schemaVersion: number, updatedAt: string, site: string, plugins: object[]}}
 * @throws {Error} when the payload is not a usable catalog at all.
 */
function parseCatalog(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`目录不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('目录结构无效');
  const list = Array.isArray(payload.plugins) ? payload.plugins : null;
  if (!list) throw new Error('目录缺少 plugins 数组');

  const plugins = [];
  const skipped = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const packageName = cleanText(entry.package, 214);
    const version = cleanText(entry.version, 64);
    if (!isSafePackageName(packageName) || !isSafeVersion(version)) {
      skipped.push(packageName || '(未命名)');
      continue;
    }
    plugins.push({
      package: packageName,
      name: cleanText(entry.name, 80) || packageName.split('/').pop(),
      version,
      summary: cleanText(entry.summary, 300),
      description: cleanText(entry.description, 1200),
      highlights: cleanList(entry.highlights),
      tags: cleanList(entry.tags, 8),
      license: cleanText(entry.license, 40),
      author: cleanText(entry.author, 80),
      npm: cleanText(entry.npm, 300),
      repository: cleanText(entry.repository, 300),
      homepage: cleanText(entry.homepage, 300),
      minShell: cleanText(entry.minShell, 32),
    });
  }

  if (plugins.length === 0 && skipped.length > 0) {
    throw new Error(`目录中的插件条目均无效：${skipped.slice(0, 3).join('、')}`);
  }

  return {
    schemaVersion: Number(payload.schemaVersion ?? payload.version ?? 1) || 1,
    updatedAt: cleanText(payload.updatedAt, 32),
    site: cleanText(payload.site, 200),
    plugins,
  };
}

/** Download and parse the catalog. */
async function fetchCatalog(options = {}) {
  const url = options.url ?? DEFAULT_MARKET_URL;
  const requestUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  try {
    const text = await fetchText(requestUrl, {
      timeoutMs: options.timeoutMs ?? CATALOG_TIMEOUT_MS,
      signal: options.signal,
    });
    return { ok: true, catalog: parseCatalog(text), source: url, fetchedAt: Date.now() };
  } catch (error) {
    return {
      ok: false,
      source: url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read `<profile>/node_modules/<pkg>/package.json` for the installed version. */
function readPackageVersion(profileDir, packageName) {
  try {
    const manifest = path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return { version: cleanText(parsed.version, 64) || null, manifest };
  } catch {
    return { version: null, manifest: null };
  }
}

/** Describe a dependency spec as it appears in the profile manifest. */
function describeSpec(spec) {
  const text = String(spec ?? '').trim();
  if (/^link:/.test(text)) return { kind: 'link', target: text.slice(5) };
  if (/^(file:|\.{1,2}\/|\/)/.test(text)) return { kind: 'file', target: text };
  if (/^(git\+|github:|https?:\/\/)/.test(text)) return { kind: 'git', target: text };
  if (/^workspace:/.test(text)) return { kind: 'workspace', target: text.slice(10) };
  return { kind: 'registry', target: text };
}

/**
 * What the dsh profile currently has.
 *
 * `dsh.profile.bundles` is the authoritative layer list (`dsh plugin`
 * reconciles it against installed state); `dependencies` tells us how each one
 * was required, and the package manifest inside the profile's node_modules
 * gives the version actually on disk.
 *
 * @param {{dshHome?: string, profile?: string}} [options]
 * @returns {{profile: string, dir: string, exists: boolean, bundles: string[], plugins: object[], error: string|null}}
 */
function readInstalledPlugins(options = {}) {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const dshHome = options.dshHome ?? defaultDshHome();
  const dir = path.join(dshHome, 'profiles', profile);
  const manifestPath = path.join(dir, 'package.json');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      profile,
      dir,
      exists: false,
      bundles: [],
      plugins: [],
      error: `读取 profile 清单失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};

  const names = new Set();
  for (const name of bundles) if (!String(name).startsWith(BUILTIN_PREFIX)) names.add(String(name));
  for (const name of Object.keys(dependencies)) if (!String(name).startsWith(BUILTIN_PREFIX)) names.add(name);

  const plugins = [];
  for (const packageName of [...names].sort()) {
    if (!isSafePackageName(packageName)) continue;
    const spec = dependencies[packageName] ?? null;
    const installed = readPackageVersion(dir, packageName);
    plugins.push({
      package: packageName,
      name: packageName.split('/').pop(),
      spec,
      source: spec ? describeSpec(spec).kind : 'unknown',
      version: installed.version,
      manifest: installed.manifest,
      bundle: bundles.includes(packageName),
      builtin: false,
    });
  }

  return { profile, dir, exists: true, bundles, plugins, error: null };
}

/**
 * Merge the catalog with what is installed.
 *
 * @returns {{rows: object[], localOnly: object[], updates: number}}
 */
function marketRows(catalog, installed) {
  const installedByPackage = new Map();
  for (const plugin of installed?.plugins ?? []) installedByPackage.set(plugin.package, plugin);

  const rows = [];
  const seen = new Set();
  for (const entry of catalog?.plugins ?? []) {
    const local = installedByPackage.get(entry.package) ?? null;
    seen.add(entry.package);
    let status = 'not-installed';
    if (local) {
      if (!local.version) status = 'installed-unknown-version';
      else status = compareVersions(local.version, entry.version) < 0 ? 'update-available' : 'installed';
    }
    rows.push({ ...entry, local, status });
  }

  const localOnly = (installed?.plugins ?? [])
    .filter((plugin) => !seen.has(plugin.package))
    .map((plugin) => ({ ...plugin, status: 'local-only' }));

  return {
    rows,
    localOnly,
    updates: rows.filter((row) => row.status === 'update-available').length,
  };
}

/**
 * Build the `dsh plugin` argv for an install/update.
 *
 * @param {{profile?: string, packageName: string, version?: string|null}} options
 * @returns {string[]} arguments for the dsh executable.
 */
function buildPluginArgs(options) {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const packageName = String(options.packageName ?? '');
  if (!isSafePackageName(packageName)) throw new Error(`不安全的包名：${packageName}`);
  const version = options.version ? String(options.version) : '';
  if (version && !isSafeVersion(version)) throw new Error(`不安全的版本号：${version}`);
  const spec = version ? `${packageName}@${version}` : packageName;
  // `add` with an explicit version is both the install and the update path;
  // dsh reconciles the profile's bundle list afterwards.
  return ['plugin', '--profile', profile, 'add', spec];
}

/** True when the environment already has pnpm (needed by `dsh plugin`). */
function findPnpm(env = process.env) {
  return findExecutable('pnpm', env);
}

/**
 * Run one plugin command, streaming its output.
 *
 * @param {{dshCommand: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string,
 *          onLog?: Function, onProgress?: Function, timeoutMs?: number}} options
 * @returns {{promise: Promise<{ok: boolean, code: number|string|null, output: string, error: string|null}>, cancel: () => void}}
 */
function runPluginCommand(options) {
  const { dshCommand, args, env, cwd, onLog = () => {}, timeoutMs = INSTALL_TIMEOUT_MS } = options;
  let child = null;
  let cancelled = false;
  let output = '';

  const promise = new Promise((resolve) => {
    onLog({ stream: 'system', line: `$ ${path.basename(dshCommand)} ${args.join(' ')}` });
    try {
      child = spawn(shellCommandFor(dshCommand), args, {
        cwd,
        env,
        shell: IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onLog({ stream: 'stderr', line: `无法启动 dsh：${message}` });
      resolve({ ok: false, code: null, output, error: message });
      return;
    }

    const timer = setTimeout(() => {
      onLog({ stream: 'stderr', line: `插件命令超时（${Math.round(timeoutMs / 60000)} 分钟）` });
      terminate(child, { onLog: (line) => onLog({ stream: 'system', line }) });
    }, timeoutMs);

    const stdout = createLineSplitter((line) => {
      output += `${line}\n`;
      onLog({ stream: 'stdout', line });
    });
    const stderr = createLineSplitter((line) => {
      output += `${line}\n`;
      onLog({ stream: 'stderr', line });
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => onLog({ stream: 'stderr', line: `dsh 进程错误：${error.message}` }));

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      stdout.flush();
      stderr.flush();
      resolve({
        ok: !cancelled && code === 0,
        code: code ?? null,
        output,
        error: cancelled ? '已取消' : code === 0 ? null : `dsh plugin 退出码 ${code ?? signal ?? '未知'}`,
      });
    });
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (child) terminate(child, { onLog: (line) => onLog({ stream: 'system', line }) });
    },
  };
}

/**
 * Make pnpm available, installing it into the current runtime when missing.
 *
 * `dsh plugin` shells out to pnpm; a machine that only has Node + npm (the
 * case the runtime bootstrap creates) has no pnpm, so the market would fail
 * with "pnpm not found on PATH" on exactly the setups this shell provisions.
 *
 * @param {{env: NodeJS.ProcessEnv, npmCommand: string|null, onLog?: Function, run?: Function}} options
 * @returns {Promise<{ok: boolean, command: string|null, installed: boolean, error: string|null}>}
 */
async function ensurePnpm(options) {
  const { env, npmCommand, onLog = () => {}, run = runCapture, locate = findPnpm } = options;
  const existing = locate(env);
  if (existing) return { ok: true, command: existing, installed: false, error: null };
  if (!npmCommand) {
    return { ok: false, command: null, installed: false, error: '系统中没有 pnpm，也没有可用于安装它的 npm' };
  }

  onLog({ stream: 'system', line: '未检测到 pnpm（dsh plugin 依赖它），正在用 npm 安装…' });
  const result = await run(npmCommand, ['install', '-g', 'pnpm', '--no-fund', '--no-audit', '--loglevel=error'], {
    env,
    timeoutMs: 5 * 60_000,
  });
  if (!result.ok) {
    return {
      ok: false,
      command: null,
      installed: false,
      error: `pnpm 安装失败：${result.error ?? result.stderr.trim() ?? `exit ${result.code}`}`,
    };
  }

  const installed = locate(env);
  if (!installed) {
    return { ok: false, command: null, installed: true, error: 'pnpm 安装后仍未在 PATH 中找到' };
  }
  onLog({ stream: 'system', line: `pnpm 已安装：${installed}` });
  return { ok: true, command: installed, installed: true, error: null };
}

module.exports = {
  BUILTIN_PREFIX,
  CATALOG_TIMEOUT_MS,
  DEFAULT_MARKET_URL,
  DEFAULT_PROFILE,
  INSTALL_TIMEOUT_MS,
  buildPluginArgs,
  cleanText,
  compareVersions,
  defaultDshHome,
  describeSpec,
  ensurePnpm,
  fetchCatalog,
  findPnpm,
  isSafePackageName,
  isSafeVersion,
  marketRows,
  parseCatalog,
  readInstalledPlugins,
  readPackageVersion,
  runPluginCommand,
};
