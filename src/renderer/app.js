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
const PHASES = ['checking', 'no-node', 'installing-node', 'missing-dsh', 'installing', 'starting', 'running', 'error'];

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
  runtimeMessage: document.getElementById('runtimeMessage'),
  runtimeBar: document.getElementById('runtimeBar'),
  runtimePercent: document.getElementById('runtimePercent'),
  runtimePhase: document.getElementById('runtimePhase'),
  runtimeDetail: document.getElementById('runtimeDetail'),
  runtimeElapsed: document.getElementById('runtimeElapsed'),
  installBar: document.getElementById('installBar'),
  installPercent: document.getElementById('installPercent'),
  installPhase: document.getElementById('installPhase'),
  installDetail: document.getElementById('installDetail'),
  installElapsed: document.getElementById('installElapsed'),
  startingText: document.getElementById('startingText'),
  errorTitle: document.getElementById('errorTitle'),
  errorMessage: document.getElementById('errorMessage'),
  errorHint: document.getElementById('errorHint'),
  tabs: document.getElementById('tabs'),
  tabButtons: [...document.querySelectorAll('.tab[data-tab]')],
  tabDshSub: document.getElementById('tabDshSub'),
  tabMarketSub: document.getElementById('tabMarketSub'),
  marketPanel: document.querySelector('.panel-market'),
  marketMeta: document.getElementById('marketMeta'),
  marketRuntime: document.getElementById('marketRuntime'),
  runtimeTitle: document.getElementById('runtimeTitle'),
  marketBanner: document.getElementById('marketBanner'),
  marketStats: document.getElementById('marketStats'),
  marketList: document.getElementById('marketList'),
  marketLocal: document.getElementById('marketLocal'),
  localCount: document.getElementById('localCount'),
  localList: document.getElementById('localList'),
  profileHint: document.getElementById('profileHint'),
  logPanel: document.getElementById('logPanel'),
  logToggle: document.getElementById('logToggle'),
  logBody: document.getElementById('logBody'),
  logCount: document.getElementById('logCount'),
};

/** @type {object|null} */
let state = null;
/** Local timestamps so the elapsed counters do not depend on main's clock. */
const localClock = { 'installing-node': null, installing: null, starting: null };

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

