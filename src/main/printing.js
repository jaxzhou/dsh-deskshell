'use strict';

/**
 * Printing from the embedded dsh page.
 *
 * What the probe (scripts/print-probe.cjs) establishes on Electron 43:
 *
 *   top-level page          window.print() opens the system print panel ✓
 *   same-origin iframe      window.print() opens the system print panel ✓
 *   sandboxed iframe        window.print() is ignored by Chromium ✗
 *                           (with or without `allow-modals`)
 *
 * The file-explorer plugin renders HTML previews inside a *sandboxed* iframe,
 * so a print call coming from there can never reach the system dialog — that is
 * a browser rule, not something the shell can override from outside the frame.
 * What the shell can do is own the print path: a menu entry and Cmd/Ctrl+P that
 * hand the embedded page to `webContents.print()`, plus a PDF export built on
 * `printToPDF()`.
 */

const fs = require('node:fs');

/**
 * Whether a `before-input-event` payload is the platform's print shortcut.
 *
 * @param {{type?: string, key?: string, meta?: boolean, control?: boolean, alt?: boolean, shift?: boolean}} input
 * @param {string} [platform] defaults to the running platform.
 * @returns {boolean}
 */
function isPrintShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return false;
  if (String(input.key ?? '').toLowerCase() !== 'p') return false;
  if (input.alt) return false;
  if (platform === 'darwin') return input.meta === true && input.control !== true;
  return input.control === true && input.meta !== true;
}

/**
 * Send the page to the system print dialog.
 *
 * @param {import('electron').WebContents} webContents
 * @param {{silent?: boolean, printBackground?: boolean}} [options]
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
function printPage(webContents, options = {}) {
  const { silent = false, printBackground = true } = options;
  return new Promise((resolve) => {
    if (!webContents || webContents.isDestroyed?.()) {
      resolve({ ok: false, reason: '页面不可用' });
      return;
    }
    try {
      webContents.print({ silent, printBackground }, (success, failureReason) => {
        resolve({ ok: Boolean(success), reason: failureReason ? String(failureReason) : null });
      });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * Render the page to PDF and write it where the user chooses.
 *
 * @param {import('electron').WebContents} webContents
 * @param {{defaultPath: string, choosePath: (defaultPath: string) => Promise<string|null>, printToPDF?: Function}} options
 * @returns {Promise<{ok: boolean, path: string|null, reason: string|null}>}
 */
async function exportPageAsPdf(webContents, options) {
  const { defaultPath, choosePath } = options;
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, path: null, reason: '页面不可用' };
  }
  try {
    const target = await choosePath(defaultPath);
    if (!target) return { ok: false, path: null, reason: 'cancelled' };
    const toPdf = options.printToPDF ?? ((pdfOptions) => webContents.printToPDF(pdfOptions));
    const data = await toPdf({ printBackground: true, landscape: false });
    fs.writeFileSync(target, data);
    return { ok: true, path: target, reason: null };
  } catch (error) {
    return { ok: false, path: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = { exportPageAsPdf, isPrintShortcut, printPage };
