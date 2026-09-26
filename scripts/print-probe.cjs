'use strict';

/**
 * Probe how printing behaves inside a `WebContentsView` that mirrors the one
 * DSH-D embeds (contextIsolation + sandbox, no node integration).
 *
 * Checks, in order:
 *   1. does the print subsystem see the system printers
 *   2. does the renderer produce printable output (printToPDF)
 *   3. does `window.print()` from the *top* frame reach the system dialog
 *      (the call blocks the renderer while the dialog is open — that is the
 *      observable, since Electron exposes no print event)
 *   4. what a sandboxed iframe can do (the plugin renders HTML in one)
 *
 * Usage: ./node_modules/.bin/electron scripts/print-probe.cjs [--dialog]
 *        `--dialog` runs step 3, which opens the real system print sheet for a
 *        moment; without it the probe stays silent.
 */

const path = require('node:path');

const { app, BrowserWindow, WebContentsView } = require('electron');

// Keep Electron's own state inside the workspace when asked (sandboxed runs
// cannot write to the default userData directory).
if (process.env.DSH_D_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DSH_D_USER_DATA));
}

const WANT_DIALOG = process.argv.includes('--dialog');
const DIALOG_WAIT_MS = 3000;

const page = (body) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`)}`;

function log(...args) {
  console.log('[print-probe]', ...args);
}

/** Resolve after `ms`, or as soon as `promise` settles (whichever is first). */
function race(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ settled: true, value })).catch((error) => ({ settled: true, error: String(error) })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
  ]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  await win.loadURL(page('<h1>shell</h1>'));

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'probe-print',
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 620 });
  await view.webContents.loadURL(page('<h1 id="t">printable</h1><p>hello</p>'));

  // 1. printers ------------------------------------------------------------
  try {
    const printers = await view.webContents.getPrintersAsync();
    log(`系统打印机：${printers.length} 个${printers.length ? ` → ${printers.map((p) => `${p.name}${p.isDefault ? '(默认)' : ''}`).join(', ')}` : '（系统没有可用打印机）'}`);
  } catch (error) {
    log('getPrintersAsync 失败：', String(error));
  }

  // 2. printable output ----------------------------------------------------
  try {
    const pdf = await view.webContents.printToPDF({ printBackground: true });
    log(`printToPDF：${pdf.length} 字节（渲染与排版链路可用）`);
  } catch (error) {
    log('printToPDF 失败：', String(error));
  }

  // 3. top-frame window.print() -------------------------------------------
  // Chromium blocks the renderer while the dialog is open, so "did the call
  // return?" is the observable. Both surfaces are compared: the embedded
  // WebContentsView this shell uses, and a plain BrowserWindow page.
  const probePrint = async (label, contents) => {
    const result = await race(contents.executeJavaScript('window.print(); "returned"'), WANT_DIALOG ? DIALOG_WAIT_MS : 800);
    log(
      result.settled
        ? `${label}：window.print() 立即返回（${result.value ?? result.error}）→ 未打开系统面板`
        : `${label}：window.print() 未返回 → 系统打印面板已打开（渲染进程被阻塞）`,
    );
    return result.settled;
  };

  const viewReturned = await probePrint('内嵌 WebContentsView', view.webContents);
  if (WANT_DIALOG && viewReturned) {
    await win.webContents.loadURL(page('<h1>printable</h1>'));
    await probePrint('普通 BrowserWindow 页面', win.webContents);
  }

  // 4. sandboxed iframe (how the plugin renders HTML previews) ------------
  // The call happens inside the frame and reports through console, because a
  // sandboxed frame is cross-origin and may run before the parent can listen.
  const consoleLines = [];
  view.webContents.on('console-message', (...args) => {
    const details = args[0];
    const message = typeof details === 'object' && details?.message ? details.message : args[2];
    if (message) consoleLines.push(String(message));
  });

  // Includes a same-origin (unsandboxed) frame for reference: it shows whether
  // the restriction comes from the sandbox or from iframes in general.
  for (const sandbox of ['allow-scripts', 'allow-scripts allow-modals', 'allow-scripts allow-same-origin', '']) {
    consoleLines.length = 0;
    await view.webContents.loadURL(
      page(
        `<iframe sandbox="${sandbox}" srcdoc="&lt;script&gt;
           const t0 = performance.now();
           try { window.print(); console.log('PRINT-PROBE returned in ' + Math.round(performance.now() - t0) + 'ms'); }
           catch (error) { console.log('PRINT-PROBE threw: ' + error.message); }
         &lt;/script&gt;"></iframe>`,
      ),
    );
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('无回报（调用被阻塞 → 打印面板已打开）'), WANT_DIALOG ? DIALOG_WAIT_MS : 1500);
      const tick = setInterval(() => {
        const hit = consoleLines.find((line) => line.includes('PRINT-PROBE') || /print|modal/i.test(line));
        if (hit) {
          clearTimeout(timer);
          clearInterval(tick);
          resolve(hit);
        }
      }, 100);
    });
    log(`iframe sandbox="${sandbox || '(无 sandbox)'}"：${outcome}`);
  }

  // 5. the path the shell itself uses -------------------------------------
  if (WANT_DIALOG) {
    const { printPage } = require('../src/main/printing.js');
    const started = Date.now();
    const result = await race(printPage(view.webContents, { silent: false, printBackground: true }), DIALOG_WAIT_MS);
    log(
      result.settled
        ? `外壳 printPage()：${Math.round(Date.now() - started)}ms 内返回 → ${JSON.stringify(result.value ?? result.error)}`
        : '外壳 printPage()：等待用户操作中 → 系统打印面板已打开 ✓',
    );
  } else {
    log('外壳 printPage()：已跳过（加 --dialog 才会打开系统打印面板）');
  }

  log('探针结束');
  app.exit(0);
});