function detectionRows(detection, runtime) {
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
  if (detection.pnpm) {
    rows.push([
      'pnpm',
      detection.pnpm.available ? `${detection.pnpm.version ?? '可用'}` : '未安装（插件市场需要）',
      detection.pnpm.available ? 'ok' : 'bad',
    ]);
  }
  if (detection.dsh.command) rows.push(['dsh 路径', detection.dsh.command]);
  if (runtime?.dir) {
    rows.push(['托管运行时', `Node.js ${runtime.version ?? '?'} · ${runtime.dir}`]);
  }
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


// ------------------------------------------------------------------ 插件市场

/** Sub-label of the DSH tab (kept short — it sits under the title). */
function describeDshTab(next) {
  if (!next) return '未启动';
  const phaseLabels = {
    checking: '检测中',
    'no-node': '缺少运行时',
    'installing-node': '配置运行时',
    'missing-dsh': '未安装 dsh',
    installing: '安装 dsh',
    'ready-to-start': '待启动',
    starting: '启动中',
    running: '运行中',
    error: '出错',
  };
  const label = phaseLabels[next.phase] ?? next.phase ?? '未启动';
  const port = next.server?.port;
  return next.phase === 'running' && port ? `${label} · :${port}` : label;
}

/** Sub-label of the market tab. */
function describeMarketTab() {
  if (market.loading) return '加载中…';
  if (market.error) return '加载失败';
  if (!market.loaded) return '未加载';
  const updates = market.rows.filter((row) => row.status === 'update-available').length;
  return updates ? `${market.rows.length} 个插件 · ${updates} 个可更新` : `${market.rows.length} 个插件`;
}

/** Fetch the catalog + installed state and re-render the market tab. */
async function loadMarket() {
  market.loading = true;
  market.error = null;
  if (state) render(state);
  try {
    const data = await api.loadMarket();
    market.loaded = true;
    if (data?.ok === false) market.error = data.error ?? '目录加载失败';
    market.rows = Array.isArray(data?.rows) ? data.rows : [];
    market.localOnly = Array.isArray(data?.localOnly) ? data.localOnly : [];
    market.installed = data?.installed ?? null;
    market.meta = {
      source: data?.source ?? null,
      updatedAt: data?.updatedAt ?? null,
      fetchedAt: data?.fetchedAt ?? null,
      profile: data?.profile ?? null,
    };
    market.runtime = data?.dshRuntime ?? null;
    market.pnpm = data?.pnpm ?? null;
    market.groups = data?.groupCounts ?? null;
    market.community = data?.community ?? null;
  } catch (error) {
    market.loaded = true;
    market.error = error?.message ?? String(error);
  } finally {
    market.loading = false;
    if (state) render(state);
  }
}

/** React once when a plugin install/update finishes, to refresh versions. */
function trackPluginAction(next) {
  const action = next?.pluginAction;
  if (!action || action.running) return;
  const id = `${action.packages}@${action.finishedAt ?? action.step}`;
  if (handledPluginAction === id) return;
  handledPluginAction = id;
  if (action.ok) loadMarket();
}

function elWith(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const STATUS_TEXT = {
  'not-installed': () => '未安装',
  installed: (row) => `已安装 v${row.local?.version ?? '?'}（已是最新）`,
  'update-available': (row) => `已安装 v${row.local?.version ?? '?'} → 可更新到 v${row.version}`,
  'installed-unknown-version': () => '已安装（版本未知）',
};

/** Build one catalog card. Text goes through textContent: it is remote input. */
function pluginCard(row) {
  const card = elWith('article', 'plugin-card');

  const header = elWith('header');
  header.append(elWith('h3', null, row.name || row.package));
  header.append(elWith('span', 'pkg', row.package));
  header.append(elWith('span', 'version', `v${row.version}`));
  card.append(header);

  if (row.summary) card.append(elWith('p', 'summary', row.summary));

  if (Array.isArray(row.highlights) && row.highlights.length) {
    const list = elWith('ul', 'highlights');
    for (const item of row.highlights) list.append(elWith('li', null, item));
    card.append(list);
  }

  const facts = [];
  if (row.category) facts.push(row.category);
  if (row.group === 'community') {
    if (Number.isFinite(row.downloads)) facts.push(`月下载 ${formatCount(row.downloads)}`);
    if (Number.isFinite(row.stars)) facts.push(`★ ${formatCount(row.stars)}`);
  }
  if (row.enginesNode) facts.push(`Node ${row.enginesNode}`);
  if (Array.isArray(row.tags) && row.tags.length) facts.push(...row.tags);
  if (facts.length) {
    const tags = elWith('div', 'plugin-tags');
    for (const tag of facts.slice(0, 6)) tags.append(elWith('span', 'plugin-tag', tag));
    card.append(tags);
  }

  const footer = elWith('footer');
  const statusKind = row.status === 'update-available' ? 'is-update' : row.status === 'not-installed' ? 'is-missing' : 'is-installed';
  footer.append(elWith('span', `plugin-status ${statusKind}`, (STATUS_TEXT[row.status] ?? (() => row.status))(row)));

  const action = activePluginAction();
  const busy = Boolean(action && action.packages === row.package);

  if (row.status === 'not-installed') {
    footer.append(pluginButton('安装', 'plugin-install', row, false, busy));
  } else if (row.status === 'update-available') {
    footer.append(pluginButton(`更新到 v${row.version}`, 'plugin-install', row, true, busy));
    footer.append(uninstallButton(row, busy));
  } else if (row.local) {
    footer.append(uninstallButton(row, busy));
  }

  const link = row.homepage || row.npm;
  if (link) {
    const button = elWith('button', 'btn btn-ghost', '详情');
    button.dataset.action = 'plugin-open';
    button.dataset.url = link;
    footer.append(button);
  }
  if (row.repository) {
    const button = elWith('button', 'btn btn-ghost', '源码');
    button.dataset.action = 'plugin-open';
    button.dataset.url = row.repository;
    footer.append(button);
  }

  card.append(footer);
  return card;
}

/** Two-step uninstall: the first click only arms the button. */
function uninstallButton(row, busy) {
  const button = elWith('button', 'btn btn-ghost', '卸载');
  button.dataset.action = 'plugin-uninstall';
  button.dataset.package = row.package;
  if (busy) {
    button.disabled = true;
  }
  return button;
}

/** Compact number formatting for download/star counts. */
function formatCount(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function pluginButton(label, action, row, primary, busy) {
  const button = elWith('button', primary ? 'btn btn-primary' : 'btn', label);
  button.dataset.action = action;
  button.dataset.package = row.package;
  button.dataset.version = row.version;
  if (busy) {
    button.disabled = true;
    button.textContent = '处理中…';
  }
  return button;
}

/** The plugin action currently in flight, if any. */
function activePluginAction() {
  const action = state?.pluginAction;
  return action && action.running ? action : null;
}

/** Progress / result banner for the running or last plugin action. */
function renderPluginBanner(next) {
  const action = next?.pluginAction;
  const pnpm = next?.pnpm;

  el.marketBanner.hidden = false;
  el.marketBanner.className = 'market-banner';
  el.marketBanner.replaceChildren();

  // Priority: work in flight, then a blocker, then the last result. A missing
  // pnpm outranks a "finished" notice because it needs a decision from the user.
  if (action?.running || (pnpm?.installing && !action?.running)) {
    const spinner = elWith('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    el.marketBanner.append(spinner);
    const label = action?.running
      ? `${action.step ?? (action.kind === 'uninstall' ? '正在卸载' : '正在安装')} — ${action.packages}`
      : `正在配置 pnpm — ${pnpm?.error ?? '插件市场依赖'}`;
    el.marketBanner.append(elWith('span', null, label));
    const cancel = elWith('button', 'btn btn-ghost', '取消');
    cancel.dataset.action = action?.running ? 'plugin-cancel' : 'plugin-dismiss';
    el.marketBanner.append(cancel);
    return;
  }

  if (pnpm && pnpm.available === false) {
    el.marketBanner.classList.add('is-error');
    el.marketBanner.append(
      elWith('span', null, `插件安装需要 pnpm：${pnpm.failedReason ?? pnpm.error ?? '未检测到 pnpm'}`),
    );
    const setup = elWith('button', 'btn btn-ghost', '自动配置 pnpm');
    setup.dataset.action = 'market-setup-pnpm';
    el.marketBanner.append(setup);
    return;
  }

  if (!action) {
    el.marketBanner.hidden = true;
    return;
  }

  el.marketBanner.classList.add(action.ok ? 'is-ok' : 'is-error');
  const version = action.version ? `@${action.version}` : '';
  el.marketBanner.append(
    elWith('span', null, action.ok
      ? action.kind === 'uninstall'
        ? `${action.packages} 已卸载，DSH 已重启并刷新界面`
        : `${action.packages}${version} 已就绪，DSH 已重启并刷新界面`
      : `插件操作失败：${action.error ?? '未知错误'}`),
  );
  const dismiss = elWith('button', 'btn btn-ghost', '知道了');
  dismiss.dataset.action = 'plugin-dismiss';
  el.marketBanner.append(dismiss);
}

/** Render the whole market tab from the cached catalog + live shell state. */
function renderMarket(next) {
  renderPluginBanner(next);

  const meta = market.meta ?? {};
  const parts = [];
  if (meta.updatedAt) parts.push(`目录更新于 ${meta.updatedAt}`);
  if (meta.source) parts.push(meta.source);
  setText(el.marketMeta, parts.length ? parts.join(' · ') : '正在读取目录…');

  // Which dsh and which profile the market is acting on: a private install or a
  // custom DSH_HOME makes this the difference between "works" and "installs
  // somewhere else", so it is always on screen.
  const runtimeInfo = market.runtime ?? {};
  const runtimeParts = [];
  if (runtimeInfo.profileDir) runtimeParts.push(`profile ${runtimeInfo.profileDir}`);
  if (runtimeInfo.command) runtimeParts.push(`dsh ${runtimeInfo.command}${runtimeInfo.version ? ` (v${runtimeInfo.version})` : ''}`);
  if (runtimeInfo.private) runtimeParts.push('私有安装');
  if (next.offline?.enabled) {
    runtimeParts.push(`离线内置${next.offline.dsh ? ` dsh ${next.offline.dsh}` : ''}`);
  }
  const pnpm = next.pnpm;
  if (pnpm) runtimeParts.push(pnpm.available ? `pnpm ${pnpm.version ?? '可用'}` : 'pnpm 不可用');
  setText(el.marketRuntime, runtimeParts.join(' · '));

  const installed = market.installed;
  const updates = market.rows.filter((row) => row.status === 'update-available').length;
  const installedCount = market.rows.filter((row) => row.local).length + market.localOnly.length;
  el.marketStats.replaceChildren();
  const groups = market.groups ?? {};
  const stats = [
    ['本站维护', String(groups['first-party'] ?? market.rows.filter((row) => row.group !== 'community').length)],
    ['社区插件', String(groups.community ?? market.rows.filter((row) => row.group === 'community').length)],
    ['已安装', String(installedCount)],
    ['可更新', String(updates)],
  ];
  if (installed && installed.exists === false) stats.push(['profile', '未初始化']);
  for (const [label, value] of stats) {
    const item = elWith('span');
    item.append(elWith('b', null, value), document.createTextNode(` ${label}`));
    el.marketStats.append(item);
  }

  el.marketList.replaceChildren();
  if (market.loading && !market.rows.length) {
    el.marketList.append(elWith('div', 'market-placeholder', '正在加载插件目录…'));
  } else if (market.error && !market.rows.length) {
    el.marketList.append(elWith('div', 'market-placeholder', `目录加载失败：${market.error}`));
  } else if (!market.rows.length) {
    el.marketList.append(elWith('div', 'market-placeholder', '目录中暂无插件'));
  } else {
    // The catalog carries two groups: the site's own plugins and community
    // picks. They are shown as separate sections, each with its own note.
    const sections = [
      { key: 'first-party', title: '本站维护', rows: market.rows.filter((row) => row.group !== 'community') },
      { key: 'community', title: '社区插件', rows: market.rows.filter((row) => row.group === 'community') },
    ];
    for (const section of sections) {
      if (!section.rows.length) continue;
      const header = elWith('div', 'market-section');
      const title = elWith('h3');
      title.append(document.createTextNode(section.title), elWith('span', 'count', String(section.rows.length)));
      header.append(title);
      if (section.key === 'community' && market.community?.note) {
        header.append(elWith('p', 'muted small', market.community.note));
      }
      el.marketList.append(header);
      for (const row of section.rows) el.marketList.append(pluginCard(row));
    }
  }

  setText(el.localCount, market.rows.filter((row) => row.local).length + market.localOnly.length);
  setText(el.profileHint, installed?.dir ? `插件安装位置：${installed.dir}` : '');
  el.localList.replaceChildren();
  const localPlugins = [
    ...market.rows.filter((row) => row.local).map((row) => ({ ...row.local, catalog: row })),
    ...market.localOnly,
  ];
  if (!localPlugins.length) {
    el.localList.append(elWith('div', 'muted small', installed?.error ?? '尚未安装任何插件'));
  }
  for (const plugin of localPlugins) {
    const row = elWith('div', 'local-row');
    row.append(elWith('span', 'name', plugin.name ?? plugin.package));
    row.append(elWith('span', 'ver', plugin.version ? `v${plugin.version}` : '版本未知'));
    row.append(elWith('span', 'src', plugin.spec ? `${plugin.source}: ${plugin.spec}` : '未在依赖中登记'));
    const isBusy = Boolean(activePluginAction() && activePluginAction().packages === plugin.package);
    const remove = elWith('button', 'btn btn-ghost', '卸载');
    remove.dataset.action = 'plugin-uninstall';
    remove.dataset.package = plugin.package;
    remove.disabled = isBusy;
    row.append(remove);
    row.append(elWith('span', 'bundle', plugin.bundle ? '已启用' : '未启用'));
    el.localList.append(row);
  }
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

// -------------------------------------------------------------------- tabs

/** Switch the top tab and tell main, which shows/hides the embedded dsh view. */
function switchTab(tab) {
  activeTab = tab === 'market' ? 'market' : 'dsh';
  for (const button of el.tabButtons) {
    const active = button.dataset.tab === activeTab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }
  if (activeTab === 'market' && !market.loaded && !market.loading) loadMarket();
  api.setActiveTab(activeTab).catch(() => {});
  if (state) render(state);
  reportInset();
}

// ------------------------------------------------------------ toolbar actions

const ACTION_SPECS = {
  checking: [],
  // Normal path is automatic; this panel is the failure fallback.
  'no-node': [
    { label: '自动配置运行时', action: 'install-node', primary: true },
    { label: '重新检测', action: 'detect' },
  ],
  'installing-node': [{ label: '取消', action: 'cancel-node-install' }],
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

/** Active shell tab: `dsh` shows the embedded Web view, `market` the market. */
let activeTab = 'dsh';
/** Last plugin action id we already reacted to, so a finished install reloads once. */
let handledPluginAction = null;
/** Catalog + installed state rendered by the market tab. */
const market = { loading: false, loaded: false, error: null, rows: [], localOnly: [], installed: null, meta: null, runtime: null, pnpm: null, groups: null, community: null };

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
  // Normal path is automatic; this panel is the failure fallback.
  'no-node': [
    { label: '自动配置运行时', action: 'install-node', primary: true },
    { label: '重新检测', action: 'detect' },
  ],
  'installing-node': [{ label: '取消', action: 'cancel-node-install' }],
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

/**
 * Open/close the ⋮ dropdown.
 *
 * The embedded dsh Web view is a native view stacked *above* this renderer, so
 * a dropdown that extends below the top bar would be painted underneath it and
 * look unresponsive. The view is therefore hidden while the menu is open and
 * restored to whatever the user had chosen afterwards.
 */
function openMenu(open) {
  const wasOpen = !el.menuList.hidden;
  const shouldOpen = open ?? !wasOpen;
  el.menuList.hidden = !shouldOpen;
  el.menuBtn.setAttribute('aria-expanded', String(shouldOpen));
  // `guiHidden` is the user's own preference (the 查看日志 toggle); the menu
  // only borrows the view's visibility, and only when it actually changed.
  if (shouldOpen !== wasOpen) {
    api.setGuiVisible(shouldOpen ? false : !guiHidden).catch(() => {});
  }
}

// -------------------------------------------------------------------- render

function render(next) {
  const previousPhase = state?.phase ?? null;
  state = next;
  trackPluginAction(next);

  const phase = PHASES.includes(next.phase) ? next.phase : 'checking';

  if (phase !== previousPhase) {
    if (phase === 'installing-node') localClock['installing-node'] = Date.now();
    if (phase === 'installing') localClock.installing = Date.now();
    if (phase === 'starting') localClock.starting = Date.now();
    // Main resets the manual hide on every phase change; keep the labels in sync.
    if (phase !== 'running') guiHidden = false;
  }

  const showPhasePanel = activeTab === 'dsh';
  for (const [name, panel] of el.panels) {
    panel.classList.toggle('active', showPhasePanel && name === phase);
  }
  el.marketPanel.classList.toggle('active', activeTab === 'market');

  // --- status strip: machine name + dsh version (the port stays internal) ---
  setText(el.statusText, next.statusText ?? '');
  setText(el.tabDshSub, describeDshTab(next));
  setText(el.tabMarketSub, describeMarketTab());
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
  const rows = detectionRows(next.detection, next.runtime);
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

  const runtime = next.runtime;
  if (phase === 'installing-node') {
    setText(el.runtimeTitle, next.statusText || '正在配置运行环境');
  }
  if (phase === 'installing-node' && runtime) {
    setText(el.runtimePercent, `${runtime.percent ?? 0}%`);
    el.runtimeBar.style.width = `${runtime.percent ?? 0}%`;
    setText(el.runtimePhase, runtime.phase ?? '正在配置运行时');
    setText(el.runtimeDetail, runtime.detail || '正在准备…');
  }

  if (phase === 'no-node') {
    setText(
      el.runtimeMessage,
      next.error ? `${next.error.message}${next.error.hint ? ` — ${next.error.hint}` : ''}` : '',
    );
  }

  if (phase === 'starting') {
    setText(el.startingText, next.statusText ?? '等待 dsh 打印 Web 服务地址');
  }

  if (activeTab === 'market') renderMarket(next);

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
  if (state.phase === 'installing-node' && localClock['installing-node']) {
    setText(el.runtimeElapsed, `已用时 ${formatDuration(Date.now() - localClock['installing-node'])}`);
  }
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
  'install-node': () => api.installNode(),
  'cancel-node-install': () => api.cancelNodeInstall(),
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
  'market-refresh': () => loadMarket(),
  'market-open-site': () => api.openExternal('https://dsh.textwork.cn/plugins/'),
  'plugin-install': (button) =>
    api.installPlugin({ packageName: button.dataset.package, version: button.dataset.version || null }),
  'plugin-open': (button) => api.openExternal(button.dataset.url),
  'plugin-cancel': () => api.cancelPlugin(),
  'plugin-uninstall': (button) => {
    // First click arms the button; the second one really removes the plugin.
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = '确认卸载';
      button.classList.add('btn-danger');
      setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.confirm = '';
        button.textContent = '卸载';
        button.classList.remove('btn-danger');
      }, 3000);
      return undefined;
    }
    button.disabled = true;
    return api.uninstallPlugin({ packageName: button.dataset.package });
  },
  'market-setup-pnpm': async () => {
    await api.setupPnpm();
    await loadMarket();
  },
  'plugin-dismiss': () => {
    if (state) {
      state = { ...state, pluginAction: null };
      render(state);
    }
  },
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

el.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('.tab[data-tab]');
  if (button) switchTab(button.dataset.tab);
});

el.quitBtn.addEventListener('click', () => api.quit());

el.logToggle.addEventListener('click', () => {
  const collapsed = el.logPanel.classList.toggle('collapsed');
  el.logToggle.setAttribute('aria-expanded', String(!collapsed));
});

// Keep the embedded GUI view aligned with our own toolbar height.
function reportInset() {
  // The tabs live inside the top bar now, so the embedded view starts right
  // below that single row.
  const height = Math.round(el.toolbar.getBoundingClientRect().height);
  if (height > 0) api.setViewInset({ top: height });
}

// ---------------------------------------------------------------- bootstrap

api.onState(render);
api.onLog(appendLog);
api.setActiveTab('dsh').catch(() => {});

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
