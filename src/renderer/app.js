'use strict';

/**
 * Shell renderer.
 *
 * Renders the phase panels from the state snapshots the main process pushes,
 * and forwards button clicks back through the preload bridge. The embedded dsh
 * GUI itself is a separate `WebContentsView` owned by main; this file only
 * reports how much vertical space its own toolbar takes.
 */

const api = window.dshShell;

const MAX_LOG_NODES = 500;
const PHASES = ['checking', 'no-node', 'missing-dsh', 'installing', 'starting', 'running', 'error'];

const el = {
  toolbar: document.getElementById('toolbar'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  statusMeta: document.getElementById('statusMeta'),
  toolbarActions: document.getElementById('toolbarActions'),
  statusSep: document.getElementById('statusSep'),
  menuBtn: document.getElementById('menuBtn'),
  menuList: document.getElementById('menuList'),
  quitBtn: document.getElementById('quitBtn'),
  panels: new Map(PHASES.map((phase) => [phase, document.querySelector(`.panel[data-phase="${phase}"]`)])),
  checkingKv: document.getElementById('checkingKv'),
  noNodeKv: document.getElementById('noNodeKv'),
  missingKv: document.getElementById('missingKv'),
  globalRoot: document.getElementById('globalRoot'),
  installBar: document.getElementById('installBar'),
  installPercent: document.getElementById('installPercent'),
  installPhase: document.getElementById('installPhase'),
  installDetail: document.getElementById('installDetail'),
  installElapsed: document.getElementById('installElapsed'),
  startingText: document.getElementById('startingText'),
  errorTitle: document.getElementById('errorTitle'),
  errorMessage: document.getElementById('errorMessage'),
  errorHint: document.getElementById('errorHint'),
  logPanel: document.getElementById('logPanel'),
  logToggle: document.getElementById('logToggle'),
  logBody: document.getElementById('logBody'),
  logCount: document.getElementById('logCount'),
};

/** @type {object|null} */
let state = null;
/** Local timestamps so the elapsed counters do not depend on main's clock. */
const localClock = { installing: null, starting: null };

// ------------------------------------------------------------------ helpers

function setText(node, value) {
  if (node) node.textContent = value == null ? '' : String(value);
}

/** Build the key/value grid shown under the check panels. */
function renderKv(node, rows) {
  if (!node) return;
  node.replaceChildren();
  for (const [key, value, tone] of rows) {
    if (value == null || value === '') continue;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = tone ? `v ${tone}` : 'v';
    v.textContent = String(value);
    node.append(k, v);
  }
}

function detectionRows(detection) {
  if (!detection) return [['状态', '正在收集环境信息…']];
  const rows = [];
  rows.push(['平台', `${detection.platform} / ${detection.arch}`]);
  rows.push([
    'node',
    detection.node.available ? `${detection.node.version ?? '未知版本'}` : '未找到',
    detection.node.available ? 'ok' : 'bad',
  ]);
  rows.push([
    'npm',
    detection.npm.available ? `${detection.npm.version ?? '未知版本'}` : '未找到',
    detection.npm.available ? 'ok' : 'bad',
  ]);
  rows.push([
    'dsh',
    detection.dsh.installed ? `${detection.dsh.version ?? '未知版本'}` : '未安装',
    detection.dsh.installed ? 'ok' : 'bad',
  ]);
  if (detection.dsh.command) rows.push(['dsh 路径', detection.dsh.command]);
  if (detection.npm.globalBin) rows.push(['全局 bin', detection.npm.globalBin]);
  if (detection.npm.globalRoot) rows.push(['全局 node_modules', detection.npm.globalRoot]);
  if (detection.dsh.error) rows.push(['说明', detection.dsh.error]);
  return rows;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

// ---------------------------------------------------------------- log panel

let logNodes = 0;

function appendLog(entry) {
  if (!entry) return;
  if (!logNodes) {
    const empty = el.logBody.querySelector('.empty-log');
    if (empty) empty.remove();
  }
  const row = document.createElement('div');
  row.className = `log-line ${entry.stream ?? 'system'}`;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = new Date(entry.ts ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false });

  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = entry.line ?? '';

  row.append(ts, msg);

  const atBottom = el.logBody.scrollTop + el.logBody.clientHeight >= el.logBody.scrollHeight - 24;
  el.logBody.append(row);
  logNodes += 1;

  while (logNodes > MAX_LOG_NODES && el.logBody.firstElementChild) {
    el.logBody.firstElementChild.remove();
    logNodes -= 1;
  }
  el.logPanel.classList.remove('empty');
  setText(el.logCount, logNodes);
  if (atBottom) el.logBody.scrollTop = el.logBody.scrollHeight;
}

function resetLog(entries = []) {
  el.logBody.replaceChildren();
  logNodes = 0;
  el.logPanel.classList.toggle('empty', entries.length === 0);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-log';
    empty.textContent = '暂无日志输出';
    el.logBody.append(empty);
  } else {
    for (const entry of entries) appendLog(entry);
  }
  setText(el.logCount, logNodes);
}

