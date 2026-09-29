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
  tabKernelSub: document.getElementById('tabKernelSub'),
  kernelPanel: document.querySelector('.panel-kernel'),
  kernelMeta: document.getElementById('kernelMeta'),
  kernelRuntime: document.getElementById('kernelRuntime'),
  kernelBanner: document.getElementById('kernelBanner'),
  kernelHighlights: document.getElementById('kernelHighlights'),
  kernelStats: document.getElementById('kernelStats'),
  kernelList: document.getElementById('kernelList'),
  kernelPreToggle: document.getElementById('kernelPreToggle'),
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
  // 外壳自身更新
  updateBar: document.getElementById('updateBar'),
  updateTag: document.getElementById('updateTag'),
  updateTitle: document.getElementById('updateTitle'),
  updateNote: document.getElementById('updateNote'),
  updateProgress: document.getElementById('updateProgress'),
  updateBarFill: document.getElementById('updateBarFill'),
  updatePercent: document.getElementById('updatePercent'),
  updatePrimary: document.getElementById('updatePrimary'),
  updateLater: document.getElementById('updateLater'),
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

// ------------------------------------------------------------------ dsh 内核

/**
 * Kernel panel state.
 *
 * The version list itself arrives in `state.kernel` (main builds it from the
 * cached catalog), so this module only remembers what the user asked for
 * (pre-release toggle), the dismissable action result, and whether a fetch has
 * happened yet.
 */
const kernel = { requested: false, handledAction: null, dismissed: null };

const KERNEL_TYPE_BADGE = {
  release: 'badge-ok',
  rc: 'badge-rc',
  alpha: 'badge-warn',
  prerelease: 'badge-warn',
};

function kernelTypeLabel(type) {
  if (type === 'release') return '正式版';
  if (type === 'rc') return 'RC 候选版';
  if (type === 'alpha') return 'Alpha 内测版';
  return '预发布';
}

function describeKernelTab(next) {
  const view = next?.kernel;
  if (!view || !view.loaded) return view?.loading ? '加载中…' : '未加载';
  const version = view.version ? `v${view.version}` : '未检测';
  const status = view.recommendation?.status;
  if (status === 'update') return `${version} · 可更新`;
  if (status === 'preview') return `${version} · 有预览版`;
  return version;
}

/** Load (or re-filter) the published dsh versions. */
async function loadKernel(options = {}) {
  kernel.requested = true;
  try {
    const next = await api.loadKernel({
      refresh: options.refresh === true,
      includePre: Boolean(el.kernelPreToggle.checked),
    });
    if (next) render(next);
  } catch (error) {
    appendLog({ ts: Date.now(), stream: 'stderr', line: `读取 dsh 版本目录失败：${error?.message ?? error}` });
  }
}

function kernelBadge(text, className) {
  const badge = elWith('span', `badge ${className}`, text);
  return badge;
}

/** One published version row. */
function kernelRow(row, view) {
  const wrap = elWith('div', 'kernel-row');
  wrap.dataset.version = row.version;
  if (row.version === view.version) wrap.classList.add('is-current');
  if (row.recommended) wrap.classList.add('is-recommended');

  const head = elWith('div', 'kernel-row-head');
  const version = elWith('b', 'kernel-ver', `v${row.version}`);
  head.append(version);
  head.append(kernelBadge(kernelTypeLabel(row.type), KERNEL_TYPE_BADGE[row.type] ?? 'badge-warn'));
  if (row.version === view.version) head.append(kernelBadge('当前版本', 'badge-ok'));
  for (const tag of row.tags ?? []) head.append(kernelBadge(tag, 'badge-tag'));
  if ((row.sources ?? []).includes('git')) head.append(kernelBadge('git 已发布', 'badge-ghost'));
  if (row.installable === false) head.append(kernelBadge('未发布到 npm', 'badge-warn'));
  if (row.deprecated) head.append(kernelBadge('已弃用', 'badge-warn'));
  wrap.append(head);

  const facts = [];
  if (row.publishedAt) facts.push(`发布于 ${String(row.publishedAt).slice(0, 10)}`);
  facts.push(row.installable === false ? '来源 git 标签（不可安装）' : 'npm 可安装');
  if (row.relation === 'newer' && row.version !== view.version) facts.push('比当前新');
  if (row.relation === 'older') facts.push('比当前旧');
  wrap.append(elWith('div', 'muted small', facts.join(' · ')));

  const actions = elWith('div', 'kernel-row-actions');
  const locked = view.locked;
  const busy = Boolean(view.actionRunning);
  const install = elWith(
    'button',
    row.version === view.version ? 'btn btn-compact' : 'btn btn-primary btn-compact',
    row.version === view.version ? '重新安装' : row.relation === 'older' ? '切换到该版本' : '安装此版本',
  );
  install.dataset.action = 'kernel-install';
  install.dataset.version = row.version;
  install.disabled = Boolean(locked) || row.installable === false || busy;
  if (locked) install.title = locked.reason;
  if (row.installable === false) install.title = '该版本只出现在 git 标签里，npm 上没有对应包';
  actions.append(install);
  if (row.notes) {
    const toggle = elWith('button', 'btn btn-ghost btn-compact', '发布说明');
    toggle.dataset.action = 'kernel-notes';
    actions.append(toggle);
  }
  if (row.releaseUrl) {
    const open = elWith('button', 'btn btn-ghost btn-compact', '官方页面');
    open.dataset.action = 'kernel-open-release';
    open.dataset.url = row.releaseUrl;
    actions.append(open);
  }
  wrap.append(actions);

  if (row.notes) {
    const details = elWith('details', 'kernel-notes');
    details.hidden = true;
    const body = elWith('pre', 'kernel-notes-body', row.notes);
    details.append(body);
    wrap.append(details);
  }
  return wrap;
}

