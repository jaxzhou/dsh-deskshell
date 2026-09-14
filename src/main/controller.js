'use strict';

/**
 * The shell's state machine.
 *
 *   checking → (no-node | missing-dsh | ready-to-start) → installing → starting → running
 *
 * It owns detection, the npm install, the `dsh web` child and the log ring
 * buffer, and broadcasts a serializable snapshot to the renderer. Nothing in
 * here touches Electron, so it is unit-testable under plain Node.
 */

const { EventEmitter } = require('node:events');
const os = require('node:os');

const { DSH_PACKAGE, detectDsh } = require('./dsh-detect');
const { installDsh } = require('./dsh-install');
const { DshServer } = require('./dsh-server');
const { resolveShellEnv } = require('./shell-env');

/** How many log lines to keep for a freshly-mounted renderer. */
const LOG_LIMIT = 600;
/** Renderer log lines replayed inside `getState()`. */
const LOG_REPLAY = 200;
/** Progress arrives per fetched package: coalesce broadcasts. */
const BROADCAST_INTERVAL_MS = 120;

class ShellController extends EventEmitter {
  /**
   * @param {{
   *   cwd?: string,
   *   port?: number,
   *   startDelayMs?: number,
   *   detect?: typeof detectDsh,
   *   install?: typeof installDsh,
   * }} [options] `detect`/`install` are injectable so the whole flow can be
   *   exercised against fixtures without touching the real npm or dsh.
   */
  constructor(options = {}) {
    super();
    this.cwd = options.cwd ?? os.homedir();
    this.port = options.port ?? 0;
    this.startDelayMs = options.startDelayMs ?? 350;
    this.detect = options.detect ?? detectDsh;
    this.runInstall = options.install ?? installDsh;

    /** @type {NodeJS.ProcessEnv|null} */
    this.env = null;
    this.shellNotes = [];
    /** @type {object|null} */
    this.detection = null;
    /** @type {{promise: Promise<object>, cancel: () => void}|null} */
    this.installHandle = null;
    /** @type {object|null} */
    this.installSnapshot = null;
    /** @type {DshServer|null} */
    this.server = null;

    this.phase = 'checking';
    this.statusText = '正在检测 DeepSeek Harness…';
    /** @type {{message: string, hint: string|null}|null} */
    this.error = null;
    this.serverUrl = null;
    this.serverPort = null;

    this.logs = [];
    this.checkToken = 0;
    this.broadcastTimer = null;
    this.disposed = false;
  }

  // ---------------------------------------------------------------- broadcast

  /** Serializable snapshot the renderer renders from. */
  getState() {
    const serverRunning = Boolean(this.server?.running);
    return {
      phase: this.phase,
      statusText: this.statusText,
      hostname: os.hostname(),
      cwd: this.cwd,
      shellNotes: this.shellNotes,
      detection: this.detection,
      install: this.installHandle || this.installSnapshot
        ? { ...(this.installSnapshot ?? { percent: 0, phase: '准备安装', detail: '' }), running: Boolean(this.installHandle) }
        : null,
      server: {
        running: serverRunning,
        url: this.serverUrl,
        port: this.serverPort,
        startedAt: this.server?.startedAt ?? null,
      },
      error: this.error,
      logs: this.logs.slice(-LOG_REPLAY),
    };
  }

  /** Push a log line to the ring buffer and to the renderer. */
  pushLog(entry) {
    const record = { ts: Date.now(), stream: entry.stream ?? 'system', line: entry.line ?? '' };
    this.logs.push(record);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.emit('log', record);
  }

