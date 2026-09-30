'use strict';

/**
 * Terminating a child process started by a desktop app must be reliable *and
 * observable*: the `dsh` server and the `npm`/`pnpm` installers both spawn
 * their own children, and a leftover process keeps the profile's files locked.
 * On Windows that is not a theoretical concern — an installer touching
 * `node_modules` while a dying dsh still holds it fails with EBUSY/EPERM — so
 * `terminate()` only resolves once the process is confirmed dead.
 */

const { spawn } = require('node:child_process');

const { IS_WINDOWS } = require('./shell-env');

/** True once the child has actually exited. */
function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolve `true` when the child exits before the deadline, `false` otherwise.
 * Never rejects, and never resolves early on a promise we do not control.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(true);
      return;
    }
    let timer = null;
    const finish = (value) => {
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    // Deliberately *not* unref'd: this promise must always settle, and it is
    // bounded by timeoutMs. An unref'd timer lets the event loop drain, which
    // would leave callers awaiting forever (and the app never quitting).
    timer = setTimeout(() => finish(hasExited(child)), Math.max(0, timeoutMs));
  });
}

/** `taskkill /pid <pid> /T [/F]` — the only dependable way to stop a tree. */
function killTree(pid, force, onLog = () => {}) {
  if (!pid) return null;
  const args = ['/pid', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    killer.on('error', (error) => onLog(`taskkill 启动失败：${error instanceof Error ? error.message : String(error)}`));
    return killer;
  } catch (error) {
    onLog(`taskkill 调用失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Ask a process (and, on Windows, its whole tree) to stop, waiting until it is
 * really gone.
 *
 * Windows note: `dsh` is started through its `.cmd` shim, so the direct child is
 * `cmd.exe` and the real work happens in `node.exe` below it. `taskkill` without
 * `/F` cannot close a console process like that (it exits with an error and the
 * process keeps running), so the tree is force-killed directly — and then we
 * still wait for the exit, because the caller's next step writes to files that
 * this process may hold open.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{timeoutMs?: number, forceTimeoutMs?: number, onLog?: (line: string) => void}} [options]
 * @returns {Promise<{exited: boolean, forced: boolean}>}
 */
async function terminate(child, options = {}) {
  const { timeoutMs = 6_000, forceTimeoutMs = 3_000, onLog = () => {} } = options;
  if (hasExited(child)) return { exited: true, forced: false };

  if (IS_WINDOWS) {
    onLog('Windows：结束进程树（taskkill /T /F）');
    killTree(child.pid, true, onLog);
    const exited = await waitForExit(child, timeoutMs);
    if (!exited) onLog('进程未在超时内退出，可能仍在占用文件');
    return { exited, forced: true };
  }

  try {
    child.kill('SIGTERM');
  } catch (error) {
    onLog(`发送停止信号失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (await waitForExit(child, timeoutMs)) return { exited: true, forced: false };

  onLog('进程未在超时内退出，强制结束');
  try {
    child.kill('SIGKILL');
  } catch (error) {
    onLog(`强制结束失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const exited = await waitForExit(child, forceTimeoutMs);
  if (!exited) onLog('进程仍未退出，可能仍在占用文件');
  return { exited, forced: true };
}

/** Short pause; used to let Windows release handles after a forced kill. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

module.exports = { createLineSplitter, delay, hasExited, killTree, terminate, waitForExit };
