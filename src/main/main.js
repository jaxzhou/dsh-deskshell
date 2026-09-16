'use strict';

/**
 * DSH-D — Electron main process.
 *
 * Launches the shell window, owns the {@link ShellController} state machine,
 * and embeds the running dsh Web GUI in a `WebContentsView` that sits below the
 * shell's own toolbar.
 */

const path = require('node:path');
const fs = require('node:fs');

const { BrowserWindow, WebContentsView, app, ipcMain, shell } = require('electron');

const { ShellController } = require('./controller');

const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const IS_DEV = process.argv.includes('--dev');
const SHOW_DEVTOOLS = IS_DEV || process.argv.includes('--devtools');
/** Smoke test: boots the window, checks detection and the embedded view, exits. */
const SELF_TEST = process.argv.includes('--self-test');
/** Dev aid: renders each shell phase to a PNG for review (`--capture-ui <dir>`). */
const CAPTURE_UI = process.argv.includes('--capture-ui');
/** Space the shell toolbar reserves; the renderer measures and refines it. */
const DEFAULT_INSET_TOP = 56;

// Portable / test runs can redirect Electron's own state directory.
if (process.env.DSH_D_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DSH_D_USER_DATA));
}

const controller = new ShellController({
  port: Number(process.env.DSH_D_PORT ?? 0) || 0,
  // Managed Node.js runtimes live beside the app's own data.
  runtimeRoot: path.join(app.getPath('userData'), 'runtime'),
});

/** @type {BrowserWindow|null} */
let win = null;
/** @type {WebContentsView|null} */
let guiView = null;
let guiAttached = false;
let guiInset = { top: DEFAULT_INSET_TOP };
let guiLoadedUrl = null;
let guiHiddenByUser = false;
let quitRequested = false;

// ------------------------------------------------------------------- helpers

/** Only ever hand real web URLs to the OS browser. */
function openExternal(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    shell.openExternal(url).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Report a swallowed async failure into the shell log. */
function reportError(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  controller.pushLog({ stream: 'stderr', line: `${scope}：${message}` });
}

/** Position the embedded GUI under the shell toolbar. */
function layoutGuiView() {
  if (!win || win.isDestroyed() || !guiView) return;
  const [width, height] = win.getContentSize();
  guiView.setBounds({
    x: 0,
    y: guiInset.top,
    width,
    height: Math.max(0, height - guiInset.top),
  });
}

/** Create (once) and show the embedded dsh GUI view. */
function attachGuiView() {
  if (!win || win.isDestroyed()) return;
  if (!guiView) {
    guiView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        partition: 'persist:dsh-gui',
      },
    });
    guiView.setBackgroundColor('#0b1220');
    // The GUI is a local web app: anything it tries to open goes to the browser.
    guiView.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    guiView.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* aborted */) return;
      controller.pushLog({ stream: 'stderr', line: `加载 DSH 界面失败（${code} ${description}）：${url}` });
    });
    guiView.webContents.on('render-process-gone', (_event, details) => {
      controller.pushLog({ stream: 'stderr', line: `DSH 界面渲染进程退出：${details.reason}` });
    });
  }
  if (!guiAttached) {
    win.contentView.addChildView(guiView);
    guiAttached = true;
  }
  layoutGuiView();
  guiView.setVisible(true);
}

/** Hide the GUI view without destroying its session (cookies survive restart). */
function detachGuiView() {
  if (guiView && guiAttached) guiView.setVisible(false);
}

/**
 * User-controlled visibility of the embedded GUI, so the shell's own log panel
 * can be read while dsh keeps running. Phase changes reset it.
 */
function setGuiVisible(visible) {
  guiHiddenByUser = !visible;
  if (!guiView) return guiHiddenByUser;
  guiView.setVisible(Boolean(visible));
  return guiHiddenByUser;
}