// ------------------------------------------------------------ toolbar actions

const ACTION_SPECS = {
  checking: [],
  'no-node': [{ label: '重新检测', action: 'detect' }],
  'missing-dsh': [
    { label: '安装 dsh', action: 'install', primary: true },
    { label: '重新检测', action: 'detect' },
  ],
  installing: [{ label: '取消安装', action: 'cancel-install' }],
  starting: [{ label: '停止', action: 'stop' }],
  running: [
    { label: '重新加载', action: 'reload' },
    { label: '浏览器打开', action: 'open-browser' },
    { label: '重启 dsh', action: 'restart' },
    { label: '停止 dsh', action: 'stop' },
  ],
  error: [
    { label: '重试', action: 'retry', primary: true },
    { label: '重新检测', action: 'detect' },
  ],
};

/** True while the user reads the log panel instead of the embedded GUI. */
let guiHidden = false;

/**
 * The only button that stays inline is the phase's primary call to action.
 * Everything else — reload, logs, restart, stop, re-detect — is debugging or
 * maintenance work and lives behind the ⋮ menu.
 */
const PRIMARY_ACTIONS = {
  'missing-dsh': { label: '安装 dsh', action: 'install' },
  installing: { label: '取消安装', action: 'cancel-install' },
  starting: { label: '停止', action: 'stop' },
  error: { label: '重试', action: 'retry' },
};

/** Menu entries per phase; `label` may be a function of the current UI state. */
const MENU_SPECS = {
  checking: [{ label: '重新检测', action: 'detect' }],
  'no-node': [{ label: '重新检测', action: 'detect' }],
  'missing-dsh': [
    { label: '重新检测', action: 'detect' },
    { label: '复制安装命令', action: 'copy-cmd' },
  ],
  installing: [
    { label: '取消安装', action: 'cancel-install' },
    { label: '复制日志', action: 'copy-log' },
  ],
  starting: [
    { label: '停止 dsh', action: 'stop' },
    { label: '复制日志', action: 'copy-log' },
  ],
  running: [
    { label: () => (guiHidden ? '返回 DSH 界面' : '查看日志'), action: 'toggle-gui' },
    { label: '重新加载界面', action: 'reload' },
    { label: '在浏览器中打开', action: 'open-browser' },
    { separator: true },
    { label: '重启 dsh', action: 'restart' },
    { label: '停止 dsh', action: 'stop' },
    { label: '重新检测', action: 'detect' },
    { separator: true },
    { label: '复制日志', action: 'copy-log' },
  ],
  error: [
    { label: '重新检测', action: 'detect' },
    { label: '重新安装 dsh', action: 'install' },
    { separator: true },
    { label: '复制日志', action: 'copy-log' },
  ],
};