  /** Coalesced state broadcast (progress can fire hundreds of times a second). */
  scheduleBroadcast() {
    if (this.broadcastTimer || this.disposed) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit('state', this.getState());
    }, BROADCAST_INTERVAL_MS);
    if (typeof this.broadcastTimer.unref === 'function') this.broadcastTimer.unref();
  }

  /** Immediate broadcast; the renderer's next paint has the fresh state. */
  broadcast() {
    if (this.disposed) return;
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.emit('state', this.getState());
  }

  /** @private */
  setPhase(phase, statusText) {
    this.phase = phase;
    if (statusText) this.statusText = statusText;
    this.scheduleBroadcast();
  }

  // ---------------------------------------------------------------- detection

  /**
   * Resolve the login environment (once) and detect node/npm/dsh.
   * @param {{autostart?: boolean}} [options]
   */
  async check(options = {}) {
    const { autostart = true } = options;
    const token = (this.checkToken += 1);

    this.error = null;
    this.setPhase('checking', '正在检测 DeepSeek Harness…');
    this.broadcast();

    if (!this.env) {
      const resolved = await resolveShellEnv();
      if (token !== this.checkToken) return this.detection;
      this.env = resolved.env;
      this.shellNotes = resolved.notes;
      this.pushLog({ stream: 'system', line: `环境：${resolved.notes.join('；')}` });
    }

    const detection = await this.detect(this.env);
    if (token !== this.checkToken) return this.detection;
    this.detection = detection;

    this.pushLog({
      stream: 'system',
      line: [
        `检测结果：node=${detection.node.version ?? '未找到'}`,
        `npm=${detection.npm.version ?? '未找到'}`,
        `dsh=${detection.dsh.installed ? detection.dsh.version : '未安装'}`,
        detection.dsh.command ? `(${detection.dsh.command})` : '',
      ].filter(Boolean).join(' '),
    });

    if (!detection.node.available || !detection.npm.available) {
      this.setPhase('no-node', '未检测到 Node.js / npm');
      this.broadcast();
      return detection;
    }

    if (!detection.dsh.installed) {
      this.setPhase('missing-dsh', `未检测到 ${DSH_PACKAGE}`);
      this.broadcast();
      return detection;
    }

    this.setPhase('ready-to-start', '已检测到 dsh，准备启动');
    this.broadcast();

    if (autostart) await this.start();
    return detection;
  }

  // ------------------------------------------------------------------ install

  /** Run `npm install -g @deepseek-ai/dsh`, then re-detect and start it. */
  async install() {
    if (this.installHandle) return;

    const detection = this.detection ?? (await this.check({ autostart: false }));
    if (!detection?.npm?.available) {
      this.error = { message: 'npm 不可用，无法安装 dsh', hint: '请先安装 Node.js（自带 npm），然后点击“重新检测”。' };
      this.setPhase('no-node', '未检测到 Node.js / npm');
      this.broadcast();
      return;
    }

    this.error = null;
    this.installSnapshot = { percent: 0, phase: '准备安装', detail: '', fetched: 0, packages: 0, done: false, failed: false };
    this.setPhase('installing', `正在安装 ${DSH_PACKAGE}…`);
    this.broadcast();

    const handle = this.runInstall({
      npmCommand: detection.npm.command,
      env: this.env,
      cwd: this.cwd,
      onLog: (entry) => this.pushLog(entry),
      onProgress: (snapshot) => {
        this.installSnapshot = snapshot;
        this.scheduleBroadcast();
      },
    });
    this.installHandle = handle;

    const result = await handle.promise;
    this.installHandle = null;
    this.installSnapshot = {
      ...(this.installSnapshot ?? { percent: 0, phase: '安装完成', detail: '' }),
      ...(result.ok
        ? { percent: 100, phase: '安装完成' }
        : result.cancelled
          ? { phase: '已取消' }
          : { phase: '安装失败' }),
      done: result.ok,
      failed: !result.ok && !result.cancelled,
    };

    if (result.cancelled) {
      this.setPhase('missing-dsh', '安装已取消');
      this.broadcast();
      return;
    }

    if (!result.ok) {
      this.error = {
        message: `dsh 安装失败（npm 退出码 ${result.code ?? '未知'}）`,
        hint: result.hint ?? '请查看安装日志了解详情。',
      };
      this.setPhase('error', '安装失败');
      this.broadcast();
      return;
    }

    this.pushLog({ stream: 'system', line: '安装完成，重新检测并启动 dsh…' });
    // A fresh install usually lands in a global bin dir: re-resolve PATH too.
    this.env = null;
    await this.check({ autostart: true });
  }

  /** Cancel a running install. */
  cancelInstall() {
    if (!this.installHandle) return;
    this.pushLog({ stream: 'system', line: '用户取消了安装' });
    this.installHandle.cancel();
    this.broadcast();
  }

  // -------------------------------------------------------------------- start

  /** Spawn `dsh web --no-open` and wait for its authenticated URL. */
  async start() {
    if (this.server?.running) return;

    if (!this.detection?.dsh?.installed) {
      await this.check({ autostart: false });
      if (!this.detection?.dsh?.installed) return;
    }

    this.error = null;
    this.serverUrl = null;
    this.serverPort = null;
    this.setPhase('starting', '正在启动 dsh web…');
    this.broadcast();

    // Give the renderer one frame to paint the "starting" screen before the
    // embedded GUI view covers it.
    await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));

    const server = new DshServer({
      dshCommand: this.detection.dsh.command,
      env: this.env,
      cwd: this.cwd,
      port: this.port,
    });
    this.server = server;

    server.on('log', (entry) => this.pushLog(entry));
    // Every other event is ignored once this instance is no longer the current
    // server: a restart must not have a dying child reset the phase.
    const isCurrent = () => this.server === server;
    server.on('status', (text) => {
      if (!isCurrent()) return;
      this.statusText = text;
      this.scheduleBroadcast();
    });
    server.on('listening', ({ port }) => {
      if (!isCurrent()) return;
      this.statusText = `端口 ${port} 已监听，等待鉴权地址…`;
      this.scheduleBroadcast();
    });
    server.on('url', ({ url, port }) => {
      if (!isCurrent()) return;
      this.serverUrl = url;
      this.serverPort = port;
      this.error = null;
      this.setPhase('running', 'DSH 已启动');
      this.broadcast();
    });
    server.on('error', ({ message, hint }) => {
      if (!isCurrent()) return;
      this.error = { message, hint: hint ?? null };
      this.setPhase('error', 'dsh 启动失败');
      this.broadcast();
    });
    server.on('exit', ({ code, signal, expected }) => {
      if (!isCurrent()) return;
      this.serverUrl = null;
      this.serverPort = null;
      if (expected) {
        this.setPhase('ready-to-start', 'dsh 已停止');
        this.broadcast();
        return;
      }
      this.error = {
        message: `dsh 进程已退出（code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}）`,
        hint: '请查看日志中的报错信息，然后重试启动。',
      };
      this.setPhase('error', 'dsh 已退出');
      this.broadcast();
    });

    server.start();
    this.broadcast();
  }

  /** Stop the `dsh web` child. */
  async stopServer(options = {}) {
    const { silent = false } = options;
    const server = this.server;
    this.server = null;
    this.serverUrl = null;
    this.serverPort = null;
    if (server) await server.stop();
    if (!silent) {
      this.setPhase('ready-to-start', 'dsh 已停止');
      this.broadcast();
    }
  }

  /** Stop and start again (used by the toolbar's 重启 button). */
  async restart() {
    await this.stopServer({ silent: true });
    this.pushLog({ stream: 'system', line: '正在重启 dsh…' });
    await this.start();
  }

  /**
   * Retry whatever failed: re-install when dsh is still missing, restart the
   * server when it is installed, and re-detect when even npm is unusable.
   */
  async retry() {
    const detection = this.detection ?? (await this.check({ autostart: false }));
    if (!detection?.npm?.available) {
      await this.check({ autostart: false });
      return;
    }
    if (!detection.dsh.installed) {
      await this.install();
      return;
    }
    await this.start();
  }

  /** Release every resource; called on app quit. */
  async dispose() {
    this.disposed = true;
    this.checkToken += 1;
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.installHandle) {
      try {
        this.installHandle.cancel();
      } catch {
        /* already gone */
      }
      this.installHandle = null;
    }
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
    this.removeAllListeners();
  }
}

module.exports = { ShellController, LOG_LIMIT, LOG_REPLAY };