/** Load the authenticated dsh URL into the embedded view. */
function loadGui(url) {
  if (!guiView || !url || guiLoadedUrl === url) return;
  guiLoadedUrl = url;
  controller.pushLog({ stream: 'system', line: `加载 DSH 界面：${url.replace(/([?&]token=)[^&]+/i, '$1***')}` });
  guiView.webContents.loadURL(url).catch((error) => reportError('加载 DSH 界面失败', error));
}

/** Reflect the shell phase onto the embedded GUI view. */
function syncGuiView(state) {
  if (state.phase === 'running' && state.server?.url) {
    attachGuiView();
    loadGui(state.server.url);
    // The user asked to read the log panel: keep the GUI hidden until they return.
    if (guiHiddenByUser) guiView.setVisible(false);
    return;
  }
  detachGuiView();
  guiHiddenByUser = false;
  guiLoadedUrl = null;
}

// -------------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: 'DSH-D',
    backgroundColor: '#0b1220',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    // Both dev modes control their own visibility.
    if (SELF_TEST || CAPTURE_UI) return;
    win.show();
    if (SHOW_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('resize', layoutGuiView);
  win.on('closed', () => {
    win = null;
    // The child view dies with the window; a re-activated window attaches a
    // fresh one and must load the (still running) dsh URL again.
    guiView = null;
    guiAttached = false;
    guiLoadedUrl = null;
    guiHiddenByUser = false;
  });

  // The shell page is local: navigation and popups leave via the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternal(url);
    }
  });

  win.loadFile(RENDERER_INDEX).catch((error) => reportError('加载界面失败', error));
}

