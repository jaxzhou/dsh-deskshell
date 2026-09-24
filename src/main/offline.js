'use strict';

/**
 * Offline, self-contained payload support.
 *
 * The offline Linux build ships everything dsh needs beside the app:
 *
 *   vendor/node/           Node runtime + npm + pnpm + dsh
 *   vendor/dsh-home/       a DSH_HOME seed whose `web` profile already has the
 *                          bundled plugin installed
 *   vendor/pnpm-store.tgz  pnpm store, so plugin installs also work offline
 *   vendor/manifest.json   what was built (versions, platform)
 *
 * The payload lives inside the (read-only) application bundle, so on first run
 * the harness home is copied into the user-data directory and `DSH_HOME` is
 * pointed there; nothing is ever downloaded.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { PATH_SEPARATOR, setEnv } = require('./shell-env');

/** Env override, mainly for tests and for a payload kept outside the bundle. */
const VENDOR_ENV = 'DSH_D_VENDOR_DIR';
/** Marker recording which payload a seeded home came from. */
const SEED_MARKER = '.dsh-d-seed.json';

/**
 * Locate the bundled payload.
 *
 * @param {{resourcesPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string|null} absolute vendor directory, or null when absent.
 */
function resolveVendorDir(options = {}) {
  const env = options.env ?? process.env;
  const candidates = [];
  const configured = String(env[VENDOR_ENV] ?? '').trim();
  if (configured) candidates.push(configured);
  if (options.resourcesPath) candidates.push(path.join(options.resourcesPath, 'vendor'));
  for (const candidate of candidates) {
    const dir = path.resolve(candidate);
    if (fs.existsSync(path.join(dir, 'node', 'bin', 'node'))) return dir;
  }
  return null;
}

/** Read the payload manifest (versions, platform), when present. */
function readManifest(vendorDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(vendorDir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Describe the bundled payload.
 *
 * @param {{vendorDir: string|null}} options
 * @returns {{available: boolean, dir: string|null, nodeBinDir: string|null, dshHome: string|null,
 *            pnpmStore: string|null, pluginsDir: string|null, manifest: object|null}}
 */
function describeVendor(options) {
  const dir = options?.vendorDir ?? null;
  if (!dir) {
    return { available: false, dir: null, nodeBinDir: null, dshHome: null, pnpmStore: null, pluginsDir: null, manifest: null };
  }
  const dshHome = path.join(dir, 'dsh-home');
  const store = path.join(dir, 'pnpm-store.tgz');
  return {
    available: true,
    dir,
    nodeBinDir: path.join(dir, 'node', 'bin'),
    dshHome: fs.existsSync(path.join(dshHome, 'profiles')) ? dshHome : null,
    pnpmStore: fs.existsSync(store) ? store : null,
    pluginsDir: fs.existsSync(path.join(dir, 'plugins')) ? path.join(dir, 'plugins') : null,
    manifest: readManifest(dir),
  };
}

/** Recursively copy a directory, preserving the executable bit and symlinks. */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(from);
      fs.rmSync(to, { force: true });
      fs.symlinkSync(link, to);
    } else {
      fs.copyFileSync(from, to);
      // `copyFileSync` keeps the mode on some platforms only; be explicit.
      const mode = fs.statSync(from).mode & 0o777;
      if (mode & 0o111) fs.chmodSync(to, mode);
    }
  }
}

/**
 * Materialize a writable harness home from the bundled seed.
 *
 * Re-runs whenever the payload's build id changes, so a new offline build also
 * refreshes the pre-installed plugin.
 *
 * @param {{vendorDir: string|null, homeDir: string, manifest?: object|null, onLog?: Function}} options
 * @returns {{ok: boolean, dir: string|null, seeded: boolean, error: string|null}}
 */