function renderToolbarActions(phase) {
  el.toolbarActions.replaceChildren();

  const primary = PRIMARY_ACTIONS[phase];
  if (primary) {
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.dataset.action = primary.action;
    button.textContent = primary.label;
    el.toolbarActions.append(button);
  }

  renderMenu(phase);
}

function renderMenu(phase) {
  const specs = MENU_SPECS[phase] ?? [];
  el.menuList.replaceChildren();
  for (const spec of specs) {
    if (spec.separator) {
      const rule = document.createElement('div');
      rule.className = 'menu-sep';
      el.menuList.append(rule);
      continue;
    }
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.dataset.action = spec.action;
    item.setAttribute('role', 'menuitem');
    item.textContent = typeof spec.label === 'function' ? spec.label() : spec.label;
    el.menuList.append(item);
  }
}

function openMenu(open) {
  const shouldOpen = open ?? el.menuList.hidden;
  el.menuList.hidden = !shouldOpen;
  el.menuBtn.setAttribute('aria-expanded', String(shouldOpen));
}

// -------------------------------------------------------------------- render

function render(next) {
  const previousPhase = state?.phase ?? null;
  state = next;

  const phase = PHASES.includes(next.phase) ? next.phase : 'checking';

  if (phase !== previousPhase) {
    if (phase === 'installing') localClock.installing = Date.now();
    if (phase === 'starting') localClock.starting = Date.now();
    // Main resets the manual hide on every phase change; keep the labels in sync.
    if (phase !== 'running') guiHidden = false;
  }

  for (const [name, panel] of el.panels) {
    panel.classList.toggle('active', name === phase);
  }

  // --- status strip: machine name + dsh version (the port stays internal) ---
  setText(el.statusText, next.statusText ?? '');
  const meta = [];
  if (next.hostname) meta.push(next.hostname);
  if (next.detection?.dsh?.installed && next.detection.dsh.version) meta.push(`dsh ${next.detection.dsh.version}`);
  setText(el.statusMeta, meta.join(' · '));
  el.statusSep.hidden = meta.length === 0;

  el.statusDot.className = 'status-dot';
  if (phase === 'running') el.statusDot.classList.add('ok');
  else if (phase === 'error') el.statusDot.classList.add('error');
  else if (phase === 'checking' || phase === 'installing' || phase === 'starting') el.statusDot.classList.add('busy');

  if (phase !== previousPhase) openMenu(false);
  renderToolbarActions(phase);

  // --- panels ---------------------------------------------------------------
  const rows = detectionRows(next.detection);
  renderKv(el.checkingKv, rows);
  renderKv(el.noNodeKv, next.detection?.node?.available ? rows : rows);
  renderKv(el.missingKv, rows);
  setText(el.globalRoot, next.detection?.npm?.globalRoot ?? '未解析');

  const install = next.install;
  if (phase === 'installing' && install) {
    setText(el.installPercent, `${install.percent ?? 0}%`);
    el.installBar.style.width = `${install.percent ?? 0}%`;
    setText(el.installPhase, install.phase ?? '安装中');
    setText(el.installDetail, install.detail || `已获取 ${install.fetched ?? 0} 个包`);
  }

  if (phase === 'starting') {
    setText(el.startingText, next.statusText ?? '等待 dsh 打印 Web 服务地址');
  }

  if (phase === 'error' && next.error) {
    setText(el.errorTitle, next.statusText ?? '操作失败');
    setText(el.errorMessage, next.error.message ?? '');
    setText(el.errorHint, next.error.hint ?? '');
  }

  updateElapsed();
}

/** Tick the elapsed-time labels once per second. */
function updateElapsed() {
  if (!state) return;
  if (state.phase === 'installing' && localClock.installing) {
    setText(el.installElapsed, `已用时 ${formatDuration(Date.now() - localClock.installing)}`);
  }
  if (state.phase === 'starting' && localClock.starting) {
    setText(el.startingText, `${state.statusText ?? '正在启动 dsh…'} · 已用时 ${formatDuration(Date.now() - localClock.starting)}`);
  }
}

