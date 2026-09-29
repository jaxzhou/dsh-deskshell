'use strict';

/**
 * The dsh core ("内核") version catalog.
 *
 * The desktop shell does not ship the Harness itself: it detects whatever `dsh`
 * it is going to boot and lets the user move that install to another published
 * version. Two official sources feed the catalog —
 *
 *   npm    registry.npmjs.org/@deepseek-ai/dsh  → what can actually be installed
 *                                                 (versions, dist-tags, dates)
 *   git    api.github.com/repos/…/releases      → the same releases with their
 *                                                 Chinese release notes and tags
 *
 * Installs always go through npm (`npm install -g @deepseek-ai/dsh@<version>`),
 * so a version that only exists as a git tag is listed but not installable —
 * and it says so instead of pretending.
 *
 * Everything here is pure: fetching lives in `fetchKernelCatalog`, and the
 * controller owns the run/restart side.
 */

const { compareVersions } = require('./plugin-market');

const DSH_PACKAGE = '@deepseek-ai/dsh';
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${DSH_PACKAGE}`;
const GIT_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness';
const GIT_RELEASES_URL = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100';
const REGISTRY_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 15_000;

/**
 * Which releases the list shows by default.
 *
 * dsh publishes prereleases only (its own `latest` dist-tag currently points at
 * an `-rc`), so the primary track is `release` + `rc`; `alpha` (and any other
 * prerelease flavour) is behind a toggle.
 */
const PRIMARY_TYPES = ['release', 'rc'];

/** `0.1.7-rc.2` → `rc`, `0.2.0` → `release`, `0.1.7-alpha.2` → `alpha`. */
function classifyVersion(version) {
  const text = String(version ?? '').trim();
  if (/^\d+\.\d+\.\d+$/.test(text)) return 'release';
  if (/^\d+\.\d+\.\d+-rc\.\d+$/.test(text)) return 'rc';
  if (/^\d+\.\d+\.\d+-alpha\.\d+$/.test(text)) return 'alpha';
  if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(text)) return 'prerelease';
  return null;
}

/** True for version strings we are willing to pass to npm. */
function isKernelVersion(version) {
  return classifyVersion(version) !== null;
}

/** `dsh-v0.2.0-rc.2` → `0.2.0-rc.2` (and `v0.2.0-rc.2` too). */
function versionFromTag(tag) {
  const text = String(tag ?? '').trim().replace(/^dsh-/, '').replace(/^v/, '');
  return isKernelVersion(text) ? text : null;
}

const TYPE_LABELS = {
  release: '正式版',
  rc: 'RC 候选版',
  alpha: 'Alpha 内测版',
  prerelease: '预发布',
};

function typeLabel(type) {
  return TYPE_LABELS[type] ?? '未知';
}

/**
 * Parse the npm registry document (abbreviated or full metadata).
 *
 * @param {string} text
 * @returns {{name: string, distTags: Record<string,string>, versions: object[], modified: string|null}}
 */
function parseRegistryMeta(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`npm 元数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('npm 元数据结构无效');
  // Abbreviated metadata uses `dist-tags`; some mirrors forward `distTags`.
  const rawTags = payload['dist-tags'] ?? payload.distTags ?? {};
  const distTags = {};
  for (const [name, version] of Object.entries(rawTags)) {
    if (isKernelVersion(version)) distTags[String(name)] = String(version);
  }
  const times = payload.time ?? {};
  const versions = Object.keys(payload.versions ?? {})
    .filter((version) => isKernelVersion(version))
    .map((version) => ({
      version,
      type: classifyVersion(version),
      publishedAt: typeof times[version] === 'string' ? times[version] : null,
      deprecated: Boolean(payload.versions[version]?.deprecated),
      tarball: payload.versions[version]?.dist?.tarball ?? null,
    }));
  if (!versions.length) throw new Error('npm 元数据里没有可用的 dsh 版本');
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return {
    name: String(payload.name ?? DSH_PACKAGE),
    distTags,
    versions,
    modified: typeof times.modified === 'string' ? times.modified : null,
  };
}

const NOTE_LIMIT = 900;

/**
 * Trim a GitHub release body down to something readable in a panel.
 *
 * dsh publishes bilingual notes: the Chinese section runs up to the `en-…`
 * anchor, which is exactly the part a Chinese UI wants.
 */
