'use strict';

/**
 * Install DeepSeek Harness globally with npm, streaming output and progress.
 */

const { spawn } = require('node:child_process');
const os = require('node:os');

const { DSH_PACKAGE } = require('./dsh-detect');
const { createInstallProgress } = require('./progress');
const { createLineSplitter, terminate } = require('./process-tree');
const { IS_WINDOWS } = require('./shell-env');

/** npm flags that give us a progress signal without drowning the log. */
const NPM_FLAGS = ['--no-fund', '--no-audit', '--loglevel=http'];

/**
 * Map a failed install's output to an actionable hint.
 * @param {string} log full install output.
 * @returns {string|null}
 */
function diagnoseFailure(log) {
  if (/EACCES|permission denied|EPERM|operation not permitted/i.test(log)) {
    return '权限不足：当前用户无法写入 npm 全局目录。推荐用 nvm 管理 Node（全局目录位于用户家目录），或改用 sudo 手动安装。';
  }
  if (/EBADENGINE|Unsupported engine|required.*node/i.test(log)) {
    return '当前 Node.js 版本不满足 dsh 的要求，请升级 Node.js 后重试。';
  }
  if (/E404|404 Not Found|is not in this registry/i.test(log)) {
    return `registry 中找不到 ${DSH_PACKAGE}。请检查 npm config get registry 是否指向可用的镜像源。`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|socket hang up/i.test(log)) {
    return '网络异常：无法访问 npm registry。请检查网络、代理或镜像源设置后重试。';
  }
  if (/ENOSPC/i.test(log)) {
    return '磁盘空间不足，请清理后重试。';
  }
  return null;
}

/**
 * Run `npm install -g @deepseek-ai/dsh`.
 *
 * @param {{
 *   npmCommand: string,
 *   env: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   version?: string|null,
 *   onLog?: (entry: {stream: 'stdout'|'stderr'|'system', line: string}) => void,
 *   onProgress?: (snapshot: object) => void,
 * }} options
 * @returns {{promise: Promise<{ok: boolean, code: number|string|null, cancelled: boolean, hint: string|null, command: string, output: string}>, cancel: () => void}}
 */
function installDsh(options) {
  const {
    npmCommand,
    env,
    cwd = os.homedir(),
    version = null,
    onLog = () => {},
    onProgress = () => {},
  } = options;

  const spec = version ? `${DSH_PACKAGE}@${version}` : DSH_PACKAGE;
  const args = ['install', '-g', spec, ...NPM_FLAGS];
  const progress = createInstallProgress();
  let cancelled = false;
  let output = '';
  /** Set once the child exists, so `cancel()` can reach it. */
  let child = null;

  const emitLog = (stream, line) => {
    if (!line.trim()) return;
    output += `${line}\n`;
    onLog({ stream, line });
    if (progress.feed(line)) onProgress(progress.snapshot());
  };

  onLog({ stream: 'system', line: `$ ${npmCommand} ${args.join(' ')}` });
  onProgress(progress.snapshot());

  const promise = new Promise((resolve) => {
    let spawned;
    try {
      // A `.cmd` shim on Windows must go through the shell to be executable.
      spawned = spawn(npmCommand, args, {
        cwd,
        env,
        shell: IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitLog('stderr', `无法启动 npm：${message}`);
      progress.finish(false);
      onProgress(progress.snapshot());
      resolve({ ok: false, code: null, cancelled, hint: '无法启动 npm，请确认 npm 已正确安装。', command: `${npmCommand} ${args.join(' ')}`, output });
      return;
    }

    child = spawned;
    const stdout = createLineSplitter((line) => emitLog('stdout', line));
    const stderr = createLineSplitter((line) => emitLog('stderr', line));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    child.on('error', (error) => {
      emitLog('stderr', `npm 进程错误：${error.message}`);
    });

    child.on('close', (code, signal) => {
      stdout.flush();
      stderr.flush();
      const ok = !cancelled && code === 0;
      progress.finish(ok);
      onProgress(progress.snapshot());
      if (cancelled) emitLog('system', '安装已取消');
      else if (ok) emitLog('system', `dsh 安装成功（npm 退出码 0）`);
      else emitLog('system', `npm 退出码 ${code ?? 'null'}${signal ? `，信号 ${signal}` : ''}`);

      resolve({
        ok,
        code: code ?? null,
        cancelled,
        hint: ok || cancelled ? null : diagnoseFailure(output),
        command: `${npmCommand} ${args.join(' ')}`,
        output,
      });
    });
  });

  const cancel = () => {
    cancelled = true;
    emitLog('system', '正在取消安装…');
    if (child) terminate(child, { onLog: (line) => emitLog('system', line) });
  };

  return { promise, cancel };
}

module.exports = { installDsh, diagnoseFailure, NPM_FLAGS };
