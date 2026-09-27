'use strict';

/**
 * Drives the shell's own update lifecycle.
 *
 * Nothing here touches Electron: the manager owns state and decisions, while
 * the main process injects how to fetch, download and apply. That keeps the
 * whole flow — including "an update exists but this package format cannot be
 * replaced in place" — testable without launching the app.
 *
 * Lifecycle: idle → checking → (current | available) → downloading → ready →
 * applying. Every failure lands in `error` with a readable reason; the periodic
 * timer is a single `setTimeout` chain, so no long-running updater process
 * exists between checks.
 */

const fs = require('node:fs');
const path = require('node:path');

const updater = require('./updater');

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_STARTUP_DELAY_MS = 8 * 1000;

/** Is `dir` writable by this process? */
function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   currentVersion: string,
 *   platform?: string, arch?: string, variant?: string|null,
 *   manifestUrl?: string, isPackaged?: boolean,
 *   appPath?: string|null, appImagePath?: string|null,
 *   directoryWritable?: boolean|Function|null,
 *   downloadDir: string,
 *   downloadFile?: Function, fetchManifest?: Function, verify?: Function,
 *   now?: Function, log?: Function, onState?: Function,
 *   autoCheck?: boolean, checkIntervalMs?: number, startupDelayMs?: number,
 *   pid?: number, relaunch?: boolean,
 * }} options
 */
