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
const path = require('node:path');

const { DSH_PACKAGE, detectDsh } = require('./dsh-detect');
const { installDsh } = require('./dsh-install');
const { DshServer } = require('./dsh-server');
const {
  MIN_NODE_MAJOR,
  defaultRuntimeRoot,
  findManagedRuntime,
  installNodeRuntime,
  managedRuntimeEnv,
  nodeDistSources,
  nodeMajor,
} = require('./node-runtime');
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
   *   runtimeRoot?: string,
   *   detect?: typeof detectDsh,
   *   install?: typeof installDsh,
   *   provisionRuntime?: typeof installNodeRuntime,
   * }} [options] `detect`/`install`/`provisionRuntime` are injectable so the
   *   whole flow can be exercised against fixtures without touching the real
   *   npm, dsh or the network.
   */
  constructor(options = {}) {
    super();
    this.cwd = options.cwd ?? os.homedir();
    this.port = options.port ?? 0;
    this.startDelayMs = options.startDelayMs ?? 350;
    /** Managed Node.js runtime root (inside the app's user-data directory). */
    this.runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
    this.detect = options.detect ?? detectDsh;
    this.runInstall = options.install ?? installDsh;
    this.runProvisionRuntime = options.provisionRuntime ?? installNodeRuntime;

    /** Set once a managed runtime exists; its bin dir leads every PATH we build. */
    this.managedRuntime = null;
    /** @type {{cancel: () => void}|null} */
    this.runtimeHandle = null;
    this.runtimeSnapshot = null;

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
      runtime: this.runtimeHandle || this.runtimeSnapshot
        ? {
            ...(this.runtimeSnapshot ?? { percent: 0, phase: '准备下载 Node.js', detail: '' }),
            running: Boolean(this.runtimeHandle),
            version: this.managedRuntime?.version ?? null,
            dir: this.managedRuntime?.dir ?? null,
          }
        : this.managedRuntime
          ? { percent: 100, phase: '运行时已就绪', detail: `Node.js ${this.managedRuntime.version}`, running: false, version: this.managedRuntime.version, dir: this.managedRuntime.dir }
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

  /** True when this detection cannot run dsh: no node/npm, or Node too old. */
  static runtimeGap(detection) {
    if (!detection?.node?.available || !detection?.npm?.available) return true;
    const major = nodeMajor(detection.node.version);
    return major === null || major < MIN_NODE_MAJOR;
  }

  /**
   * Resolve the login environment and let a managed runtime lead its PATH.
   * @private
   */
  async resolveEnvironment(token) {
    if (!this.managedRuntime) {
      const existing = findManagedRuntime(this.runtimeRoot);
      if (existing) {
        this.managedRuntime = existing;
        this.pushLog({ stream: 'system', line: `复用托管运行时：${existing.dir}（${existing.version}）` });
      }
    }
    if (!this.env) {
      const resolved = await resolveShellEnv();
      if (token !== this.checkToken) return false;
      this.env = resolved.env;
      this.shellNotes = resolved.notes;
      this.pushLog({ stream: 'system', line: `环境：${resolved.notes.join('；')}` });
    }
    // The managed runtime must lead PATH on every resolution — a fresh
    // `resolveShellEnv()` knows nothing about it.
    if (this.managedRuntime) {
      this.env = this.runtimeEnv(this.managedRuntime);
    }
    return true;
  }

  /**
   * Detect node/npm/dsh; provision a private Node.js runtime when the machine
   * cannot run dsh — missing node/npm, or a Node older than dsh supports.
   *
   * @param {{autostart?: boolean}} [options]
   */
  async check(options = {}) {
    const { autostart = true } = options;
    const token = (this.checkToken += 1);

    this.error = null;
    this.setPhase('checking', '正在检测 DeepSeek Harness…');
    this.broadcast();

    if (!(await this.resolveEnvironment(token))) return this.detection;

    let detection = await this.detect(this.env);
    if (token !== this.checkToken) return this.detection;

    this.pushLog({
      stream: 'system',
      line: [
        `检测结果：node=${detection.node.version ?? '未找到'}`,
        `npm=${detection.npm.version ?? '未找到'}`,
        `dsh=${detection.dsh.installed ? detection.dsh.version : '未安装'}`,
        detection.dsh.command ? `(${detection.dsh.command})` : '',
      ].filter(Boolean).join(' '),
    });

    // No usable runtime: fetch one instead of sending the user to nodejs.org.
    if (ShellController.runtimeGap(detection)) {
      const provisioned = await this.provisionRuntime(detection, token);
      if (token !== this.checkToken) return this.detection;
      if (!provisioned) return this.detection ?? detection;
      detection = this.detection;
    }

    this.detection = detection;

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

  // ------------------------------------------------------------------ runtime

  /**
   * Environment used for everything that runs inside the managed runtime.
   * @private
   */
  runtimeEnv(runtime) {
    return managedRuntimeEnv(this.env ?? process.env, runtime, {
      cacheDir: path.join(this.runtimeRoot, '.npm-cache'),
    });
  }

  /**
   * Download and configure a private Node.js runtime so dsh can run here.
   *
   * @param {object} detection current detection (may already be stale).
   * @param {number} token check token, so a superseded check stops early.
   * @returns {Promise<boolean>} true when node and npm are usable afterwards.
   * @private
   */
  async provisionRuntime(detection, token) {
    const tooOld = detection?.node?.available && nodeMajor(detection.node.version) < MIN_NODE_MAJOR;
    if (tooOld) {
      this.pushLog({
        stream: 'system',
        line: `系统 Node.js ${detection.node.version} 低于 dsh 需要的 v${MIN_NODE_MAJOR}，将配置独立的运行时`,
      });
    }

    // A managed runtime may already satisfy the requirement.
    const existing = findManagedRuntime(this.runtimeRoot);
    if (existing && nodeMajor(existing.version) >= MIN_NODE_MAJOR) {
      this.managedRuntime = existing;
      this.env = this.runtimeEnv(existing);
      const detected = await this.detect(this.env);
      if (token !== this.checkToken) return false;
      this.detection = detected;
      if (!ShellController.runtimeGap(detected)) {
        this.pushLog({ stream: 'system', line: `托管运行时可用：Node.js ${detected.node.version}` });
        return true;
      }
    }

    this.error = null;
    this.runtimeSnapshot = { percent: 0, phase: '准备下载 Node.js', detail: '' };
    this.setPhase('installing-node', '正在自动配置 Node.js 运行环境…');
    this.broadcast();

    const controller = new AbortController();
    const handle = this.runProvisionRuntime({
      root: this.runtimeRoot,
      // DSH_D_NODE_MIRROR / DSH_D_NODE_VERSION let a restricted network or a
      // managed fleet pin where and which Node.js is installed.
      version: String(process.env.DSH_D_NODE_VERSION ?? '').trim() || null,
      sources: nodeDistSources(),
      signal: controller.signal,
      onLog: (entry) => this.pushLog(entry),
      onProgress: (snapshot) => {
        this.runtimeSnapshot = snapshot;
        this.scheduleBroadcast();
      },
    });
    this.runtimeHandle = {
      cancel: () => {
        this.pushLog({ stream: 'system', line: '用户取消了运行时配置' });
        controller.abort();
      },
      promise: handle,
    };

    let result;
    try {
      result = await handle;
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error), hint: null };
    }
    if (token !== this.checkToken) return false;

    this.runtimeHandle = null;
    this.runtimeSnapshot = {
      ...(this.runtimeSnapshot ?? { percent: 0, phase: '', detail: '' }),
      ...(result.ok ? { percent: 100, phase: '运行时已就绪' } : { phase: '运行时配置失败' }),
      failure: result.ok ? null : result.error,
    };

    if (!result.ok) {
      this.error = {
        message: result.error,
        hint: result.hint ?? '可以手动安装 Node.js 后点击“重新检测”，或在有网络的环境下重试。',
      };
      this.setPhase('no-node', `Node.js 运行时配置失败`);
      this.broadcast();
      return false;
    }

    this.managedRuntime = result;
    // The managed npm's global prefix is pinned inside the managed directory,
    // so `npm install -g` there needs no administrator rights.
    this.env = this.runtimeEnv(result);
    // PATH changed: re-resolve so npm's own `prefix -g` is read from the new one.
    this.env = null;
    await this.resolveEnvironment(token);
    if (token !== this.checkToken) return false;

    const detected = await this.detect(this.env);
    if (token !== this.checkToken) return false;
    this.detection = detected;

    if (ShellController.runtimeGap(detected)) {
      this.error = {
        message: `配置完成后仍无法使用 node / npm`,
        hint: `请检查 ${result.dir} 是否完整，或删除该目录后重试。`,
      };
      this.setPhase('no-node', 'Node.js 运行时不可用');
      this.broadcast();
      return false;
    }

    this.pushLog({
      stream: 'system',
      line: `运行时已就绪：node ${detected.node.version} · npm ${detected.npm.version}（全局目录 ${detected.npm.globalBin ?? '未知'}）`,
    });
    return true;
  }

  /** Cancel an in-flight runtime download. */
  cancelRuntimeInstall() {
    if (!this.runtimeHandle) return;
    this.runtimeHandle.cancel();
    this.broadcast();
  }

  // ------------------------------------------------------------------ install

  /** Run `npm install -g @deepseek-ai/dsh`, then re-detect and start it. */
  async install() {
    if (this.installHandle) return;

    const detection = this.detection ?? (await this.check({ autostart: false }));
    if (ShellController.runtimeGap(detection)) {
      // No usable node/npm: provision one, then `check()` continues to here.
      this.pushLog({ stream: 'system', line: '缺少可用的 Node.js / npm，先自动配置运行时…' });
      await this.check({ autostart: true });
      return;
    }
    if (!detection.npm?.available) {
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
    // Missing or too-old Node: `check()` provisions the managed runtime.
    if (ShellController.runtimeGap(detection)) {
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
    if (this.runtimeHandle) {
      try {
        this.runtimeHandle.cancel();
      } catch {
        /* already gone */
      }
      this.runtimeHandle = null;
    }
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
    this.removeAllListeners();
  }
}

module.exports = { ShellController, LOG_LIMIT, LOG_REPLAY };
