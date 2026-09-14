'use strict';

/**
 * Resolve the environment a *desktop* app is missing.
 *
 * A GUI app launched from Finder/Dock does not inherit the login shell's
 * environment, so `node`, `npm` and `dsh` (usually installed through nvm,
 * Homebrew or volta) are invisible even though they work in a terminal. This
 * module rebuilds a usable `PATH` by asking the user's login shell, adding the
 * well-known install locations, and asking npm where its global prefix lives.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const PATH_SEPARATOR = IS_WINDOWS ? ';' : ':';

/**
 * Run a command and capture its output. Never rejects: a missing binary, a
 * non-zero exit or a timeout is reported in the resolved object instead.
 *
 * @param {string} command absolute path or bare name of the executable.
 * @param {string[]} args arguments.
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, code: number|string|null, stdout: string, stderr: string, error: string|null}>}
 */
function runCapture(command, args, options = {}) {
  const { env = process.env, cwd, timeoutMs = 10_000 } = options;
  // Since Node 18.20/20.12 a `.cmd`/`.bat` shim cannot be spawned without a
  // shell on Windows, so npm/dsh probes must go through cmd.exe there.
  const shell = needsShell(command);
  return new Promise((resolve) => {
    try {
      execFile(
        shell ? shellCommandFor(command) : command,
        args,
        {
          env,
          cwd,
          shell,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            code: error ? (typeof error.code === 'number' ? error.code : String(error.code ?? 'error')) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: error ? String(error.message) : null,
          });
        },
      );
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** Split a PATH-like string into non-empty entries. */
function splitPath(value) {
  return String(value ?? '')
    .split(PATH_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Keep the first occurrence of every entry, preserving order. */
function dedupe(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const normalized = IS_WINDOWS ? entry.toLowerCase() : entry;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(entry);
  }
  return result;
}

/** True for the Windows shim types that cannot be spawned without a shell. */
function needsShell(command) {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(String(command));
}

/**
 * Quote a command for `shell: true` on Windows.
 *
 * Node joins `file` and `args` with spaces before handing the line to
 * `cmd.exe /d /s /c`, so an unquoted `C:\\Program Files\\nodejs\\npm.cmd`
 * would be split at the space.
 */
function shellCommandFor(command) {
  if (!IS_WINDOWS) return command;
  return /\s/.test(String(command)) ? `"${command}"` : command;
}

/** Existing directories only: keeps the spawned child's PATH clean. */
function existingDirs(entries) {
  const result = [];
  for (const entry of entries) {
    try {
      if (fs.statSync(entry).isDirectory()) result.push(entry);
    } catch {
      /* absent: skip */
    }
  }
  return result;
}

/** Compare two nvm version directory names, newest first. */
function compareNodeVersionsDesc(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const na = Number.isFinite(pa[index]) ? pa[index] : 0;
    const nb = Number.isFinite(pb[index]) ? pb[index] : 0;
    if (na !== nb) return nb - na;
  }
  return 0;
}

/** Best-effort list of every nvm-managed node bin directory, newest first. */
function nvmBinDirs(home) {
  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  let names;
  try {
    names = fs.readdirSync(versionsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('v'))
    .sort(compareNodeVersionsDesc)
    .map((name) => path.join(versionsDir, name, 'bin'));
}

/**
 * Directories worth searching even when the login shell says nothing about
 * them: the usual per-user and system package-manager locations.
 */
function guessDirs(home) {
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(localAppData, 'Programs', 'nodejs'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
      path.join(home, '.volta', 'bin'),
      path.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    ...nvmBinDirs(home),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

/**
 * Read the PATH a login shell would export.
 *
 * @param {string} shell absolute shell path.
 * @param {NodeJS.ProcessEnv} baseEnv environment to run the probe in.
 * @param {number} timeoutMs probe timeout.
 */
async function loginShellPath(shell, baseEnv, timeoutMs) {
  const probe = await runCapture(shell, ['-ilc', 'printf "%s" "$PATH"'], { env: baseEnv, timeoutMs });
  const value = probe.stdout.trim();
  if (!value) return { ok: false, reason: probe.error ?? probe.stderr.trim() ?? 'no output' };
  return { ok: true, dirs: splitPath(value) };
}

/** Where npm keeps globally installed binaries, when npm can tell us. */
async function npmGlobalBinDir(env, timeoutMs) {
  const npm = IS_WINDOWS ? 'npm.cmd' : 'npm';
  const prefix = await runCapture(npm, ['prefix', '-g'], { env, timeoutMs });
  const dir = prefix.stdout.trim();
  if (!prefix.ok || !dir) return null;
  return IS_WINDOWS ? dir : path.join(dir, 'bin');
}

/**
 * Build the environment used to detect and spawn `node`, `npm` and `dsh`.
 *
 * @param {{home?: string, baseEnv?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 * @returns {Promise<{env: NodeJS.ProcessEnv, dirs: string[], shell: string|null, notes: string[]}>}
 */
async function resolveShellEnv(options = {}) {
  const {
    home = os.homedir(),
    baseEnv = process.env,
    timeoutMs = 8_000,
  } = options;

  const notes = [];
  const dirs = [];
  let shell = null;

  if (!IS_WINDOWS) {
    const candidates = [baseEnv.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    shell = candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) ?? '/bin/sh';

    const login = await loginShellPath(shell, baseEnv, timeoutMs);
    if (login.ok) {
      dirs.push(...login.dirs);
      notes.push(`PATH 来自登录 shell：${shell} -ilc`);
    } else {
      notes.push(`登录 shell 探测失败（${login.reason}），改用常见安装目录`);
    }
  } else {
    notes.push('Windows：使用进程环境变量与常见安装目录');
  }

  dirs.push(...guessDirs(home));
  dirs.push(...splitPath(baseEnv.PATH));

  // npm's global prefix is authoritative for where the `dsh` shim lands.
  const provisionalEnv = { ...baseEnv, PATH: dedupe(existingDirs(dirs)).join(PATH_SEPARATOR) };
  const npmBin = await npmGlobalBinDir(provisionalEnv, timeoutMs);
  if (npmBin) {
    // Kept even when it does not exist yet: the install we are about to run
    // creates it, and the very next detection must already see it.
    dirs.unshift(npmBin);
    notes.push(`npm 全局目录：${npmBin}`);
  } else {
    notes.push('未能通过 `npm prefix -g` 解析全局目录');
  }

  const env = { ...baseEnv, PATH: dedupe(existingDirs(dirs)).join(PATH_SEPARATOR) };
  return { env, dirs: dedupe(dirs), shell, notes };
}

module.exports = {
  IS_WINDOWS,
  PATH_SEPARATOR,
  dedupe,
  existingDirs,
  guessDirs,
  needsShell,
  npmGlobalBinDir,
  resolveShellEnv,
  runCapture,
  shellCommandFor,
  splitPath,
};
