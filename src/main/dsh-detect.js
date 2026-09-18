'use strict';

/**
 * Detect whether DeepSeek Harness (`dsh`, npm package `@deepseek-ai/dsh`) is
 * installed, and whether the Node.js/npm pair needed to install it is present.
 */

const fs = require('node:fs');
const path = require('node:path');

const { IS_WINDOWS, runCapture } = require('./shell-env');

/** npm package that provides the `dsh` command. */
const DSH_PACKAGE = '@deepseek-ai/dsh';
/** `dsh web` server that the desktop shell embeds. */
const DSH_WEB_PROFILE_ARGS = ['web', '--no-open'];

/**
 * Executable file names to try for `name` on this platform, in resolution order.
 *
 * On Windows this must follow PATHEXT exactly, because cmd.exe never runs an
 * extension-less file — and Node's Windows archive ships one: alongside
 * `npm.cmd` there is a bare `npm` POSIX shell wrapper, and a global npm install
 * likewise writes `dsh`, `dsh.cmd` and `dsh.ps1`. Returning the bare `npm`
 * would hand back a shell script that Windows cannot execute, so npm (and dsh)
 * would look broken on a machine where both are perfectly fine.
 */
function candidateNames(name) {
  if (!IS_WINDOWS) return [name];
  const extensions = String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  const names = [];
  for (const extension of extensions) {
    // cmd.exe tries the extension as listed, then lower-cased on a
    // case-insensitive filesystem; both spellings keep the PATHEXT order.
    names.push(`${name}${extension}`, `${name}${extension.toLowerCase()}`);
  }
  return names;
}

/**
 * Find an executable by scanning PATH, without spawning a shell.
 *
 * @param {string} name command name, e.g. `dsh`.
 * @param {NodeJS.ProcessEnv} env environment whose PATH is searched.
 * @returns {string|null} absolute path, or null when not found.
 */
function findExecutable(name, env = process.env) {
  const separator = IS_WINDOWS ? ';' : ':';
  const dirs = String(env.PATH ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dir of dirs) {
    for (const candidate of candidateNames(name)) {
      const full = path.join(dir, candidate);
      try {
        if (!fs.statSync(full).isFile()) continue;
        if (!IS_WINDOWS) fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* not this one */
      }
    }
  }
  return null;
}

/** First semver-looking token in a version banner, tolerating a leading `v`. */
function parseVersion(text) {
  const match = String(text ?? '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

/** Ask a binary for its version; null when it does not run or does not answer. */
async function probeVersion(command, env, args = ['--version'], timeoutMs = 20_000) {
  const result = await runCapture(command, args, { env, timeoutMs });
  if (!result.ok) {
    return { ok: false, version: null, error: result.error ?? result.stderr.trim() ?? `exit ${result.code}` };
  }
  return { ok: true, version: parseVersion(result.stdout) ?? parseVersion(result.stderr), error: null };
}

/** Read the version of an npm package installed in a global node_modules root. */
function readInstalledPackageVersion(root, packageName) {
  if (!root) return null;
  try {
    const manifest = path.join(root, ...packageName.split('/'), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return { version: parsed.version ?? null, manifest };
  } catch {
    return null;
  }
}

/**
 * Full environment report for the shell UI.
 *
 * @param {NodeJS.ProcessEnv} env environment resolved by `resolveShellEnv`.
 * @returns {Promise<object>} serializable detection snapshot.
 */
async function detectDsh(env) {
  const detection = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    packageName: DSH_PACKAGE,
    installArgs: ['install', '-g', DSH_PACKAGE],
    node: { available: false, version: null, command: null, error: null },
    npm: { available: false, version: null, command: null, error: null, globalRoot: null, globalBin: null },
    dsh: { installed: false, version: null, command: null, error: null, packageManifest: null, viaPath: false },
  };

  // --- node -----------------------------------------------------------------
  const nodeCommand = findExecutable('node', env);
  if (nodeCommand) {
    const probe = await probeVersion(nodeCommand, env);
    detection.node = {
      available: probe.ok,
      version: probe.version,
      command: nodeCommand,
      error: probe.error,
    };
  } else {
    detection.node.error = 'PATH 中未找到 node';
  }

  // --- npm ------------------------------------------------------------------
  const npmCommand = findExecutable('npm', env);
  if (npmCommand) {
    // npm is a .cmd shim on Windows and can be slow to start on a cold machine.
    const probe = await probeVersion(npmCommand, env, ['--version'], 60_000);
    detection.npm = {
      ...detection.npm,
      available: probe.ok,
      version: probe.version,
      command: npmCommand,
      error: probe.error,
    };
    if (probe.ok) {
      const [root, prefix] = await Promise.all([
        runCapture(npmCommand, ['root', '-g'], { env, timeoutMs: 20_000 }),
        runCapture(npmCommand, ['prefix', '-g'], { env, timeoutMs: 20_000 }),
      ]);
      const globalRoot = root.stdout.trim() || null;
      const globalPrefix = prefix.stdout.trim() || null;
      detection.npm.globalRoot = globalRoot;
      detection.npm.globalBin = globalPrefix ? (IS_WINDOWS ? globalPrefix : path.join(globalPrefix, 'bin')) : null;
    }
  } else {
    detection.npm.error = 'PATH 中未找到 npm';
  }

  // --- dsh ------------------------------------------------------------------
  const dshCommand = findExecutable('dsh', env);
  if (dshCommand) {
    const probe = await probeVersion(dshCommand, env, ['--version'], 60_000);
    detection.dsh.command = dshCommand;
    detection.dsh.viaPath = true;
    if (probe.ok) {
      detection.dsh.installed = true;
      detection.dsh.version = probe.version;
    } else {
      detection.dsh.error = `已找到 ${dshCommand}，但执行 \`dsh --version\` 失败：${probe.error}`;
    }
  } else {
    detection.dsh.error = 'PATH 中未找到 dsh 命令';
  }

  // The manifest tells us the installed version even when the shim is off PATH.
  const installed = readInstalledPackageVersion(detection.npm.globalRoot, DSH_PACKAGE);
  if (installed) {
    detection.dsh.packageManifest = installed.manifest;
    if (!detection.dsh.version) detection.dsh.version = installed.version;
    if (!detection.dsh.installed && detection.npm.globalBin) {
      detection.dsh.error = `已在 ${installed.manifest} 发现 ${DSH_PACKAGE}，但 PATH 中无法执行 dsh（全局 bin：${detection.npm.globalBin}）`;
    }
  }

  return detection;
}

module.exports = {
  DSH_PACKAGE,
  DSH_WEB_PROFILE_ARGS,
  candidateNames,
  detectDsh,
  findExecutable,
  parseVersion,
  readInstalledPackageVersion,
};