function summarizeReleaseNotes(body, options = {}) {
  const limit = options.limit ?? NOTE_LIMIT;
  let text = String(body ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  // Covers both `id="en-v0.2.0-rc.2-community"` and a bare `id="en"`.
  const englishAt = text.search(/<h3[^>]*id="en[^"]*"|^\s*#{2,3}\s*(New Features|Bug Fixes|Improvements|Other Changes)\s*$/m);
  if (englishAt > 0) text = text.slice(0, englishAt);
  text = text
    .replace(/\[中文\]\([^)]*\)\s*\|\s*\[English\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit).trimEnd()}…`;
  return text;
}

/** Parse GitHub releases into `{version, tag, notes, publishedAt, …}` rows. */
function parseGitReleases(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`GitHub releases 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(payload)) {
    // Rate limiting and other errors come back as an object.
    const message = payload && typeof payload === 'object' ? payload.message : null;
    throw new Error(message ? `GitHub 拒绝请求：${message}` : 'GitHub releases 结构无效');
  }
  return payload
    .map((entry) => {
      const version = versionFromTag(entry?.tag_name);
      if (!version) return null;
      return {
        version,
        tag: String(entry.tag_name ?? ''),
        title: String(entry.name ?? '').slice(0, 120),
        prerelease: Boolean(entry.prerelease),
        publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
        url: typeof entry.html_url === 'string' ? entry.html_url : `${GIT_REPO_URL}/releases`,
        notes: summarizeReleaseNotes(entry.body),
      };
    })
    .filter(Boolean);
}

/**
 * Merge both sources into one catalog, newest first.
 *
 * @param {{npm?: object|null, git?: object[]|null}} sources
 */
function mergeCatalog(sources = {}) {
  const byVersion = new Map();
  for (const entry of sources.npm?.versions ?? []) {
    byVersion.set(entry.version, {
      version: entry.version,
      type: entry.type ?? classifyVersion(entry.version),
      sources: ['npm'],
      publishedAt: entry.publishedAt ?? null,
      deprecated: Boolean(entry.deprecated),
      tarball: entry.tarball ?? null,
      tags: [],
      gitTag: null,
      releaseUrl: null,
      notes: '',
      installable: true,
    });
  }
  for (const entry of sources.git ?? []) {
    const existing = byVersion.get(entry.version);
    if (existing) {
      existing.sources.push('git');
      existing.gitTag = entry.tag;
      existing.releaseUrl = entry.url;
      existing.notes = entry.notes || existing.notes;
      if (!existing.publishedAt) existing.publishedAt = entry.publishedAt;
      continue;
    }
    byVersion.set(entry.version, {
      version: entry.version,
      type: classifyVersion(entry.version),
      sources: ['git'],
      publishedAt: entry.publishedAt ?? null,
      deprecated: false,
      tarball: null,
      tags: [],
      gitTag: entry.tag,
      releaseUrl: entry.url,
      notes: entry.notes,
      // Tagged but not published on npm: visible, not installable.
      installable: false,
    });
  }
  const distTags = sources.npm?.distTags ?? {};
  const rows = [...byVersion.values()];
  for (const row of rows) {
    row.tags = Object.entries(distTags)
      .filter(([, version]) => version === row.version)
      .map(([name]) => name)
      .sort();
  }
  rows.sort((a, b) => compareVersions(b.version, a.version));
  return { versions: rows, distTags, npm: sources.npm ?? null, gitCount: (sources.git ?? []).length };
}

/** Versions shown by default: release + rc, optionally alpha and friends. */
function filterCatalog(catalog, options = {}) {
  const includePre = options.includePre === true;
  const rows = (catalog?.versions ?? []).filter((row) => includePre || PRIMARY_TYPES.includes(row.type));
  return { ...catalog, versions: rows, includePre, hidden: (catalog?.versions?.length ?? 0) - rows.length };
}

/** The two headline versions: the `latest` and `next` dist-tags. */
function kernelHighlights(catalog) {
  const tags = catalog?.distTags ?? {};
  const find = (version) => (catalog?.versions ?? []).find((row) => row.version === version) ?? null;
  return {
    latest: tags.latest ?? null,
    next: tags.next ?? null,
    alpha: tags.alpha ?? null,
    latestRow: find(tags.latest),
    nextRow: find(tags.next),
    alphaRow: find(tags.alpha),
  };
}

/**
 * What to offer the user, given what is installed.
 *
 * @returns {{status: string, target: string|null, reason: string}}
 *   status: current | update | preview | unknown
 */
function recommendUpdate(options = {}) {
  const { installed = null } = options;
  const tags = options.distTags ?? options.catalog?.distTags ?? {};
  const latest = tags.latest ?? null;
  const next = tags.next ?? null;
  if (!isKernelVersion(installed)) {
    return { status: 'unknown', target: latest ?? next, reason: '尚未检测到已安装的 dsh 版本' };
  }
  if (latest && compareVersions(installed, latest) < 0) {
    return { status: 'update', target: latest, reason: `有新的发布版本 ${latest}（当前 ${installed}）` };
  }
  if (next && compareVersions(installed, next) < 0) {
    return { status: 'preview', target: next, reason: `已跟上发布线，可试用下一版本 ${next}` };
  }
  if (latest && compareVersions(installed, latest) > 0) {
    return {
      status: 'current',
      target: latest,
      reason: next && compareVersions(installed, next) >= 0
        ? `已是最新的预览版本 ${installed}（发布线 ${latest}）`
        : `当前 ${installed} 比发布线（${latest}）更新`,
    };
  }
  return { status: 'current', target: latest ?? next, reason: `已是最新发布版本 ${installed}` };
}

