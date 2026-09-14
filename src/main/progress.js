'use strict';

/**
 * Turn the npm install stream into a progress model.
 *
 * `npm install -g` has no machine-readable progress channel; when it is spawned
 * without a TTY npm prints no progress bar at all. What it *does* print — with
 * `--loglevel=http` — is one line per registry fetch plus a handful of reify
 * notices, which is enough to drive an honest bar: fetches ramp asymptotically,
 * reify pins the late stages, and the final "added N packages" line completes it.
 */

/** Weights are percents; the model never goes backwards. */
const STAGES = {
  prepare: { percent: 2, phase: '准备安装' },
  resolve: { percent: 6, phase: '解析依赖树' },
  fetch: { percent: null, phase: '下载依赖包' },
  reify: { percent: 82, phase: '解包写入 node_modules' },
  link: { percent: 92, phase: '链接可执行文件' },
  done: { percent: 100, phase: '安装完成' },
};

/** How many fetched packages it takes to approach the fetch ceiling. */
const FETCH_SATURATION = 30;
/** Fetches alone never carry the bar past this percent: reify must follow. */
const FETCH_CEILING = 78;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @returns {{
 *   feed(line: string): boolean,
 *   finish(ok: boolean): void,
 *   snapshot(): {percent: number, phase: string, detail: string, fetched: number, packages: number},
 * }}
 */
function createInstallProgress() {
  const state = {
    percent: STAGES.prepare.percent,
    phase: STAGES.prepare.phase,
    detail: '',
    fetched: 0,
    packages: 0,
    done: false,
    failed: false,
  };

  function advance(percent, phase, detail) {
    let changed = false;
    if (typeof percent === 'number' && percent > state.percent) {
      state.percent = clamp(percent, 0, 100);
      changed = true;
    }
    if (phase && phase !== state.phase) {
      state.phase = phase;
      changed = true;
    }
    if (typeof detail === 'string' && detail !== state.detail) {
      state.detail = detail;
      changed = true;
    }
    return changed;
  }

  /** Feed one output line; returns true when the snapshot changed. */
  function feed(rawLine) {
    const line = String(rawLine ?? '').replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!line) return false;

    if (/(?:npm )?error|npm ERR!|ERR! code/i.test(line)) {
      state.failed = true;
      return advance(null, '安装失败', line.slice(0, 240));
    }

    const fetch = line.match(/http fetch GET \d+ /);
    if (fetch) {
      state.fetched += 1;
      const ratio = 1 - Math.exp(-state.fetched / FETCH_SATURATION);
      return advance(
        STAGES.resolve.percent + (FETCH_CEILING - STAGES.resolve.percent) * ratio,
        STAGES.fetch.phase,
        `已获取 ${state.fetched} 个包`,
      );
    }

    if (/reify|idealTree|extract/i.test(line)) {
      return advance(STAGES.reify.percent, STAGES.reify.phase, state.detail || `已获取 ${state.fetched} 个包`);
    }

    const added = line.match(/added (\d+) package/);
    if (added) {
      state.packages = Number(added[1]);
      return advance(STAGES.link.percent, STAGES.done.phase, `共安装 ${state.packages} 个包`);
    }

    if (/up to date|changed \d+ package|removed \d+ package/i.test(line)) {
      return advance(STAGES.link.percent, STAGES.done.phase, '依赖已是最新');
    }

    return false;
  }

  /** Settle the bar: 100% on success, or freeze it in the failed stage. */
  function finish(ok) {
    if (ok) {
      state.done = true;
      state.percent = 100;
      state.phase = STAGES.done.phase;
      if (!state.detail) state.detail = state.packages ? `共安装 ${state.packages} 个包` : '';
    } else if (state.phase !== '安装失败') {
      state.phase = '安装失败';
    }
  }

  function snapshot() {
    return {
      percent: Math.round(state.percent),
      phase: state.phase,
      detail: state.detail,
      fetched: state.fetched,
      packages: state.packages,
      done: state.done,
      failed: state.failed,
    };
  }

  return { feed, finish, snapshot };
}

module.exports = { createInstallProgress, STAGES };
