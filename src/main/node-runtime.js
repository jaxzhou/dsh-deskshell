'use strict';

/**
 * Provision a private Node.js runtime when the machine has none.
 *
 * `dsh` needs Node.js and npm; a desktop app cannot assume them, and asking a
 * user to install a runtime by hand (or to run sudo) is exactly the friction
 * this shell exists to remove. So when detection finds no usable Node — or one
 * older than dsh supports — the shell downloads the official Node distribution
 * for this platform into its own user-data directory and uses that.
 *
 * The result is self-contained: the managed Node's npm global prefix is the
 * managed directory itself, so `npm install -g @deepseek-ai/dsh` lands inside
 * it, needs no administrator rights, and never touches a system Node.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { IS_WINDOWS, PATH_SEPARATOR, runCapture, setEnv, shellCommandFor } = require('./shell-env');

/**
 * dsh's dependencies use `Promise.withResolvers`, which needs Node 22; Node 20
 * fails at runtime, so it counts as "no usable runtime" here.
 */
const MIN_NODE_MAJOR = 22;

/** Used only when every version index is unreachable. Verified to exist. */
const FALLBACK_NODE_VERSION = 'v24.21.0';

/** Official dist first; the mirror covers networks that cannot reach nodejs.org. */
const NODE_DIST_SOURCES = [
  { name: 'nodejs.org', base: 'https://nodejs.org/dist' },
  { name: 'npmmirror', base: 'https://registry.npmmirror.com/-/binary/node' },
];

/**
 * Dist sources to try, honouring `DSH_D_NODE_MIRROR`.
 *
 * An explicit mirror is tried first: it is normally set precisely because the
 * official host is unreachable, and waiting out its timeout first would only
 * delay the download.
 */
function nodeDistSources(env = process.env) {
  const custom = String(env.DSH_D_NODE_MIRROR ?? '').trim();
  if (!custom) return NODE_DIST_SOURCES;
  return [{ name: 'DSH_D_NODE_MIRROR', base: custom.replace(/\/+$/, '') }, ...NODE_DIST_SOURCES];
}

const INDEX_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Extraction shells out to tar/unzip: give big archives room to unpack. */
const EXTRACT_TIMEOUT_MS = 300_000;

const REQUEST_HEADERS = { 'user-agent': 'DSH-D', accept: '*/*' };

/** Node's own name for this platform, or null when it ships no binaries. */
function nodePlatformName(platform = process.platform) {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win';
  if (platform === 'linux') return 'linux';
  return null;
}

/**
 * Describe the official archive for a version/platform/arch pair.
 *
 * @param {string} version normalized tag, e.g. `v24.21.0`.
 * @param {{platform?: string, arch?: string, base?: string}} [options]
 * @returns {{version: string, platform: string, arch: string, fileName: string, kind: 'tar.gz'|'zip', url: string}}
 */
function describeDist(version, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const base = (options.base ?? NODE_DIST_SOURCES[0].base).replace(/\/+$/, '');

  const name = nodePlatformName(platform);
  if (!name) throw new Error(`Node.js 官方未提供 ${platform} 平台的预编译包`);

  // Windows ships .zip (and puts node.exe/npm.cmd at the archive root);
  // everything else ships a .tar.gz with a bin/ directory.
  const fileName = platform === 'win32'
    ? `node-${version}-win-${arch}.zip`
    : `node-${version}-${name}-${arch}.tar.gz`;

  return {
    version,
    platform,
    arch,
    fileName,
    kind: platform === 'win32' ? 'zip' : 'tar.gz',
    url: `${base}/${version}/${fileName}`,
  };
}