/** Headline cards: the `latest` and `next` dist-tags. */
function kernelHighlights(view) {
  el.kernelHighlights.replaceChildren();
  const cards = [
    { key: 'latest', row: view.highlights?.latestRow, title: '最新发布版本', note: 'npm dist-tag latest' },
    { key: 'next', row: view.highlights?.nextRow, title: '下一版本预览', note: 'npm dist-tag next' },
  ];
  for (const card of cards) {
    if (!card.row) continue;
    const node = elWith('div', 'kernel-card');
    const head = elWith('div', 'kernel-card-head');
    head.append(elWith('span', 'kernel-card-title', card.title));
    head.append(kernelBadge(kernelTypeLabel(card.row.type), KERNEL_TYPE_BADGE[card.row.type] ?? 'badge-warn'));
    node.append(head);
    node.append(elWith('div', 'kernel-card-version', `v${card.row.version}`));
    const facts = [card.note];
    if (card.row.publishedAt) facts.push(String(card.row.publishedAt).slice(0, 10));
    node.append(elWith('div', 'muted small', facts.join(' · ')));
    const button = elWith(
      'button',
      'btn btn-primary btn-compact',
      card.row.version === view.version ? '重新安装' : '安装',
    );
    button.dataset.action = 'kernel-install';
    button.dataset.version = card.row.version;
    button.disabled = Boolean(view.locked) || view.actionRunning || card.row.installable === false;
    if (view.locked) button.title = view.locked.reason;
    node.append(button);
    el.kernelHighlights.append(node);
  }
}