/** Rows annotated with what they mean for *this* machine. */
function kernelRows(options = {}) {
  const { installed = null } = options;
  const catalog = filterCatalog(options.catalog ?? { versions: [], distTags: {} }, { includePre: options.includePre });
  const recommendation = recommendUpdate({ installed, catalog });
  const rows = catalog.versions.map((row) => ({
    ...row,
    relation: !isKernelVersion(installed)
      ? 'unknown'
      : row.version === installed
        ? 'same'
        : compareVersions(row.version, installed) > 0
          ? 'newer'
          : 'older',
    recommended: row.version === recommendation.target && recommendation.status === 'update',
  }));
  const typeCounts = rows.reduce((acc, row) => ({ ...acc, [row.type]: (acc[row.type] ?? 0) + 1 }), {});
  return {
    rows,
    installed,
    recommendation,
    includePre: catalog.includePre,
    hidden: catalog.hidden,
    typeCounts,
    distTags: catalog.distTags,
    highlights: kernelHighlights(catalog),
    source: {
      npm: Boolean(catalog.npm),
      git: catalog.gitCount > 0,
      distTags: catalog.distTags,
    },
  };
}

/** `npm install -g @deepseek-ai/dsh@<version>` — args only. */
function buildKernelInstallArgs(options = {}) {
  const version = String(options.version ?? '').trim();
  if (!isKernelVersion(version)) {
    throw new Error(`非法或不支持的 dsh 版本：${version || '(空)'}`);
  }
  return ['install', '-g', `${DSH_PACKAGE}@${version}`];
}

/**
 * Fetch both sources and merge them.
 *
 * npm is required — without it there is nothing to install. GitHub only adds
 * release notes and tags, so its failure is recorded and the npm catalog is
 * still returned (a firewall blocking api.github.com must not break updates).
 *
 * @param {{
 *   npmUrl?: string, gitUrl?: string, fetchText?: Function,
 *   timeoutMs?: number, gitTimeoutMs?: number, includeGit?: boolean, signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ok: boolean, catalog?: object, errors: string[], fetchedAt: number, error?: string}>}
 */
async function fetchKernelCatalog(options = {}) {
  const fetchText = options.fetchText ?? require('./node-runtime').fetchText;
  const npmUrl = options.npmUrl ?? NPM_REGISTRY_URL;
  const gitUrl = options.gitUrl ?? GIT_RELEASES_URL;
  const errors = [];
  const describe = (error) => (error instanceof Error ? error.message : String(error));

  let npm = null;
  try {
    const text = await fetchText(npmUrl, {
      timeoutMs: options.timeoutMs ?? REGISTRY_TIMEOUT_MS,
      signal: options.signal,
    });
    npm = parseRegistryMeta(text);
  } catch (error) {
    errors.push(`npm：${describe(error)}`);
  }

  let git = [];
  if (options.includeGit !== false) {
    try {
      const text = await fetchText(gitUrl, {
        timeoutMs: options.gitTimeoutMs ?? GIT_TIMEOUT_MS,
        signal: options.signal,
      });
      git = parseGitReleases(text);
    } catch (error) {
      errors.push(`git：${describe(error)}`);
    }
  }

  const fetchedAt = Date.now();
  if (!npm) {
    return {
      ok: false,
      error: errors.join('；') || '无法获取 dsh 版本目录',
      errors,
      fetchedAt,
    };
  }
  return {
    ok: true,
    catalog: mergeCatalog({ npm, git }),
    errors,
    fetchedAt,
    sources: { npm: true, git: git.length > 0 },
  };
}

module.exports = {
  DSH_PACKAGE,
  GIT_RELEASES_URL,
  GIT_REPO_URL,
  NPM_REGISTRY_URL,
  NOTE_LIMIT,
  PRIMARY_TYPES,
  REGISTRY_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  TYPE_LABELS,
  buildKernelInstallArgs,
  classifyVersion,
  fetchKernelCatalog,
  filterCatalog,
  isKernelVersion,
  kernelHighlights,
  kernelRows,
  mergeCatalog,
  parseGitReleases,
  parseRegistryMeta,
  recommendUpdate,
  summarizeReleaseNotes,
  typeLabel,
  versionFromTag,
};