// ------------------------------------------------------------------- actions

/** Actions that report inline feedback and therefore keep the menu open. */
const COPY_ACTIONS = new Set(['copy-cmd', 'copy-log']);

const ACTIONS = {
  check: () => api.check(),
  detect: () => api.detect(),
  install: () => api.install(),
  'cancel-install': () => api.cancelInstall(),
  start: () => api.start(),
  stop: () => api.stop(),
  restart: () => api.restart(),
  retry: () => api.retry(),
  reload: () => api.reloadGui(),
  'toggle-gui': async () => {
    guiHidden = !guiHidden;
    await api.setGuiVisible(!guiHidden);
    if (guiHidden) el.logPanel.classList.remove('collapsed');
    renderToolbarActions(state?.phase ?? 'running');
  },
  'open-browser': () => api.openExternal(),
  'open-nodejs': () => api.openExternal('https://nodejs.org/zh-cn/download'),
  'copy-cmd': (button) => copyText(button, document.getElementById('installCmd')?.textContent ?? ''),
  'copy-log': (button) =>
    copyText(button, [...el.logBody.querySelectorAll('.log-line .msg')].map((node) => node.textContent).join('\n')),
  'clear-log': () => resetLog([]),
};

/** Last-resort copy for environments where the async Clipboard API is blocked. */
function legacyCopy(text) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyText(button, text) {
  const original = button.textContent;
  const payload = text ?? '';
  let ok = false;
  try {
    await navigator.clipboard.writeText(payload);
    ok = true;
  } catch {
    ok = legacyCopy(payload);
  }
  button.textContent = ok ? '已复制' : '复制失败';
  appendLog({
    ts: Date.now(),
    stream: ok ? 'system' : 'stderr',
    line: ok ? `已复制到剪贴板（${payload.split('\n').length} 行）` : '复制失败：剪贴板不可用',
  });
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

document.addEventListener('click', (event) => {
  const inMenu = Boolean(event.target.closest('.menu'));
  if (!inMenu) openMenu(false);

  const button = event.target.closest('button[data-action]');
  if (!button) return;
  // Menu actions close it again — except the copy ones, whose "已复制"
  // feedback the user should actually see.
  if (button.classList.contains('menu-item') && !COPY_ACTIONS.has(button.dataset.action)) openMenu(false);
  const handler = ACTIONS[button.dataset.action];
  if (!handler) return;
  Promise.resolve(handler(button)).catch((error) => {
    appendLog({ ts: Date.now(), stream: 'stderr', line: `操作失败：${error?.message ?? error}` });
  });
});

el.menuBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  openMenu(el.menuList.hidden);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') openMenu(false);
});

el.quitBtn.addEventListener('click', () => api.quit());

el.logToggle.addEventListener('click', () => {
  const collapsed = el.logPanel.classList.toggle('collapsed');
  el.logToggle.setAttribute('aria-expanded', String(!collapsed));
});

// Keep the embedded GUI view aligned with our own toolbar height.
function reportInset() {
  const height = Math.round(el.toolbar.getBoundingClientRect().height);
  if (height > 0) api.setViewInset({ top: height });
}

// ---------------------------------------------------------------- bootstrap

api.onState(render);
api.onLog(appendLog);

window.addEventListener('resize', reportInset);
window.addEventListener('load', reportInset);
reportInset();
setInterval(updateElapsed, 1000);

api
  .getState()
  .then((initial) => {
    resetLog(initial?.logs ?? []);
    render(initial);
  })
  .catch((error) => {
    appendLog({ ts: Date.now(), stream: 'stderr', line: `初始化失败：${error?.message ?? error}` });
  });