/** Progress / result banner for the running or last core action. */
function renderKernelBanner(next) {
  const view = next?.kernel ?? {};
  const action = next?.kernelAction ?? null;
  const running = Boolean(action?.running);
  const dismissed = action?.finishedAt && kernel.dismissed === action.finishedAt;
  const locked = view.locked;
  const error = view.error;

  const show = (running && !dismissed) || (action && !running && !dismissed) || (error && !view.loaded) || Boolean(locked);
  el.kernelBanner.hidden = !show;
  el.kernelBanner.className = 'market-banner';
  el.kernelBanner.replaceChildren();
  if (!show) return;

  if (locked) {
    el.kernelBanner.classList.add('is-warn');
    el.kernelBanner.append(elWith('span', 'market-banner-text', `内核更新已停用：${locked.reason}`));
    return;
  }

  if (error && !view.loaded) {
    el.kernelBanner.classList.add('is-error');
    const text = elWith('div', 'market-banner-text');
    text.append(elWith('b', null, '版本目录读取失败'), elWith('span', null, error));
    el.kernelBanner.append(text);
    const retry = elWith('button', 'btn btn-compact', '重试');
    retry.dataset.action = 'kernel-refresh';
    el.kernelBanner.append(retry);
    return;
  }

  if (!action) return;
  if (running) {
    const text = elWith('div', 'market-banner-text');
    text.append(
      elWith('b', null, `正在安装 dsh ${action.version}`),
      elWith('span', null, action.step ? `· ${action.step}` : ''),
    );
    el.kernelBanner.append(text);
    const progress = elWith('div', 'market-banner-progress');
    const bar = elWith('div', 'bar');
    const fill = elWith('div', 'bar-fill');
    fill.style.width = `${action.percent ?? 0}%`;
    bar.append(fill);
    progress.append(bar, elWith('span', 'muted small', `${action.percent ?? 0}%`));
    el.kernelBanner.append(progress);
    const cancel = elWith('button', 'btn btn-compact', '取消');
    cancel.dataset.action = 'kernel-cancel';
    el.kernelBanner.append(cancel);
    return;
  }

  const ok = action.ok === true;
  el.kernelBanner.classList.add(ok ? 'is-ok' : 'is-error');
  const text = elWith('div', 'market-banner-text');
  if (ok) {
    const change = action.from && action.installedVersion ? `${action.from} → ${action.installedVersion}` : action.version;
    text.append(elWith('b', null, '内核已更新'), elWith('span', null, `· ${change} · dsh 已重启`));
  } else if (action.cancelled) {
    text.append(elWith('b', null, '已取消'), elWith('span', null, `· 未安装 ${action.version}`));
  } else {
    text.append(elWith('b', null, action.step ?? '更新失败'), elWith('span', null, action.error ? `· ${action.error}` : ''));
  }
  el.kernelBanner.append(text);
  if (!ok && action.hint) el.kernelBanner.append(elWith('span', 'muted small', action.hint));
  if (ok && action.hint) el.kernelBanner.append(elWith('span', 'muted small', action.hint));
  const close = elWith('button', 'btn btn-ghost btn-compact', '关闭');
  close.dataset.action = 'kernel-dismiss';
  close.dataset.stamp = String(action.finishedAt ?? '');
  el.kernelBanner.append(close);
}

