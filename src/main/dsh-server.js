'use strict';

/**
 * Supervise `dsh web`.
 *
 * `dsh web` binds a loopback port, then prints one line:
 *
 *     dsh web: http://127.0.0.1:53211/?token=… (LAN: http://… )
 *
 * That URL is the only way to reach the GUI: the token in it mints the browser
 * cookie the `/api` fence requires, so the shell waits for the line instead of
 * guessing a port. `--port 0` lets the OS pick a free port, which avoids every
 * "port already in use" failure.
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const os = require('node:os');

const { createLineSplitter, terminate } = require('./process-tree');
const { IS_WINDOWS, shellCommandFor } = require('./shell-env');

/** The canonical readiness line printed by `dsh web`. */
const READY_URL_PATTERN = /dsh web:\s*(https?:\/\/[^\s)]+)/;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * Extract the authenticated GUI URL from one output line.
 * @param {string} line
 * @returns {{url: string, port: number|null, host: string}|null}
 */
function extractReadyUrl(line) {
  const match = String(line ?? '').replace(ANSI_PATTERN, '').match(READY_URL_PATTERN);
  if (!match) return null;
  try {
    const parsed = new URL(match[1]);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return { url: match[1], port, host: parsed.hostname };
  } catch {
    return null;
  }
}

/**
 * One TCP probe against a loopback port.
 * @returns {Promise<boolean>} true when something accepts the connection.
 */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Events: `log`, `status`, `listening`, `url`, `error`, `exit`, `stopped`.
 */
class DshServer extends EventEmitter {
  /**
   * @param {{
   *   dshCommand: string,
   *   env: NodeJS.ProcessEnv,
   *   cwd?: string,
   *   port?: number,
   *   extraArgs?: string[],
   *   readyTimeoutMs?: number,
   *   stopTimeoutMs?: number,
   * }} options
   */
  constructor(options) {
    super();
    this.dshCommand = options.dshCommand;
    this.env = options.env;
    this.cwd = options.cwd ?? os.homedir();
    this.port = options.port ?? 0;
    this.extraArgs = options.extraArgs ?? [];
    this.readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 6_000;

    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.url = null;
    this.resolvedPort = null;
    this.startedAt = null;
    this.stopping = false;
    this.readyTimer = null;
    this.probeTimer = null;
    this.probeStarted = false;
    /** True once we asked the process to stop: its exit is then not a crash. */
    this.exitExpected = false;
  }

  get running() {
    return this.child !== null;
  }

  /** Spawn the server. Safe to call once; use `stop()` then `start()` to cycle. */
  start() {
    if (this.child) return this;

    const args = ['web', '--no-open', '--port', String(this.port), ...this.extraArgs];
    this.startedAt = Date.now();
    this.stopping = false;
    this.exitExpected = false;
    this.url = null;
    this.resolvedPort = null;

    this.emit('log', { stream: 'system', line: `$ ${this.dshCommand} ${args.join(' ')}` });
    this.emit('log', { stream: 'system', line: `工作目录：${this.cwd}` });

    let child;
    try {
      // `.cmd` shims need a shell on Windows, and their path may contain spaces.
      child = spawn(shellCommandFor(this.dshCommand), args, {
        cwd: this.cwd,
        env: this.env,
        shell: IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', { message: `无法启动 dsh：${message}`, hint: '请确认 dsh 已正确安装，且当前用户有权执行它。' });
      return this;
    }

    this.child = child;
    this.emit('status', 'dsh 进程已启动，等待 Web 服务就绪…');

    const stdout = createLineSplitter((line) => this.#handleLine('stdout', line));
    const stderr = createLineSplitter((line) => this.#handleLine('stderr', line));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    child.on('error', (error) => {
      this.emit('error', {
        message: `dsh 进程错误：${error.message}`,
        hint: error.code === 'ENOENT' ? '找不到 dsh 可执行文件，请重新检测或重新安装。' : null,
      });
    });

    child.on('close', (code, signal) => {
      stdout.flush();
      stderr.flush();
      this.#clearTimers();
      const wasStopping = this.stopping || this.exitExpected;
      this.child = null;
      this.emit('log', { stream: 'system', line: `dsh 已退出（code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}）` });
      this.emit('exit', { code: code ?? null, signal: signal ?? null, expected: Boolean(wasStopping) });
    });

    this.readyTimer = setTimeout(() => {
      if (this.url || !this.child) return;
      this.emit('error', {
        message: `等待 dsh Web 地址超时（${Math.round(this.readyTimeoutMs / 1000)} 秒）`,
        hint: 'dsh 进程仍在运行但未打印 Web 地址。请查看日志中的报错，例如 profile 初始化失败或依赖缺失。',
      });
    }, this.readyTimeoutMs);
    if (typeof this.readyTimer.unref === 'function') this.readyTimer.unref();

    // With a fixed port we can report "listening" before the URL line arrives.
    if (this.port > 0) {
      this.probeTimer = setInterval(() => {
        if (this.probeStarted || !this.child) return;
        probePort(this.port).then((open) => {
          if (!open || this.probeStarted) return;
          this.probeStarted = true;
          clearInterval(this.probeTimer);
          this.emit('listening', { port: this.port });
          this.emit('log', { stream: 'system', line: `端口 ${this.port} 已监听，等待鉴权 URL…` });
        });
      }, 500);
      if (typeof this.probeTimer.unref === 'function') this.probeTimer.unref();
    }

    return this;
  }

  /** @private Feed one output line to the log stream and the readiness parser. */
  #handleLine(stream, line) {
    this.emit('log', { stream, line });
    const ready = extractReadyUrl(line);
    if (!ready || this.url) return;
    this.url = ready.url;
    this.resolvedPort = ready.port;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.emit('url', ready);
  }

  /** @private */
  #clearTimers() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.readyTimer = null;
    this.probeTimer = null;
  }

  /**
   * Stop the server: graceful signal first, SIGKILL after `stopTimeoutMs`.
   * @returns {Promise<{exited: boolean, forced: boolean}>}
   */
  async stop() {
    const child = this.child;
    this.#clearTimers();
    if (!child) {
      this.emit('stopped', {});
      return { exited: true, forced: false };
    }
    this.stopping = true;
    this.exitExpected = true;
    this.emit('status', '正在停止 dsh…');
    const result = await terminate(child, {
      timeoutMs: this.stopTimeoutMs,
      onLog: (line) => this.emit('log', { stream: 'system', line }),
    });
    this.child = null;
    this.url = null;
    this.resolvedPort = null;
    this.emit('stopped', result);
    return result;
  }
}

module.exports = { DshServer, extractReadyUrl, probePort, READY_URL_PATTERN };