// ----------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('dsh:get-state', () => controller.getState());

  ipcMain.handle('dsh:check', async () => {
    await controller.check({ autostart: true }).catch((error) => reportError('检测失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:detect', async () => {
    await controller.check({ autostart: false }).catch((error) => reportError('检测失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:install', () => {
    controller.install().catch((error) => reportError('安装失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:cancel-install', () => {
    controller.cancelInstall();
    return controller.getState();
  });

  ipcMain.handle('dsh:install-node', () => {
    // Re-runs the flow; `check()` provisions the managed runtime because the
    // gap is a missing/too-old Node, then continues to the dsh install prompt.
    controller.check({ autostart: true }).catch((error) => reportError('配置 Node.js 运行时失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:cancel-node-install', () => {
    controller.cancelRuntimeInstall();
    return controller.getState();
  });

  ipcMain.handle('dsh:start', () => {
    controller.start().catch((error) => reportError('启动失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:stop', async () => {
    await controller.stopServer().catch((error) => reportError('停止失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:restart', () => {
    controller.restart().catch((error) => reportError('重启失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:retry', () => {
    controller.retry().catch((error) => reportError('重试失败', error));
    return controller.getState();
  });

  ipcMain.handle('dsh:reload-gui', () => {
    if (guiView && !guiView.webContents.isDestroyed()) guiView.webContents.reload();
    return true;
  });

  ipcMain.handle('dsh:set-gui-visible', (_event, visible) => setGuiVisible(Boolean(visible)));

  ipcMain.handle('dsh:open-external', (_event, url) => {
    const target = typeof url === 'string' && url ? url : controller.serverUrl;
    return openExternal(target);
  });

  ipcMain.handle('dsh:set-view-inset', (_event, inset) => {
    const top = Number(inset?.top);
    if (Number.isFinite(top)) {
      guiInset = { top: Math.max(0, Math.min(240, Math.round(top))) };
      layoutGuiView();
    }
    return guiInset;
  });

  ipcMain.handle('dsh:quit', () => {
    app.quit();
    return true;
  });
}

// ------------------------------------------------------------------ self-test

/**
 * `--self-test` boots the real Electron runtime, the preload bridge, the
 * renderer and the embedded view, then exits — without ever starting `dsh`, so
 * it is safe to run on a machine that is already using the Harness.
 */
async function runSelfTest() {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '  \u2713' : '  \u2717'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    console.log('DSH-D self-test');
    console.log('1. 渲染进程与 preload 桥');
    const bridge = await win.webContents.executeJavaScript(
      'typeof window.dshShell === "object" && typeof window.dshShell.getState === "function"',
    );
    record('preload 已注入 window.dshShell', bridge === true);
    const panels = await win.webContents.executeJavaScript('document.querySelectorAll(".panel").length');
    record('界面面板已渲染（含运行时配置面板）', panels === 8, `panels=${panels}`);
    const phase = await win.webContents.executeJavaScript('window.dshShell.getState().then((state) => state.phase)');
    record('渲染进程可读取状态', typeof phase === 'string', String(phase));
    const inset = await win.webContents.executeJavaScript('window.dshShell.setViewInset({ top: 64 }).then((v) => v.top)');
    record('IPC 往返正常 (setViewInset)', inset === 64, String(inset));
    const clipboard = await win.webContents.executeJavaScript(
      'Boolean(navigator.clipboard && typeof navigator.clipboard.writeText === "function")',
    );
    record('渲染进程具备剪贴板 API', clipboard === true);

    console.log('2. 主进程检测（不启动 dsh）');
    const detection = await controller.check({ autostart: false });
    record('node 可用', detection.node.available === true, String(detection.node.version));
    record('npm 可用', detection.npm.available === true, String(detection.npm.version));
    record('检测到 dsh', detection.dsh.installed === true, String(detection.dsh.version));
    record('未启动任何 dsh 进程', controller.server === null);

    console.log('3. 内嵌 dsh 界面视图');
    attachGuiView();
    layoutGuiView();
    record('WebContentsView 可创建并附加', Boolean(guiView) && guiAttached);
    const bounds = guiView.getBounds();
    record('视图尺寸有效', bounds.height > 0 && bounds.width > 0, JSON.stringify(bounds));
    detachGuiView();
    record('视图可隐藏', guiView.getVisible() === false);

    console.log('4. 工具栏：状态区与菜单');
    const layout = await win.webContents.executeJavaScript(`(() => {
      // Render a synthetic "running" snapshot so the running menu is measured.
      window.render({
        phase: 'running',
        statusText: 'DSH 已启动',
        hostname: 'self-test-host',
        detection: {
          platform: 'self-test',
          arch: 'x64',
          node: { available: true, version: 'v24.0.0' },
          npm: { available: true, version: '11.0.0', globalRoot: '/tmp/node_modules', globalBin: '/tmp/bin' },
          dsh: { installed: true, version: '9.9.9', command: '/tmp/bin/dsh' },
        },
        server: { running: true, url: 'http://127.0.0.1:1/?token=x', port: 51234 },
        logs: [],
      });
      window.openMenu(true);
      const menu = document.getElementById('menuList').getBoundingClientRect();
      const quit = document.getElementById('quitBtn').getBoundingClientRect();
      const toolbar = document.getElementById('toolbar').getBoundingClientRect();
      const result = {
        open: !document.getElementById('menuList').hidden,
        items: document.querySelectorAll('#menuList .menu-item').length,
        inline: document.querySelectorAll('#toolbarActions button').length,
        meta: document.getElementById('statusMeta').textContent,
        statusText: document.getElementById('statusText').textContent,
        menu: { left: Math.round(menu.left), right: Math.round(menu.right) },
        quit: { left: Math.round(quit.left) },
        toolbar: { right: Math.round(toolbar.right) },
      };
      window.openMenu(false);
      return result;
    })()`);
    record('菜单可展开且有操作项', layout.open === true && layout.items >= 6, `items=${layout.items}`);
    record('菜单不超出窗口', layout.menu.right <= layout.toolbar.right && layout.menu.left >= 0, JSON.stringify(layout.menu));
    record(
      '菜单不遮挡退出按钮',
      layout.menu.right <= layout.quit.left,
      `menu.right=${layout.menu.right} quit.left=${layout.quit.left}`,
    );
    record('调试操作不在工具栏内联显示', layout.inline === 0, `inline=${layout.inline}`);
    record(
      '状态区显示机器名与 dsh 版本',
      layout.meta.includes('self-test-host') && layout.meta.includes('9.9.9'),
      layout.meta,
    );
    record(
      '状态区不显示端口',
      !layout.meta.includes('51234') && !layout.statusText.includes('51234'),
      `${layout.statusText} | ${layout.meta}`,
    );

    await controller.dispose();
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\nself-test: ${results.length - failed}/${results.length} 通过`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (error) {
    console.error('self-test 异常：', error);
    app.exit(1);
  }
}

// -------------------------------------------------------------- ui capture

/** Synthetic snapshots used by `--capture-ui`, one per interesting phase. */
function captureSamples(detection) {
  const dshDetection = detection ?? {
    platform: process.platform,
    arch: process.arch,
    packageName: '@deepseek-ai/dsh',
    node: { available: true, version: 'v24.18.0' },
    npm: { available: true, version: '11.16.0', globalRoot: '/Users/you/.nvm/versions/node/v24.18.0/lib/node_modules', globalBin: '/Users/you/.nvm/versions/node/v24.18.0/bin' },
    dsh: { installed: false, version: null, command: null, error: 'PATH 中未找到 dsh 命令' },
  };

  return [
    {
      file: '01-checking.png',
      state: {
        phase: 'checking',
        statusText: '正在检测 DeepSeek Harness…',
        detection: null,
        install: null,
        server: { running: false, url: null, port: null },
        error: null,
        logs: [],
      },
    },
    {
      file: '02-missing-dsh.png',
      state: {
        phase: 'missing-dsh',
        statusText: '未检测到 @deepseek-ai/dsh',
        detection: { ...dshDetection, dsh: { ...dshDetection.dsh, installed: false } },
        install: null,
        server: { running: false, url: null, port: null },
        error: null,
        logs: [{ ts: Date.now(), stream: 'system', line: '环境：PATH 来自登录 shell：/bin/zsh -ilc；npm 全局目录：/Users/you/.nvm/versions/node/v24.18.0/bin' }],
      },
    },
    {
      file: '03-installing-node.png',
      state: {
        phase: 'installing-node',
        statusText: '正在自动配置 Node.js 运行环境…',
        detection: { ...dshDetection, node: { available: false, version: null }, npm: { available: false, version: null } },
        install: null,
        runtime: { percent: 43, phase: '下载 Node.js 运行时', detail: '22.4 / 51.7 MB', running: true },
        server: { running: false, url: null, port: null },
        error: null,
        logs: [
          { ts: Date.now(), stream: 'system', line: '检测结果：node=未找到 npm=未找到 dsh=未安装' },
          { ts: Date.now(), stream: 'system', line: 'Node.js 最新 LTS：v24.21.0（来自 nodejs.org）' },
          { ts: Date.now(), stream: 'system', line: '下载 https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz' },
        ],
      },
    },
    {
      file: '04-installing.png',
      state: {
        phase: 'installing',
        statusText: '正在安装 @deepseek-ai/dsh…',
        detection: { ...dshDetection, dsh: { ...dshDetection.dsh, installed: false } },
        install: { percent: 61, phase: '下载依赖包', detail: '已获取 148 个包', fetched: 148, packages: 0, running: true },
        server: { running: false, url: null, port: null },
        error: null,
        logs: [
          { ts: Date.now(), stream: 'system', line: '$ npm install -g @deepseek-ai/dsh --no-fund --no-audit --loglevel=http' },
          { ts: Date.now(), stream: 'stdout', line: 'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz 41ms (cache miss)' },
          { ts: Date.now(), stream: 'stdout', line: 'npm http fetch GET 200 https://registry.npmjs.org/cordis/-/cordis-4.0.2.tgz 12ms (cache miss)' },
          { ts: Date.now(), stream: 'stderr', line: 'npm warn deprecated rimraf@2.6.3: Rimraf versions prior to v4 are no longer supported' },
        ],
      },
    },
    {
      file: '05-running.png',
      state: {
        phase: 'running',
        statusText: 'DSH 已启动',
        detection: { ...dshDetection, dsh: { ...dshDetection.dsh, installed: true, version: '0.1.5-rc.2', command: '/Users/you/.nvm/versions/node/v24.18.0/bin/dsh', error: null } },
        install: null,
        server: { running: true, url: 'http://127.0.0.1:53211/?token=***', port: 53211 },
        error: null,
        logs: [{ ts: Date.now(), stream: 'system', line: '$ dsh web --no-open --port 0' }],
      },
    },
    {
      file: '06-error.png',
      state: {
        phase: 'error',
        statusText: '安装失败',
        detection: { ...dshDetection, dsh: { ...dshDetection.dsh, installed: false } },
        install: { percent: 34, phase: '安装失败', detail: 'npm error code EACCES', failed: true },
        server: { running: false, url: null, port: null },
        error: {
          message: 'dsh 安装失败（npm 退出码 243）',
          hint: '权限不足：当前用户无法写入 npm 全局目录。推荐用 nvm 管理 Node（全局目录位于用户家目录），或改用 sudo 手动安装。',
        },
        logs: [{ ts: Date.now(), stream: 'stderr', line: "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@deepseek-ai'" }],
      },
    },
  ];
}

/**
 * `--capture-ui <dir>` renders every shell phase and writes a PNG of each, so
 * the interface can be reviewed without a human at the screen. Dev aid only.
 */
async function runUiCapture() {
  const flagIndex = process.argv.indexOf('--capture-ui');
  const outDir = path.resolve(process.argv[flagIndex + 1] ?? path.join(process.cwd(), 'ui-preview'));
  fs.mkdirSync(outDir, { recursive: true });

  // A visible (but unfocused) window is required for a non-blank capture.
  win.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 600));

  const base = controller.getState();
  const samples = captureSamples(base.detection);
  for (const sample of samples) {
    const state = { hostname: base.hostname, ...sample.state };
    await win.webContents.executeJavaScript(
      `window.resetLog(${JSON.stringify(state.logs ?? [])}); window.render(${JSON.stringify(state)}); true;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await win.webContents.capturePage();
    const target = path.join(outDir, sample.file);
    fs.writeFileSync(target, image.toPNG());
    console.log(`captured ${target} (${image.getSize().width}x${image.getSize().height})`);
  }

  // The ⋮ menu is a surface of its own: capture it open.
  const running = samples.find((sample) => sample.state.phase === 'running');
  if (running) {
    await win.webContents.executeJavaScript(
      `window.render(${JSON.stringify({ hostname: base.hostname, ...running.state })}); window.openMenu(true); true;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    const image = await win.webContents.capturePage();
    const target = path.join(outDir, '07-menu.png');
    fs.writeFileSync(target, image.toPNG());
    console.log(`captured ${target} (${image.getSize().width}x${image.getSize().height})`);
  }

  app.exit(0);
}

// ------------------------------------------------------------------ lifecycle

function wireController() {
  controller.on('state', (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('dsh:state', state);
    syncGuiView(state);
  });
  controller.on('log', (entry) => {
    if (win && !win.isDestroyed()) win.webContents.send('dsh:log', entry);
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    wireController();
    registerIpc();
    createWindow();

    // Start the flow only once the renderer can actually receive the state.
    win.webContents.once('did-finish-load', () => {
      if (SELF_TEST) {
        runSelfTest().catch((error) => {
          console.error('self-test 异常：', error);
          app.exit(1);
        });
        return;
      }
      if (CAPTURE_UI) {
        runUiCapture().catch((error) => {
          console.error('capture-ui 异常：', error);
          app.exit(1);
        });
        return;
      }
      // A re-opened window (macOS activate) has no state change to wait for:
      // re-attach the GUI view for a dsh that is still running.
      syncGuiView(controller.getState());
      controller.check({ autostart: true }).catch((error) => reportError('检测失败', error));
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Killing the dsh child is asynchronous, so the first quit is deferred.
  app.on('before-quit', (event) => {
    if (quitRequested) return;
    quitRequested = true;
    event.preventDefault();
    Promise.resolve(controller.dispose())
      .catch(() => {})
      .finally(() => app.quit());
  });
}