function renderKernel(next) {
  const view = next?.kernel ?? {};
  const action = next?.kernelAction ?? null;

  // The panel needs the catalog once; the first tab switch triggers the fetch.
  if (kernel.requested && !view.loaded && !view.loading && !view.error) loadKernel();

  renderKernelBanner(next);
  el.kernelPreToggle.checked = view.includePre === true;

  const meta = [];
  if (view.loading) meta.push('正在读取 npm / GitHub 官方版本…');
  else if (view.error) meta.push(`读取失败：${view.error}`);
  else if (view.loaded) {
    if (view.fetchedAt) meta.push(`目录更新于 ${new Date(view.fetchedAt).toLocaleString('zh-CN', { hour12: false })}`);
    meta.push('来源 npm + GitHub 官方发布');
  } else meta.push('尚未读取版本目录');
  if (view.notes?.length) meta.push(`部分来源不可用：${view.notes.join('；')}`);
  setText(el.kernelMeta, meta.join(' · '));

  const runtime = view.runtime ?? {};
  const runtimeParts = [];
  runtimeParts.push(view.version ? `当前 dsh v${view.version}` : '未检测到 dsh');
  if (runtime.command) runtimeParts.push(runtime.command);
  if (runtime.private) runtimeParts.push('外壳私有安装');
  if (runtime.bundled) runtimeParts.push('离线内置');
  if (runtime.home) runtimeParts.push(`DSH_HOME ${runtime.home}`);
  setText(el.kernelRuntime, runtimeParts.join(' · '));

  // Everything below is about the version list.
  setText(
    el.kernelStats,
    view.loaded
      ? `${view.rows.length} 个版本${view.hidden ? `（另有 ${view.hidden} 个预发布版本被折叠）` : ''} · ${view.recommendation?.reason ?? ''}`
      : '',
  );

  const annotatedView = { ...view, actionRunning: Boolean(action?.running) };
  kernelHighlights(annotatedView);

  el.kernelList.replaceChildren();
  if (view.loading && !view.rows.length) {
    el.kernelList.append(elWith('div', 'market-placeholder', '正在读取官方版本目录…'));
    return;
  }
  if (!view.loaded) {
    el.kernelList.append(
      elWith(
        'div',
        'market-placeholder',
        view.error ? `版本目录读取失败：${view.error}` : '点击「重新读取目录」以获取 dsh 官方版本',
      ),
    );
    return;
  }
  if (!view.rows.length) {
    el.kernelList.append(elWith('div', 'market-placeholder', '没有符合当前筛选条件的版本'));
    return;
  }

  // Rows carry the target version for the install button; the list itself is
  // remote input, so it is built with textContent only.
  for (const row of view.rows) el.kernelList.append(kernelRow(row, annotatedView));
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
const TAB_NAMES = ['dsh', 'kernel', 'market'];

function switchTab(tab) {
  activeTab = TAB_NAMES.includes(tab) ? tab : 'dsh';
  for (const button of el.tabButtons) {
    const active = button.dataset.tab === activeTab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }
  // Both panels fetch on first visit only; the dsh tab is the embedded view.
  if (activeTab === 'market' && !market.loaded && !market.loading) loadMarket();
  // `kernelCaptureSkipFetch` lets the UI capture / self-test render a fixture
  // instead of hitting the registry.
  if (activeTab === 'kernel' && !kernel.requested && !window.kernelCaptureSkipFetch) loadKernel();
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
    { label: '打印当前页面', action: 'print-gui' },
    { label: '导出为 PDF…', action: 'export-pdf' },
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
  const updateSpec = updateMenuSpec();
  // The shell's own update entry is appended to every phase menu: updating the
  // shell is independent of what dsh is doing (even of dsh being installed).
  const all = [...specs, { separator: true }, updateSpec];
  for (const spec of all) {
    if (spec.separator) {
      const rule = document.createElement('div');
      rule.className = 'menu-sep';
      el.menuList.append(rule);
      continue;
    }
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.dataset.action = spec.action;
    if (spec.action.startsWith('update-')) item.classList.add('menu-item-update');
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

// ------------------------------------------------------- 外壳自身更新（自更新）

/**
 * Self-update state pushed by main on its own channel.
 *
 * It is kept apart from the dsh state on purpose: the shell's own version has
 * nothing to do with whether the Harness is installed or running, and the
 * updater must stay usable while dsh is in any phase (including `error`).
 *
 * @type {object|null}
 */
let updateState = null;
/** Version the user dismissed with 稍后, so the bar does not reappear by itself. */
let updateDismissed = null;
/** `已是最新版本` style notices auto-hide after this timestamp. */
let updateNoticeUntil = 0;

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const mb = value / (1024 * 1024);
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** Label + action for the ⋮ menu entry (it doubles as the update entry point). */
function updateMenuSpec() {
  const phase = updateState?.phase ?? 'idle';
  const latest = updateState?.latestVersion ?? '';
  const current = updateState?.currentVersion ?? '';
  switch (phase) {
    case 'available':
      return { label: `下载更新 v${latest}`, action: 'update-primary' };
    case 'downloading':
      return { label: `正在下载更新 v${latest}…`, action: 'update-primary' };
    case 'ready':
      return { label: `重启并安装 v${latest}`, action: 'update-primary' };
    case 'manual':
      return {
        label: updateState?.downloadedPath ? `打开更新包 v${latest}` : `下载更新包 v${latest}`,
        action: 'update-primary',
      };
    case 'error':
      return { label: '检查更新（上次失败，重试）', action: 'update-check' };
    default:
      return { label: `检查更新（当前 v${current || '?'}）`, action: 'update-check' };
  }
}

/** Paint the update bar (and the menu badge) from the latest snapshot. */
function renderUpdate(next) {
  if (next) updateState = next;
  const snapshot = updateState;
  const phase = snapshot?.phase ?? 'idle';
  const latest = snapshot?.latestVersion ?? '';
  const current = snapshot?.currentVersion ?? '';
  // `reason` says why the last check ran: only a check the user asked for (or a
  // download they started) may put something on screen by itself.
  const asked = snapshot?.reason === 'manual' || snapshot?.reason === 'download';
  const hasUpdate = Boolean(latest) && latest !== current;
  const pending = hasUpdate && (phase === 'available' || phase === 'ready');

  el.menuBtn.classList.toggle('has-update', pending);
  el.menuBtn.title = pending ? `有可用更新 v${latest}（打开菜单）` : '菜单';

  if (asked && phase === 'current') {
    if (!updateNoticeUntil) updateNoticeUntil = Date.now() + 6000;
  } else if (phase !== 'idle') {
    updateNoticeUntil = 0;
  }

  // 稍后 hides *this version*; a running download is never hidden, and the
  // ⋮ menu keeps offering the update afterwards.
  const dismissed = hasUpdate && updateDismissed === latest && phase !== 'downloading';
  const persistent =
    (hasUpdate && ['available', 'ready', 'manual'].includes(phase)) ||
    phase === 'downloading' ||
    phase === 'applying' ||
    (phase === 'error' && asked);
  const toast = asked && phase === 'current' && Date.now() < updateNoticeUntil;
  const show = (persistent && !dismissed) || toast;
  const wasHidden = el.updateBar.hidden;

  el.updateBar.hidden = !show;
  el.updateBar.dataset.phase = phase;
  el.updateProgress.hidden = phase !== 'downloading';

  if (show) {
    // 离线版有自己的产物（linux-offline），标签上标出来避免误会。
    const offlineTag = snapshot?.variant === 'offline' ? '离线版 · ' : '';
    const size = formatSize(snapshot?.size);
    const file = snapshot?.file ?? '';
    const notes = String(snapshot?.notes ?? '').trim().split('\n')[0];
    switch (phase) {
      case 'available':
        setText(el.updateTag, `${offlineTag}有可用更新`);
        setText(el.updateTitle, `发现新版本 v${latest}（当前 v${current}）`);
        setText(el.updateNote, [notes, file && size ? `${file} · ${size}` : file].filter(Boolean).join(' · '));
        setText(el.updatePrimary, '下载更新');
        el.updatePrimary.hidden = false;
        el.updateLater.hidden = false;
        break;
      case 'downloading': {
        const percent = snapshot?.progress?.percent;
        setText(el.updateTag, `${offlineTag}下载中`);
        setText(el.updateTitle, `正在下载 v${latest}`);
        setText(
          el.updateNote,
          `${formatSize(snapshot?.progress?.received ?? 0)} / ${size || '—'}${
            snapshot?.source ? ` · ${snapshot.source.replace(/^https?:\/\//, '')}` : ''
          }`,
        );
        el.updateBarFill.style.width = `${percent ?? 0}%`;
        setText(el.updatePercent, percent == null ? '…' : `${percent}%`);
        el.updatePrimary.hidden = true;
        el.updateLater.hidden = true;
        break;
      }
      case 'ready':
        setText(el.updateTag, `${offlineTag}待安装`);
        setText(el.updateTitle, `v${latest} 已下载并通过 SHA-256 校验`);
        setText(el.updateNote, '点击后外壳会退出，由辅助程序替换文件并重新启动（dsh 会一起重启）');
        setText(el.updatePrimary, '重启并安装');
        el.updatePrimary.hidden = false;
        el.updateLater.hidden = false;
        break;
      case 'manual':
        setText(el.updateTag, `${offlineTag}需手动安装`);
        setText(el.updateTitle, `v${latest} 可用，但当前安装方式无法自动替换`);
        setText(el.updateNote, snapshot?.plan?.note ?? '请手动安装下载的包');
        setText(el.updatePrimary, snapshot?.downloadedPath ? '打开所在目录' : '下载安装包');
        el.updatePrimary.hidden = false;
        el.updateLater.hidden = false;
        break;
      case 'applying':
        setText(el.updateTag, '安装中');
        setText(el.updateTitle, '正在应用更新，外壳即将重启…');
        setText(el.updateNote, snapshot?.plan?.note ?? '');
        el.updatePrimary.hidden = true;
        el.updateLater.hidden = true;
        break;
      case 'error':
        setText(el.updateTag, '更新失败');
        setText(el.updateTitle, '无法完成外壳更新');
        setText(el.updateNote, snapshot?.error ?? '未知错误');
        setText(el.updatePrimary, latest ? '重试' : '重新检查');
        el.updatePrimary.hidden = false;
        el.updateLater.hidden = false;
        break;
      default:
        setText(el.updateTag, '更新');
        setText(el.updateTitle, `已是最新版本 v${current}`);
        setText(el.updateNote, '外壳会定期检查更新，也可以随时在右上角菜单里手动检查');
        el.updatePrimary.hidden = true;
        el.updateLater.hidden = true;
        break;
    }
    if (toast && !renderUpdate.noticeTimer) {
      renderUpdate.noticeTimer = setTimeout(() => {
        renderUpdate.noticeTimer = null;
        if (updateState?.phase === 'current') renderUpdate();
      }, 6200);
    }
  }

  if (wasHidden !== el.updateBar.hidden) reportInset();
  // The ⋮ entry doubles as the update entry point, so its label/action follow
  // this state (idle → 检查更新, available → 下载更新, ready → 重启并安装).
  renderMenu(state?.phase ?? 'checking');
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
  el.kernelPanel.classList.toggle('active', activeTab === 'kernel');

  // --- status strip: machine name + dsh version (the port stays internal) ---
  setText(el.statusText, next.statusText ?? '');
  setText(el.tabDshSub, describeDshTab(next));
  setText(el.tabMarketSub, describeMarketTab());
  setText(el.tabKernelSub, describeKernelTab(next));
  renderKernel(next);
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
  'print-gui': async () => {
    // The system panel is modal; feedback lands in the log panel.
    const result = await api.printGui();
    if (result && result.ok === false && result.reason && result.reason !== 'cancelled') {
      appendLog({ ts: Date.now(), stream: 'stderr', line: `打印未完成：${result.reason}` });
    }
  },
  'export-pdf': async () => {
    const result = await api.exportGuiPdf();
    if (result?.ok) {
      appendLog({ ts: Date.now(), stream: 'system', line: `已导出 PDF：${result.path}` });
    }
  },
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
  // --- dsh 内核 ---
  'kernel-refresh': async () => {
    await loadKernel({ refresh: true });
  },
  'kernel-install': async (button) => {
    const version = button.dataset.version;
    if (!version) return undefined;
    // Replacing the Harness is a real change to the running stack: confirm once.
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      const original = button.textContent;
      button.textContent = `确认安装 v${version}`;
      button.classList.add('btn-danger');
      setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.confirm = '';
        button.textContent = original;
        button.classList.remove('btn-danger');
      }, 4000);
      return undefined;
    }
    button.disabled = true;
    kernel.dismissed = null;
    appendLog({ ts: Date.now(), stream: 'system', line: `开始安装 dsh 内核 v${version}…` });
    const result = await api.installKernel({ version });
    if (result && result.ok === false && result.error) {
      appendLog({ ts: Date.now(), stream: 'stderr', line: `dsh 内核更新失败：${result.error}` });
    }
    await loadKernel();
    return result;
  },
  'kernel-cancel': () => api.cancelKernel(),
  'kernel-dismiss': (button) => {
    kernel.dismissed = Number(button.dataset.stamp) || Date.now();
    if (state) render(state);
  },
  'kernel-notes': (button) => {
    const row = button.closest('.kernel-row');
    const details = row?.querySelector('.kernel-notes');
    if (details) details.hidden = !details.hidden;
  },
  'kernel-open-release': (button) =>
    api.openExternal(button.dataset.url || 'https://github.com/deepseek-ai/deepseek-harness/releases'),
  'kernel-open-releases': () => api.openExternal('https://github.com/deepseek-ai/deepseek-harness/releases'),
  'kernel-tab': () => switchTab('kernel'),
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
  // --- 外壳自更新 ---
  'update-check': async () => {
    el.updateLater.hidden = false;
    const snapshot = await api.checkUpdate();
    updateNoticeUntil = 0;
    renderUpdate(snapshot ?? updateState);
  },
  'update-primary': async () => {
    const phase = updateState?.phase;
    const downloaded = Boolean(updateState?.downloadedPath);
    if (phase === 'ready' || (phase === 'manual' && downloaded)) {
      const result = await api.applyUpdate();
      if (result && result.ok === false) {
        // Applying failed (or needs a manual step): surface it instead of
        // pretending the restart happened.
        appendLog({ ts: Date.now(), stream: 'stderr', line: `应用更新失败：${result.error}` });
        renderUpdate({ ...(updateState ?? {}), phase: 'manual', error: null, plan: result.plan ?? updateState?.plan });
      }
      return result;
    }
    const snapshot = await api.downloadUpdate();
    renderUpdate(snapshot ?? updateState);
  },
  'update-later': () => {
    updateDismissed = updateState?.latestVersion ?? null;
    updateNoticeUntil = 0;
    renderUpdate();
  },
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

el.kernelPreToggle.addEventListener('change', () => {
  loadKernel({ includePre: el.kernelPreToggle.checked });
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
  // below that single row — plus the update bar whenever it is showing (the
  // native view is painted above this renderer, so it must not overlap it).
  const toolbarHeight = Math.round(el.toolbar.getBoundingClientRect().height);
  const updateHeight = el.updateBar.hidden ? 0 : Math.round(el.updateBar.getBoundingClientRect().height);
  const height = toolbarHeight + updateHeight;
  if (height > 0) api.setViewInset({ top: height });
}

// ---------------------------------------------------------------- bootstrap

api.onState(render);
api.onLog(appendLog);
api.onUpdateState((snapshot) => renderUpdate(snapshot));
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

// The updater may already know about an update (its first check can finish
// before the renderer is ready), so pull the current snapshot once.
api
  .updateState()
  .then((snapshot) => renderUpdate(snapshot))
  .catch(() => {});
