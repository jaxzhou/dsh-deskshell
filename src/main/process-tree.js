'use strict';

/**
 * Terminating a child process started by a desktop app must be reliable: the
 * `dsh` server and the `npm` installer both spawn their own children, and a
 * leftover process would keep a port bound after the window is gone.
 */

const { spawn } = require('node:child_process');

const { IS_WINDOWS } = require('./shell-env');

/**
 * Ask a process (and, on Windows, its whole tree) to stop, escalating to
 * SIGKILL when it does not exit in time.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{timeoutMs?: number, onLog?: (line: string) => void}} [options]
 * @returns {Promise<{exited: boolean, forced: boolean}>}
 */
function terminate(child, options = {}) {
  const { timeoutMs = 6_000, onLog = () => {} } = options;

  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve({ exited: true, forced: false });
      return;
    }

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve(result);
    };

    child.once('exit', () => done({ exited: true, forced: false }));

    const forceTimer = setTimeout(() => {
      onLog('进程未在超时内退出，强制结束');
      try {
        if (IS_WINDOWS) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (error) {
        onLog(`强制结束失败：${error instanceof Error ? error.message : String(error)}`);
      }
      done({ exited: false, forced: true });
    }, timeoutMs);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    try {
      if (IS_WINDOWS) {
        spawn('taskkill', ['/pid', String(child.pid), '/T'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch (error) {
      onLog(`发送停止信号失败：${error instanceof Error ? error.message : String(error)}`);
      done({ exited: false, forced: false });
    }
  });
}

/**
 * Incremental line splitter for a byte stream: handles \n, \r\n and the bare
 * \r rewrites npm and progress reporters emit.
 */
function createLineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      const parts = buffer.split(/\r\n|\n|\r/);
      buffer = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

module.exports = { createLineSplitter, terminate };