function seedDshHome(options) {
  const { vendorDir, homeDir, manifest = null, onLog = () => {} } = options;
  const source = vendorDir ? path.join(vendorDir, 'dsh-home') : null;
  if (!source || !fs.existsSync(path.join(source, 'profiles'))) {
    return { ok: false, dir: null, seeded: false, error: '离线 payload 中没有 dsh-home 种子' };
  }

  const buildId = String(manifest?.builtAt ?? manifest?.dsh ?? 'unknown');
  const markerPath = path.join(homeDir, SEED_MARKER);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    current = null;
  }

  const upToDate = current?.buildId === buildId && fs.existsSync(path.join(homeDir, 'profiles'));
  if (upToDate) {
    onLog({ stream: 'system', line: `复用已展开的离线 dsh home：${homeDir}` });
    return { ok: true, dir: homeDir, seeded: false, error: null };
  }

  try {
    onLog({ stream: 'system', line: `正在展开离线 dsh home 到 ${homeDir}（仅首次）…` });
    // Keep any user data that is not part of the seed (sessions, credentials).
    const preserved = ['sessions', 'attachments', 'llm-deepseek', '.credentials.yaml', '.anonymous-user-id'];
    const stash = path.join(homeDir, '.seed-preserve');
    fs.rmSync(stash, { recursive: true, force: true });
    if (fs.existsSync(homeDir)) {
      fs.mkdirSync(stash, { recursive: true });
      for (const name of preserved) {
        const from = path.join(homeDir, name);
        if (fs.existsSync(from)) {
          fs.renameSync(from, path.join(stash, name));
        }
      }
    }

    copyTree(source, homeDir);

    // Restore preserved entries on top of the fresh seed.
    if (fs.existsSync(stash)) {
      for (const name of fs.readdirSync(stash)) {
        const to = path.join(homeDir, name);
        fs.rmSync(to, { recursive: true, force: true });
        fs.renameSync(path.join(stash, name), to);
      }
      fs.rmSync(stash, { recursive: true, force: true });
    }

    fs.writeFileSync(markerPath, JSON.stringify({ buildId, seededAt: new Date().toISOString(), from: vendorDir }, null, 2));
    return { ok: true, dir: homeDir, seeded: true, error: null };
  } catch (error) {
    return { ok: false, dir: null, seeded: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Extract the bundled pnpm store so plugin installs work without network.
 *
 * @param {{vendor?: object, targetDir: string, onLog?: Function}} options
 * @returns {{ok: boolean, dir: string|null, extracted: boolean, error: string|null}}
 */
function preparePnpmStore(options) {
  const { vendor, targetDir, onLog = () => {} } = options;
  if (!vendor?.pnpmStore) return { ok: false, dir: null, extracted: false, error: '离线 payload 中没有 pnpm store' };
  if (fs.existsSync(path.join(targetDir, 'v11')) || fs.existsSync(path.join(targetDir, 'files'))) {
    return { ok: true, dir: targetDir, extracted: false, error: null };
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    onLog({ stream: 'system', line: `正在展开离线 pnpm store 到 ${targetDir}…` });
    execFileSync('tar', ['xzf', vendor.pnpmStore, '-C', targetDir], { stdio: 'ignore' });
    return { ok: true, dir: targetDir, extracted: true, error: null };
  } catch (error) {
    return { ok: false, dir: null, extracted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Apply offline payload settings to an environment.
 *
 * The bundled bin directory leads PATH (so the vendor dsh/npm/pnpm win over any
 * system install), `DSH_HOME` points at the seeded writable home, and the
 * bundled store is preferred over the network — `prefer-offline` keeps plugin
 * updates working when a network does exist.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{nodeBinDir: string, homeDir: string|null, storeDir: string|null}} options
 * @returns {NodeJS.ProcessEnv}
 */
function applyOfflineEnv(env, options) {
  const next = { ...env };
  if (options.nodeBinDir) {
    const current = String(next.PATH ?? '').split(PATH_SEPARATOR).filter(Boolean);
    setEnv(
      next,
      'PATH',
      [options.nodeBinDir, ...current.filter((entry) => entry !== options.nodeBinDir)].join(PATH_SEPARATOR),
    );
  }
  if (options.homeDir) setEnv(next, 'DSH_HOME', options.homeDir);
  if (options.storeDir) {
    setEnv(next, 'npm_config_store_dir', options.storeDir);
    // Prefer the bundled store; fall back to the registry when it is not enough.
    setEnv(next, 'npm_config_prefer_offline', 'true');
  }
  setEnv(next, 'DSH_D_OFFLINE', '1');
  return next;
}

module.exports = {
  SEED_MARKER,
  VENDOR_ENV,
  applyOfflineEnv,
  copyTree,
  describeVendor,
  preparePnpmStore,
  readManifest,
  resolveVendorDir,
  seedDshHome,
};