function createUpdateManager(options) {
  const {
    currentVersion,
    platform = process.platform,
    arch = process.arch,
    variant = null,
    manifestUrl = updater.DEFAULT_MANIFEST_URL,
    isPackaged = false,
    appPath = null,
    appImagePath = null,
    directoryWritable = null,
    downloadDir,
    downloadFile = null,
    fetchManifest = updater.fetchManifest,
    verify = updater.verifySha256,
    now = () => Date.now(),
    log = () => {},
    onState = () => {},
    autoCheck = true,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    pid = process.pid,
    relaunch = true,
  } = options;

  if (!currentVersion) throw new Error('createUpdateManager 需要 currentVersion');
  if (!downloadDir) throw new Error('createUpdateManager 需要 downloadDir');

  const state = {
    /**
     * idle | checking | current | available | downloading | ready | applying |
     * manual | error
     *
     * `idle` is the only starting point; `manual` means "an update exists but
     * this install cannot be replaced in place", never "auto-check is off"
     * (`autoCheck` carries that separately).
     */
    phase: 'idle',
    currentVersion,
    /** Why the last check ran: startup | periodic | manual (UI decides what to surface). */
    reason: null,
    latestVersion: null,
    notes: '',
    releasedAt: '',
    file: null,
    size: null,
    progress: null,
    plan: null,
    error: null,
    lastCheckedAt: null,
    checkIntervalMs,
    autoCheck,
    variant,
    manifestUrl,
    source: null,
    downloadedPath: null,
  };

  let manifest = null;
  let asset = null;
  let timer = null;
  let inFlight = null; // guards concurrent check/download
  let disposed = false;

  const snapshot = () => ({
    ...state,
    progress: state.progress ? { ...state.progress } : null,
    plan: state.plan ? { ...state.plan } : null,
  });

  function emit() {
    try {
      onState(snapshot());
    } catch (error) {
      log(`更新状态回调异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function set(patch) {
    Object.assign(state, patch);
    emit();
    return snapshot();
  }

  function fail(message, patch = {}) {
    log(`更新失败：${message}`);
    return set({ phase: 'error', error: message, progress: null, ...patch });
  }

  function writable() {
    if (typeof directoryWritable === 'function') return directoryWritable();
    if (typeof directoryWritable === 'boolean') return directoryWritable;
    const target = appImagePath || appPath;
    if (!target) return null;
    return canWrite(path.dirname(target));
  }

  function buildPlan() {
    return updater.planUpdate({
      platform,
      asset,
      appPath,
      appImagePath,
      isPackaged,
      directoryWritable: writable(),
    });
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();
    if (disposed || !autoCheck) return;
    const delay = Number.isFinite(checkIntervalMs) && checkIntervalMs > 0 ? checkIntervalMs : DEFAULT_CHECK_INTERVAL_MS;
    timer = setTimeout(() => {
      timer = null;
      check({ reason: 'periodic' }).catch(() => {});
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Ask the release manifest whether a newer shell exists.
   * @param {{reason?: string, silent?: boolean}} [opts]
   */
  async function check(opts = {}) {
    if (disposed) return snapshot();
    if (inFlight) return inFlight;
    const silent = opts.silent === true;
    state.reason = opts.reason ?? (silent ? 'startup' : 'manual');
    inFlight = (async () => {
      if (!silent) set({ phase: 'checking', error: null });
      const result = await fetchManifest({ url: manifestUrl, origin: manifestUrl });
      state.lastCheckedAt = now();
      if (!result.ok) {
        // A silent (periodic) failure is not worth interrupting the user, but it
        // is recorded so the menu can show why nothing happened.
        log(`检查更新失败：${result.error}`);
        return fail(`检查更新失败：${result.error}`, { source: result.source });
      }
      manifest = result.manifest;
      asset = updater.selectAsset(manifest, { platform, arch, variant });
      state.source = result.source;
      state.latestVersion = manifest.version;
      state.notes = manifest.notes;
      state.releasedAt = manifest.releasedAt;
      state.file = asset ? asset.file : null;
      state.size = asset ? asset.size : null;

      if (!updater.isNewer(manifest.version, currentVersion)) {
        return set({ phase: 'current', error: null, plan: null, progress: null });
      }
      const plan = buildPlan();
      if (!asset) {
        return set({
          phase: 'manual',
          error: null,
          plan,
          notes: manifest.notes,
        });
      }
      return set({
        phase: plan.applicable ? 'available' : 'manual',
        error: null,
        plan,
      });
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
      scheduleNext();
    }
  }

  /** Download the selected asset and verify its published SHA-256. */
  async function download() {
    if (disposed) return snapshot();
    if (inFlight) return inFlight;
    if (!asset) return fail('没有可下载的更新包，请先检查更新');
    if (state.phase === 'downloading') return snapshot();

    const target = path.join(downloadDir, asset.file);
    inFlight = (async () => {
      set({ phase: 'downloading', reason: 'download', error: null, progress: { received: 0, total: asset.size, percent: 0 } });
      const doDownload = downloadFile ?? require('./node-runtime').downloadFile;
      // Progress ticks arrive per chunk; the renderer only needs whole percents
      // (and a heartbeat), so the IPC channel is not flooded.
      let lastPercent = -1;
      let lastEmit = 0;
      try {
        await doDownload(asset.url, target, {
          timeoutMs: 30 * 60 * 1000,
          onProgress: (snapshotProgress) => {
            if (disposed) return;
            const percent = snapshotProgress.percent ?? null;
            const at = now();
            const rounded = percent == null ? percent : Math.floor(percent);
            if (rounded === lastPercent && at - lastEmit < 1000) return;
            lastPercent = rounded;
            lastEmit = at;
            set({
              progress: {
                received: snapshotProgress.received ?? 0,
                total: snapshotProgress.total ?? asset.size ?? null,
                percent,
              },
            });
          },
        });
      } catch (error) {
        return fail(`下载更新失败：${error instanceof Error ? error.message : String(error)}`);
      }

      const checked = verify(target, asset.sha256);
      if (!checked.ok) {
        try {
          fs.rmSync(target, { force: true });
        } catch {
          /* keep the failure report */
        }
        const detail = checked.actual ? `实际 ${String(checked.actual).slice(0, 16)}…` : checked.error || '无法计算';
        return fail(`更新包校验失败（期望 ${asset.sha256.slice(0, 16)}…，${detail}），已删除下载文件`);
      }

      const plan = buildPlan();
      return set({
        phase: plan.applicable ? 'ready' : 'manual',
        error: null,
        downloadedPath: target,
        plan,
        progress: { received: asset.size, total: asset.size, percent: 100 },
      });
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  /**
   * Produce the "apply" instructions for the main process. The main process
   * spawns whatever is needed and then quits; the helper waits for this pid to
   * disappear before touching any file.
   */
  function apply() {
    if (disposed) return { ok: false, error: '更新器已关闭' };
    if (state.phase === 'downloading' || state.phase === 'checking') {
      return { ok: false, error: '更新仍在进行中，请稍候' };
    }
    if (!asset || !state.downloadedPath) {
      return { ok: false, error: '尚未下载更新包' };
    }
    const plan = buildPlan();
    if (!plan.applicable) {
      return { ok: false, error: plan.note, plan, phase: state.phase };
    }
    const context = {
      newFile: state.downloadedPath,
      target: plan.target,
      pid,
      relaunch,
      unpackDir: path.join(downloadDir, 'unpacked'),
    };
    const script = updater.helperScriptFor(plan, context);
    set({ phase: 'applying', error: null });
    return { ok: true, plan, context, script };
  }

  /** Manual "check now" from the UI: always re-checks, even when up to date. */
  async function checkNow() {
    return check({ reason: 'manual' });
  }

  function dispose() {
    disposed = true;
    clearTimer();
  }

  /** Start the delayed first check plus the periodic chain. */
  function startAutoCheck() {
    if (!autoCheck || disposed) return;
    const delay = Number.isFinite(startupDelayMs) && startupDelayMs >= 0 ? startupDelayMs : DEFAULT_STARTUP_DELAY_MS;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      check({ reason: 'startup', silent: true }).catch(() => {});
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    apply,
    check,
    checkNow,
    dispose,
    download,
    getManifest: () => manifest,
    getState: snapshot,
    startAutoCheck,
  };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  canWrite,
  createUpdateManager,
};