/** Normalize `24.21.0`, `v24.21.0` and `v24.21.0/` to `v24.21.0`. */
function normalizeVersion(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/** Major version number of a `vX.Y.Z` string, or null. */
function nodeMajor(version) {
  const match = String(version ?? '').match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

/**
 * Pick the newest LTS release from a `dist/index.json` payload.
 * @param {string} text raw index.json contents.
 * @returns {string} normalized version tag.
 */
function parseLatestLts(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('版本索引为空');
  // The index is newest-first; the first LTS entry is the current LTS line.
  const lts = parsed.find((entry) => entry && entry.lts && entry.version);
  const chosen = lts ?? parsed.find((entry) => entry && entry.version);
  if (!chosen) throw new Error('版本索引中没有可用版本');
  return normalizeVersion(chosen.version);
}

/** GET a URL, following redirects, and hand the response to a consumer. */
function requestStream(url, { timeoutMs = DOWNLOAD_TIMEOUT_MS, onResponse, signal, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) {
      reject(new Error('重定向次数过多'));
      return;
    }
    // Official dists are https, but a custom mirror may be plain http.
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const request = transport.get(url, { headers: REQUEST_HEADERS }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).href;
        requestStream(next, { timeoutMs, onResponse, signal, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      resolve(onResponse ? onResponse(response) : response);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
    });
    request.on('error', reject);

    if (signal) {
      const abort = () => request.destroy(new Error('已取消'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

/** Fetch a small text resource (version index). */
async function fetchText(url, options = {}) {
  return requestStream(url, {
    ...options,
    timeoutMs: options.timeoutMs ?? INDEX_TIMEOUT_MS,
    onResponse: (response) => new Promise((resolve, reject) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve(body));
      response.on('error', reject);
    }),
  });
}

/**
 * Ask the dist sources for the current LTS version.
 * @returns {Promise<{version: string, source: string}>}
 */
async function resolveLatestLts(options = {}) {
  const sources = options.sources ?? NODE_DIST_SOURCES;
  const errors = [];
  for (const source of sources) {
    try {
      const text = await fetchText(`${source.base}/index.json`, options);
      const version = parseLatestLts(text);
      return { version, source: source.name };
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`无法获取 Node.js 版本信息（${errors.join('；')}）`);
}

/**
 * Download a file, reporting byte progress.
 *
 * @param {string} url
 * @param {string} destination
 * @param {{onProgress?: Function, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<{bytes: number, resumed: boolean}>}
 */
async function downloadFile(url, destination, options = {}) {
  const { onProgress = () => {}, signal } = options;
  const partial = `${destination}.part`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  let received = 0;
  const bytes = await requestStream(url, {
    timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    signal,
    onResponse: (response) => new Promise((resolve, reject) => {
      const total = Number(response.headers['content-length'] ?? 0);
      const stream = fs.createWriteStream(partial);
      let lastReport = 0;

      response.on('data', (chunk) => {
        received += chunk.length;
        // Throttle: a 50 MB download emits thousands of chunks.
        const now = Date.now();
        if (now - lastReport > 200) {
          lastReport = now;
          onProgress({
            received,
            total,
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          });
        }
      });
      response.pipe(stream);

      stream.on('finish', () => {
        onProgress({ received, total, percent: 100 });
        resolve(received);
      });
      stream.on('error', reject);
      response.on('error', reject);
    }),
  });

  fs.renameSync(partial, destination);
  return { bytes, resumed: false };
}

/** True when the archive looks complete (guards against a half-written cache). */
function archiveExists(file) {
  try {
    return fs.statSync(file).size > 1024 * 1024;
  } catch {
    return false;
  }
}

/**
 * Unpack a Node archive into `destDir`, flattening the archive's top directory.
 *
 * tar is used for both kinds: bsdtar (macOS, and Windows 10+) reads .zip too,
 * and it understands `--strip-components`, which removes the need to guess the
 * archive's inner directory name.
 */
async function extractArchive(archive, destDir, kind, options = {}) {
  const { onLog = () => {}, timeoutMs = EXTRACT_TIMEOUT_MS } = options;
  fs.mkdirSync(destDir, { recursive: true });

  const args = ['-xf', archive, '-C', destDir, '--strip-components=1'];
  onLog({ stream: 'system', line: `$ tar ${args.join(' ')}` });

  const result = await runCapture('tar', args, { env: process.env, timeoutMs });
  if (result.ok) return;

  throw new Error(
    `解压失败：${result.error ?? result.stderr.trim() ?? `exit ${result.code}`}`,
  );
}

/** Where the managed runtimes live inside the app's user-data directory. */
function defaultRuntimeRoot(userDataDir) {
  return path.join(userDataDir ?? path.join(os.homedir(), '.dsh-d'), 'runtime');
}

/** Directories of a managed runtime: node and npm sit in bin/ except on Windows. */
function runtimePaths(dir) {
  const binDir = IS_WINDOWS ? dir : path.join(dir, 'bin');
  return {
    dir,
    binDir,
    nodePath: path.join(binDir, IS_WINDOWS ? 'node.exe' : 'node'),
    npmPath: path.join(binDir, IS_WINDOWS ? 'npm.cmd' : 'npm'),
  };
}

/**
 * Path of the npm command a runtime should expose.
 * Windows ships `npm.cmd` beside node.exe; posix ships a `bin/npm` symlink.
 */
function npmCommandFor(dir) {
  return runtimePaths(dir).npmPath;
}

/**
 * Rebuild a missing npm command from the npm that ships inside the runtime.
 *
 * Node's archive exposes npm through a symlink (`bin/npm` ->
 * `../lib/node_modules/npm/bin/npm-cli.js` on posix, `npm.cmd` on Windows).
 * Some extraction tools drop symlinks, and a partially written runtime can lose
 * the shim while `bin/node` still works — which leaves the machine able to run
 * node but not npm. Rather than looping, rebuild the shim from the bundled npm.
 *
 * @returns {boolean} true when an npm command is available afterwards.
 */
function ensureNpmCommand(dir) {
  const paths = runtimePaths(dir);
  try {
    if (fs.statSync(paths.npmPath).isFile()) return true;
  } catch {
    /* missing: try to rebuild below */
  }

  const cli = path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    if (!fs.statSync(cli).isFile()) return false;
  } catch {
    return false;
  }

  try {
    if (IS_WINDOWS) {
      // A .cmd shim: run the bundled npm CLI with the managed node.
      fs.writeFileSync(
        paths.npmPath,
        `@ECHO off\r\nSETLOCAL\r\n"%~dp0node.exe" "%~dp0lib\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n`,
      );
    } else {
      // Restore the archive's symlink, falling back to a tiny wrapper script.
      try {
        fs.symlinkSync(path.relative(paths.binDir, cli), paths.npmPath);
      } catch {
        fs.writeFileSync(
          paths.npmPath,
          `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n`,
        );
      }
      fs.chmodSync(paths.npmPath, 0o755);
    }
    return fs.statSync(paths.npmPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check that a runtime really works: both commands must exist *and run*.
 *
 * Existence alone is not enough — a half-extracted runtime passes an
 * existence check and then fails forever, which is what makes a broken
 * bootstrap loop instead of repairing itself.
 *
 * @param {string} dir runtime directory.
 * @param {{env?: NodeJS.ProcessEnv}} [options] environment for the probes.
 * @returns {Promise<{ok: true, dir: string, binDir: string, nodePath: string, npmPath: string, version: string, nodeVersion: string, npmVersion: string}
 *   | {ok: false, reason: string, nodeVersion?: string|null}>}
 */
async function verifyManagedRuntime(dir, options = {}) {
  const paths = runtimePaths(dir);
  // On posix, `bin/npm` is a symlink to npm-cli.js, whose shebang is
  // `#!/usr/bin/env node`: running npm therefore needs *this* runtime's node to
  // be first on PATH. Passing the caller's environment through unchanged would
  // work on a machine that already has node and fail on exactly the machine
  // this bootstrap exists for — so the bin directory is always prepended here,
  // regardless of what the caller supplied.
  const env = withManagedRuntime(options.env ?? process.env, paths.binDir);
  const version = (path.basename(dir).match(/^node-(v\d+\.\d+\.\d+)/) ?? [])[1] ?? path.basename(dir);

  ensureNpmCommand(dir);

  for (const [name, file] of [['node', paths.nodePath], ['npm', paths.npmPath]]) {
    try {
      if (!fs.statSync(file).isFile()) {
        return { ok: false, reason: `运行时缺少 ${name}：${file}` };
      }
    } catch {
      return { ok: false, reason: `运行时缺少 ${name}：${file}` };
    }
  }

  const nodeProbe = await runCapture(paths.nodePath, ['--version'], { env, timeoutMs: 30_000 });
  if (!nodeProbe.ok) {
    return { ok: false, reason: `node --version 执行失败：${nodeProbe.error ?? nodeProbe.stderr.trim() ?? `exit ${nodeProbe.code}`}` };
  }

  const npmProbe = await runCapture(npmCommandFor(dir), ['--version'], { env, timeoutMs: 60_000 });
  if (!npmProbe.ok || !/\d+\.\d+\.\d+/.test(npmProbe.stdout)) {
    return {
      ok: false,
      nodeVersion: nodeProbe.stdout.trim(),
      reason: `npm --version 执行失败：${npmProbe.error ?? npmProbe.stderr.trim() ?? `exit ${npmProbe.code}`}`,
    };
  }

  return {
    ok: true,
    ...paths,
    version,
    nodeVersion: nodeProbe.stdout.trim(),
    npmVersion: npmProbe.stdout.trim(),
  };
}

/**
 * Find an already-provisioned managed runtime, newest version first.
 * @returns {{dir: string, binDir: string, nodePath: string, npmPath: string, version: string}|null}
 */
function findManagedRuntime(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  /** `node-v24.21.0-darwin-x64` → `v24.21.0` (the trailing platform is ignored). */
  const versionOf = (name) => (name.match(/^node-(v\d+\.\d+\.\d+)/) ?? [])[1] ?? name;

  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^node-v\d+\.\d+\.\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const pa = versionOf(a).replace(/^v/, '').split('.').map(Number);
      const pb = versionOf(b).replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    });

  for (const name of candidates) {
    const dir = path.join(root, name);
    const paths = runtimePaths(dir);
    try {
      // A missing npm shim is repairable, so only node must be present here;
      // verifyManagedRuntime() decides whether the runtime is actually usable.
      if (fs.statSync(paths.nodePath).isFile() && ensureNpmCommand(dir)) {
        return { ...paths, version: versionOf(name) };
      }
    } catch {
      /* incomplete install: keep looking */
    }
  }
  return null;
}

/** Prepend a managed runtime's bin directory to an environment's PATH. */
function withManagedRuntime(env, binDir) {
  if (!binDir) return env;
  const current = String(env.PATH ?? '').split(PATH_SEPARATOR).filter(Boolean);
  const deduped = [binDir, ...current.filter((entry) => entry !== binDir)];
  return setEnv({ ...env }, 'PATH', deduped.join(PATH_SEPARATOR));
}

/**
 * Environment for commands that must run inside the managed runtime.
 *
 * npm derives its global prefix from the launching environment: a parent
 * `npm run` exports `npm_config_global_prefix` (and a user's ~/.npmrc may set
 * `prefix`), either of which would send `npm install -g` into a system
 * directory that needs administrator rights — exactly what the managed
 * runtime exists to avoid. So the prefix and the cache are pinned inside the
 * runtime; registry and proxy settings are left untouched.
 *
 * @param {NodeJS.ProcessEnv} env base environment (usually the login shell's).
 * @param {{dir: string, binDir: string}} runtime managed runtime descriptor.
 * @param {{cacheDir?: string}} [options]
 */
function managedRuntimeEnv(env, runtime, options = {}) {
  const base = withManagedRuntime(env, runtime.binDir);
  setEnv(base, 'npm_config_prefix', runtime.dir);
  setEnv(base, 'npm_config_global_prefix', runtime.dir);
  if (options.cacheDir) setEnv(base, 'npm_config_cache', options.cacheDir);
  return base;
}

/** Progress model for the runtime bootstrap, shaped like the install one. */
function createNodeProgress() {
  const state = { percent: 1, phase: '准备下载 Node.js', detail: '', done: false };
  const advance = (percent, phase, detail) => {
    if (typeof percent === 'number' && percent > state.percent) state.percent = Math.min(100, percent);
    if (phase) state.phase = phase;
    if (detail !== undefined) state.detail = detail;
  };
  return {
    downloading: ({ received, total, percent }) => {
      // Download owns 5–85% of the bar; extraction and verification take the rest.
      const ratio = percent === null ? null : percent / 100;
      const detail = total
        ? `${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
        : `${(received / 1024 / 1024).toFixed(1)} MB`;
      advance(ratio === null ? Math.min(60, state.percent + 1) : 5 + 80 * ratio, '下载 Node.js 运行时', detail);
    },
    extracting: (file) => advance(88, '解压运行时', file),
    verifying: () => advance(96, '校验 node 与 npm', ''),
    done: (version) => {
      state.done = true;
      state.percent = 100;
      state.phase = '运行时已就绪';
      state.detail = version ? `Node.js ${version}` : '';
    },
    failed: (reason) => {
      state.phase = '运行时配置失败';
      state.detail = String(reason ?? '');
    },
    snapshot: () => ({ ...state }),
  };
}

/**
 * Ensure a usable managed Node.js runtime exists under `root`.
 *
 * Reuses an already-downloaded archive and an already-unpacked runtime, so a
 * retry after a partial failure does not download everything again.
 *
 * @param {{
 *   root: string,
 *   version?: string|null,
 *   platform?: string,
 *   arch?: string,
 *   sources?: Array<{name: string, base: string}>,
 *   onLog?: (entry: {stream: string, line: string}) => void,
 *   onProgress?: (snapshot: object) => void,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ok: true, dir: string, binDir: string, nodePath: string, npmPath: string, version: string, reused: boolean}
 *   | {ok: false, error: string, hint: string|null}>}
 */
async function installNodeRuntime(options) {
  const {
    root,
    version: requested = null,
    platform = process.platform,
    arch = process.arch,
    sources = NODE_DIST_SOURCES,
    onLog = () => {},
    onProgress = () => {},
    signal,
  } = options;

  const progress = createNodeProgress();
  const report = () => onProgress(progress.snapshot());
  report();

  try {
    fs.mkdirSync(root, { recursive: true });

    // 1. Resolve the version to install.
    let version = normalizeVersion(requested);
    if (!version) {
      try {
        const latest = await resolveLatestLts({ sources, signal });
        version = latest.version;
        onLog({ stream: 'system', line: `Node.js 最新 LTS：${version}（来自 ${latest.source}）` });
      } catch (error) {
        version = FALLBACK_NODE_VERSION;
        onLog({
          stream: 'stderr',
          line: `无法获取版本索引（${error instanceof Error ? error.message : String(error)}），改用 ${version}`,
        });
      }
    }

    const targetDir = path.join(root, `node-${version}-${platform}-${arch}`);
    const paths = runtimePaths(targetDir);

    // 2. Already unpacked and usable? Existence is not enough: a half-written
    //    runtime (node runs, npm does not) must be repaired, not reused.
    const existing = findManagedRuntime(root);
    if (existing && existing.version === version) {
      const verified = await verifyManagedRuntime(existing.dir);
      if (verified.ok) {
        onLog({ stream: 'system', line: `复用已安装的运行时：${existing.dir}（node ${verified.nodeVersion} / npm ${verified.npmVersion}）` });
        progress.done(existing.version);
        report();
        return { ok: true, ...existing, reused: true };
      }
      onLog({
        stream: 'stderr',
        line: `已存在的运行时不可用（${verified.reason}），将重新配置：${existing.dir}`,
      });
      progress.extracting('正在重新配置运行时');
      report();
      fs.rmSync(existing.dir, { recursive: true, force: true });
    }

    // 3. Download (from the first source that answers).
    let lastError = null;
    let archivePath = null;
    for (const source of sources) {
      const dist = describeDist(version, { platform, arch, base: source.base });
      archivePath = path.join(root, '.cache', dist.fileName);

      if (archiveExists(archivePath)) {
        onLog({ stream: 'system', line: `复用已下载的安装包：${archivePath}` });
        break;
      }

      onLog({ stream: 'system', line: `下载 ${dist.url}` });
      try {
        await downloadFile(dist.url, archivePath, {
          signal,
          onProgress: (snapshot) => {
            progress.downloading(snapshot);
            report();
          },
        });
        break;
      } catch (error) {
        lastError = error;
        archivePath = null;
        fs.rmSync(`${archivePath}.part`, { force: true });
        onLog({
          stream: 'stderr',
          line: `从 ${source.name} 下载失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (!archivePath) {
      progress.failed(lastError ? String(lastError.message ?? lastError) : '没有可用的下载源');
      report();
      return {
        ok: false,
        error: `Node.js 运行时下载失败：${lastError ? String(lastError.message ?? lastError) : '没有可用的下载源'}`,
        hint: '请检查网络或代理设置；也可以设置 DSH_D_NODE_MIRROR 指向可用的 Node.js 发行版镜像。',
      };
    }

    // 4. Unpack into a staging directory, then move it into place atomically.
    progress.extracting(path.basename(archivePath));
    report();
    const staging = `${targetDir}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    await extractArchive(archivePath, staging, describeDist(version, { platform, arch }).kind, { onLog });

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(staging, targetDir);

    // 5. Both node and npm must actually run before the app relies on them.
    progress.verifying();
    report();
    const verified = await verifyManagedRuntime(targetDir);
    if (!verified.ok) {
      progress.failed(verified.reason);
      report();
      onLog({ stream: 'stderr', line: `运行时校验失败：${verified.reason}` });
      fs.rmSync(targetDir, { recursive: true, force: true });
      return {
        ok: false,
        error: `运行时校验失败：${verified.reason}`,
        hint: `已删除不可用的运行时目录，可重试；若反复失败请检查下载的安装包：${archivePath}`,
      };
    }

    onLog({
      stream: 'system',
      line: `Node.js 运行时已就绪：${verified.nodePath}（node ${verified.nodeVersion} / npm ${verified.npmVersion}）`,
    });
    progress.done(verified.nodeVersion);
    report();
    return { ok: true, ...verified, reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.failed(message);
    report();
    return { ok: false, error: `Node.js 运行时配置失败：${message}`, hint: null };
  }
}

/** The npm command for a managed runtime (shell-quoted on Windows). */
function managedNpmCommand(runtime) {
  return IS_WINDOWS ? shellCommandFor(runtime.npmPath) : runtime.npmPath;
}

module.exports = {
  FALLBACK_NODE_VERSION,
  MIN_NODE_MAJOR,
  NODE_DIST_SOURCES,
  createNodeProgress,
  defaultRuntimeRoot,
  describeDist,
  downloadFile,
  extractArchive,
  fetchText,
  findManagedRuntime,
  installNodeRuntime,
  ensureNpmCommand,
  managedNpmCommand,
  managedRuntimeEnv,
  nodeDistSources,
  npmCommandFor,
  nodeMajor,
  nodePlatformName,
  normalizeVersion,
  parseLatestLts,
  resolveLatestLts,
  runtimePaths,
  verifyManagedRuntime,
  withManagedRuntime,
};
