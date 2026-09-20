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
const http = require('node:http');

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
/** Which shell tab is showing: the embedded dsh Web view, or the market. */
let activeTab = 'dsh';
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

/**
 * The embedded dsh Web view is shown only on the DSH tab, while dsh runs, and
 * when the user has not hidden it to read the log panel.
 */
function shouldShowEmbedded(state) {
  return Boolean(
    state?.phase === 'running' && state.server?.url && activeTab === 'dsh' && !guiHiddenByUser,
  );
}

/** Reflect the shell tab + phase onto the embedded GUI view. */
function syncGuiView(state) {
  if (shouldShowEmbedded(state)) {
    attachGuiView();
    loadGui(state.server.url);
    guiView.setVisible(true);
    return;
  }
  detachGuiView();
  if (state?.phase !== 'running') {
    guiHiddenByUser = false;
    guiLoadedUrl = null;
  }
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

  ipcMain.handle('dsh:set-active-tab', (_event, tab) => {
    activeTab = tab === 'market' ? 'market' : 'dsh';
    // Switching tabs is what reveals the market or the dsh Web view.
    syncGuiView(controller.getState());
    return activeTab;
  });

  ipcMain.handle('market:load', async () => {
    try {
      return await controller.getMarket();
    } catch (error) {
      reportError('读取插件市场失败', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error), rows: [], localOnly: [] };
    }
  });

  ipcMain.handle('market:installed', () => {
    try {
      return controller.getInstalledPlugins();
    } catch (error) {
      reportError('读取已安装插件失败', error);
      return { profile: controller.profile, plugins: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('market:install', (_event, payload) => {
    // Fire and forget: progress arrives through the state stream.
    controller
      .installPlugin({ packageName: payload?.packageName, version: payload?.version ?? null })
      .catch((error) => reportError('安装插件失败', error));
    return controller.getState();
  });

  ipcMain.handle('market:cancel', () => {
    controller.cancelPluginAction();
    return controller.getState();
  });

  ipcMain.handle('market:setup-pnpm', async () => {
    try {
      await controller.setupPnpm();
    } catch (error) {
      reportError('配置 pnpm 失败', error);
    }
    return controller.getState();
  });

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
    const panelCount = await win.webContents.executeJavaScript(
      '({ phases: document.querySelectorAll(".panel[data-phase]").length, market: document.querySelectorAll(".panel-market").length })',
    );
    record(
      '界面面板已渲染（8 个阶段面板 + 市场面板）',
      panelCount.phases === 8 && panelCount.market === 1,
      JSON.stringify(panelCount),
    );
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

    console.log('5. 顶部 tab 与插件市场');
    const tabs = await win.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll(".tab[data-tab]")).map((t) => t.dataset.tab)',
    );
    record('顶部有两个大 tab', tabs.join(',') === 'dsh,market', tabs.join(','));
    const initialPanels = await win.webContents.executeJavaScript(
      '({ dsh: document.querySelector(".panel[data-phase].active")?.dataset.phase ?? null, market: document.querySelector(".panel-market").classList.contains("active") })',
    );
    record('默认停在 DSH tab', initialPanels.market === false && Boolean(initialPanels.dsh), JSON.stringify(initialPanels));

    // A fixture catalog (served locally) keeps this test off the network.
    const fixtureCatalog = {
      schemaVersion: 1,
      updatedAt: '2026-09-20',
      plugins: [
        { name: 'dsh-file-explorer', package: '@jaxzhou/dsh-file-explorer', version: '0.1.5', summary: '文件标签', tags: ['文件'], license: 'MIT' },
        { name: 'dsh-mathmatic-symbol', package: '@jaxzhou/dsh-mathmatic-symbol', version: '0.1.2', summary: '公式图形', tags: ['公式'], license: 'MIT' },
      ],
    };
    const marketServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixtureCatalog));
    });
    await new Promise((resolve) => marketServer.listen(0, '127.0.0.1', resolve));
    const marketPort = marketServer.address().port;

    // The controller is only asked for the market here; nothing is installed.
    let installedFixtureVersion = '0.1.4';
    controller.marketUrl = `http://127.0.0.1:${marketPort}/plugins/index.json`;
    controller.runReadInstalled = () => ({
      profile: 'web',
      dir: '/tmp/self-test/profiles/web',
      exists: true,
      bundles: ['@jaxzhou/dsh-file-explorer'],
      plugins: [
        { package: '@jaxzhou/dsh-file-explorer', name: 'dsh-file-explorer', spec: installedFixtureVersion, source: 'registry', version: installedFixtureVersion, bundle: true },
        { package: '@jaxzhou/dsh-proxy-client', name: 'dsh-proxy-client', spec: '0.4.1', source: 'registry', version: '0.4.1', bundle: true },
      ],
      error: null,
    });

    const marketView = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('tab-market').click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        active: document.querySelector('.panel-market').classList.contains('active'),
        dshPanelHidden: document.querySelector('.panel[data-phase].active') === null,
        cards: document.querySelectorAll('.plugin-card').length,
        localRows: document.querySelectorAll('.local-row').length,
        sub: document.getElementById('tabMarketSub').textContent,
        stats: document.getElementById('marketStats').textContent,
        updateButtons: Array.from(document.querySelectorAll('.plugin-card button[data-action="plugin-install"]')).map((b) => b.textContent),
      };
    })()`);
    record('切到插件市场后阶段面板隐藏', marketView.active === true && marketView.dshPanelHidden === true, JSON.stringify(marketView));
    record('内嵌 dsh 视图在市场上隐藏', !guiView || guiView.getVisible() === false);
    record('市场渲染目录卡片', marketView.cards === 2, `cards=${marketView.cards}`);
    record('市场展示本地已装插件', marketView.localRows === 2, `localRows=${marketView.localRows}`);
    record('市场 tab 副标题含统计', /可更新/.test(marketView.sub), marketView.sub);
    record('有更新的插件显示更新按钮', marketView.updateButtons.some((text) => /更新/.test(text)), JSON.stringify(marketView.updateButtons));

    const marketData = await controller.getMarket();
    record('目录与本地状态合并正确', marketData.ok && marketData.rows.length === 2 && marketData.updates === 1, JSON.stringify({ ok: marketData.ok, updates: marketData.updates }));
    record('目录外本地插件单列', marketData.localOnly.length === 1 && marketData.localOnly[0].package === '@jaxzhou/dsh-proxy-client');

    // Install path with stubbed collaborators: no pnpm, no dsh, no restart.
    controller.detection = {
      dsh: { installed: true, version: '0.1.5-rc.2', command: '/nonexistent/dsh', error: null },
      node: { available: true, version: 'v24.0.0' },
      npm: { available: true, version: '11.0.0', command: '/nonexistent/npm' },
    };
    controller.runEnsurePnpm = async () => ({ ok: true, command: '/nonexistent/pnpm', installed: false, error: null });
    let pluginCommands = 0;
    controller.runPluginCommand = () => {
      pluginCommands += 1;
      return { promise: Promise.resolve({ ok: true, code: 0, output: 'added 1 package', error: null }), cancel: () => {} };
    };
    let restartCalls = 0;
    const originalRestart = controller.restart.bind(controller);
    controller.restart = async () => {
      restartCalls += 1;
      return undefined;
    };

    const installResult = await controller.installPlugin({ packageName: '@jaxzhou/dsh-file-explorer', version: '0.1.5' });
    installedFixtureVersion = '0.1.5';
    record('市场安装调用 dsh plugin', pluginCommands === 1 && installResult.ok === true, JSON.stringify(installResult));
    record('安装后自动重启 dsh（刷新 DSH Web）', restartCalls === 1, `restartCalls=${restartCalls}`);
    record('安装完成后状态收敛', controller.getState().pluginAction?.ok === true);

    // Market identifies the dsh it acts on (path + profile dir + pnpm).
    const runtimeLine = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('tab-market').click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { runtime: document.getElementById('marketRuntime').textContent, meta: document.getElementById('marketMeta').textContent };
    })()`);
    record(
      '市场显示 profile 目录与 dsh 路径',
      /profiles[\\/]web/.test(runtimeLine.runtime) && /dsh/.test(runtimeLine.runtime),
      runtimeLine.runtime,
    );

    // Missing pnpm must be visible and one click away from being fixed.
    // (Clear the previous install's result banner so this check is unambiguous.)
    controller.pluginAction = null;
    controller.detection = { ...controller.detection, pnpm: { available: false, version: null, command: null, error: 'PATH 中未找到 pnpm' } };
    controller.pnpmError = '自检：pnpm 不可用';
    controller.broadcast();
    const pnpmWarning = await win.webContents.executeJavaScript(`(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const banner = document.getElementById('marketBanner');
      return {
        visible: !banner.hidden,
        text: banner.textContent,
        hasSetup: Boolean(banner.querySelector('button[data-action="market-setup-pnpm"]')),
        runtime: document.getElementById('marketRuntime').textContent,
      };
    })()`);
    record('pnpm 不可用时市场给出告警', pnpmWarning.visible === true && /pnpm/.test(pnpmWarning.text), pnpmWarning.text);
    record('告警提供自动配置入口', pnpmWarning.hasSetup === true);
    record('运行信息行标出 pnpm 不可用', /pnpm 不可用/.test(pnpmWarning.runtime), pnpmWarning.runtime);

    let setupCalls = 0;
    controller.setupPnpm = async () => {
      setupCalls += 1;
      controller.detection = { ...controller.detection, pnpm: { available: true, version: '9.9.9', command: '/tmp/pnpm', error: null } };
      controller.pnpmError = null;
      controller.broadcast();
      return { ok: true };
    };
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('button[data-action="market-setup-pnpm"]').click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return true;
    })()`);
    record('点击后触发 pnpm 配置', setupCalls === 1, `setupCalls=${setupCalls}`);
    const afterSetup = await win.webContents.executeJavaScript(
      `({ hidden: document.getElementById('marketBanner').hidden, runtime: document.getElementById('marketRuntime').textContent })`,
    );
    record('配置成功后告警消失', afterSetup.hidden === true, JSON.stringify(afterSetup));
    record('运行信息行更新为 pnpm 可用', /pnpm 9\.9\.9|pnpm 可用/.test(afterSetup.runtime), afterSetup.runtime);

    const backToDsh = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('tab-dsh').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        market: document.querySelector('.panel-market').classList.contains('active'),
        dsh: document.querySelector('.panel[data-phase].active')?.dataset.phase ?? null,
      };
    })()`);
    record('切回 DSH tab 恢复阶段面板', backToDsh.market === false && backToDsh.dsh !== null, JSON.stringify(backToDsh));

    controller.restart = originalRestart;
    await new Promise((resolve) => marketServer.close(resolve));

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

  // Plugin market: render a synthetic catalog so the capture is deterministic
  // (no network, no dependence on what happens to be installed).
  const marketFixture = {
    meta: { profile: 'web', updatedAt: '2026-09-20', source: 'https://dsh.textwork.cn/plugins/index.json' },
    runtime: { profileDir: '~/.dsh/profiles/web', command: '/Users/you/.nvm/versions/node/v24.18.0/bin/dsh', version: '0.1.5-rc.2', private: false },
    installed: { profile: 'web', dir: '~/.dsh/profiles/web', exists: true, plugins: [] },
    rows: [
      {
        package: '@jaxzhou/dsh-file-explorer',
        name: 'dsh-file-explorer',
        version: '0.1.5',
        summary: '给 Harness 增加一个与「对话」「轨迹」并列的「文件」标签：左侧是工作区目录树，右侧按文件类型决定预览形态。',
        highlights: ['Markdown 渲染（GFM）、JSON 树、24 种语法高亮、图片与纯文本预览', 'HTML 在沙箱 iframe 中绘制，预览不执行脚本', '导出 PDF / Word；只读、无需配置、不落任何数据'],
        tags: ['文件', '预览', '工作区'],
        license: 'MIT',
        homepage: 'https://dsh.textwork.cn/plugins/dsh-file-explorer/',
        repository: 'https://github.com/jaxzhou/dsh-file-explorer',
        local: { package: '@jaxzhou/dsh-file-explorer', version: '0.1.4', bundle: true, source: 'registry', spec: '0.1.4' },
        status: 'update-available',
      },
      {
        package: '@jaxzhou/dsh-mathmatic-symbol',
        name: 'dsh-mathmatic-symbol',
        version: '0.1.2',
        summary: '给 agent 四个工具，把公式与图形变成可以直接放进报告、幻灯片、Word、PDF 的图片。',
        highlights: ['math_formula / math_figure / math_convert / math_document', '产物是自带字形轮廓的 SVG（不依赖字体）+ 可选 PNG'],
        tags: ['公式', '图形', '导出'],
        license: 'MIT',
        homepage: 'https://dsh.textwork.cn/plugins/dsh-mathmatic-symbol/',
        repository: 'https://github.com/jaxzhou/dsh-mathmatic-symbol',
        local: null,
        status: 'not-installed',
      },
    ],
    localOnly: [
      { package: '@jaxzhou/dsh-proxy-client', name: 'dsh-proxy-client', version: '0.4.1', spec: '0.4.1', source: 'registry', bundle: true },
    ],
  };
  const runningSample = samples.find((sample) => sample.state.phase === 'running');
  const runningState = { hostname: base.hostname, ...(runningSample?.state ?? { phase: 'running', statusText: 'DSH 已启动' }) };
  await win.webContents.executeJavaScript(
    `(() => {
       window.resetLog(${JSON.stringify(runningSample?.state?.logs ?? [])});
       market.loaded = true; market.loading = false; market.error = null;
       market.rows = ${JSON.stringify(marketFixture.rows)};
       market.localOnly = ${JSON.stringify(marketFixture.localOnly)};
       market.meta = ${JSON.stringify(marketFixture.meta)};
       market.runtime = ${JSON.stringify(marketFixture.runtime)};
       market.installed = ${JSON.stringify(marketFixture.installed)};
       window.render({ ...${JSON.stringify(runningState)}, pnpm: { available: true, version: '12.5.1', command: '/usr/bin/pnpm', error: null } });
       window.switchTab('market');
       return true;
     })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  {
    const image = await win.webContents.capturePage();
    const target = path.join(outDir, '08-market.png');
    fs.writeFileSync(target, image.toPNG());
    console.log(`captured ${target} (${image.getSize().width}x${image.getSize().height})`);
  }

  // Installing state: banner with progress + disabled buttons.
  await win.webContents.executeJavaScript(
    `(() => {
       const installed = { ...market.installed };
       window.render({ ...${JSON.stringify(runningState)}, pluginAction: { running: true, packages: '@jaxzhou/dsh-file-explorer', version: '0.1.5', step: '正在安装 @jaxzhou/dsh-file-explorer@0.1.5', profile: 'web' } });
       return true;
     })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  {
    const image = await win.webContents.capturePage();
    const target = path.join(outDir, '09-market-installing.png');
    fs.writeFileSync(target, image.toPNG());
    console.log(`captured ${target} (${image.getSize().width}x${image.getSize().height})`);
  }

  // Back to the DSH tab for the menu capture below.
  await win.webContents.executeJavaScript(`window.switchTab('dsh'); window.render(${JSON.stringify(runningState)}); true;`);
  await new Promise((resolve) => setTimeout(resolve, 250));

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
