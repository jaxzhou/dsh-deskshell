#!/usr/bin/env node
/**
 * Verification for the parts of the shell that do not need Electron.
 *
 * Run with `npm test` (plain Node):
 *   - login-shell environment resolution and dsh detection on this machine
 *   - the npm progress model
 *   - the `dsh web: <url>` readiness parser
 *   - a full install run against a fixture `npm`
 *   - a full `dsh web` lifecycle against a fixture `dsh` (start → URL → stop)
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

const shellEnv = require('../src/main/shell-env.js');
const { resolveShellEnv, runCapture } = shellEnv;
const { detectDsh, findExecutable, parseVersion, DSH_PACKAGE } = require('../src/main/dsh-detect.js');
const { createInstallProgress } = require('../src/main/progress.js');
const { installDsh } = require('../src/main/dsh-install.js');
const { DshServer, extractReadyUrl } = require('../src/main/dsh-server.js');
const { ShellController } = require('../src/main/controller.js');
const nodeRuntime = require('../src/main/node-runtime.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** `candidateNames` as seen from a faked win32 platform. */
function candidateNamesForWin(name) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const file = require.resolve('../src/main/dsh-detect.js');
    delete require.cache[file];
    return require('../src/main/dsh-detect.js').candidateNames(name);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
}

/** Load `dsh-detect` under a faked win32 platform and resolve `name` on PATH. */
function findExecutableOnPath(winShellEnv, name, pathValue) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const file = require.resolve('../src/main/dsh-detect.js');
    delete require.cache[file];
    const winDetect = require('../src/main/dsh-detect.js');
    return winDetect.findExecutable(name, { PATH: pathValue });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
}

/** Wait for one emitted event, or fail after `timeoutMs`. */
function waitFor(emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`等待事件 ${event} 超时（${label}）`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    emitter.once(event, onEvent);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a controller until it reaches `phase`. `start()` resolves as soon as the
 * child is spawned; the GUI URL (and the `running` phase) arrive later.
 */
async function waitForPhase(controller, phase, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (controller.getState().phase !== phase && Date.now() < deadline) await sleep(25);
  return controller.getState();
}

// ---------------------------------------------------------------- environment

section('1. 登录 shell 环境解析 (shell-env)');
const resolved = await resolveShellEnv();
check('解析出 PATH', typeof resolved.env.PATH === 'string' && resolved.env.PATH.length > 0);
check('PATH 中包含 node 所在目录', Boolean(findExecutable('node', resolved.env)), resolved.env.PATH);
check('找到 npm 可执行文件', Boolean(findExecutable('npm', resolved.env)));
check('记录了环境来源说明', resolved.notes.length > 0, resolved.notes.join(' | '));

const nodeVersion = await runCapture(findExecutable('node', resolved.env), ['--version'], { env: resolved.env });
check('node --version 可执行', nodeVersion.ok && /^v?\d+\./.test(nodeVersion.stdout.trim()), nodeVersion.stdout.trim());

section('2. dsh 检测 (dsh-detect)');
const detection = await detectDsh(resolved.env);
check('返回完整检测结构', Boolean(detection.node && detection.npm && detection.dsh));
check('npm 可用', detection.npm.available === true, detection.npm.error ?? '');
check('dsh 已安装', detection.dsh.installed === true, detection.dsh.error ?? '');
check('解析出 dsh 版本号', Boolean(parseVersion(detection.dsh.version)), String(detection.dsh.version));
check('解析出 dsh 可执行路径', Boolean(detection.dsh.command), String(detection.dsh.command));
check('检测到全局 node_modules 根目录', Boolean(detection.npm.globalRoot), String(detection.npm.globalRoot));
check('安装目标为 @deepseek-ai/dsh', detection.packageName === DSH_PACKAGE);
check('parseVersion 兼容普通与 rc 版本', parseVersion('v1.2.3') === '1.2.3' && parseVersion('0.1.5-rc.2') === '0.1.5-rc.2');

// ------------------------------------------------------------------- progress

section('3. 安装进度模型 (progress)');
{
  const progress = createInstallProgress();
  const start = progress.snapshot();
  check('初始进度为准备阶段', start.percent === 2 && start.phase === '准备安装');

  let monotonic = true;
  let last = start.percent;
  for (let index = 0; index < 60; index += 1) {
    progress.feed(`npm http fetch GET 200 https://registry.npmjs.org/pkg-${index}/-/${index}.tgz 10ms (cache miss)`);
    const snapshot = progress.snapshot();
    if (snapshot.percent < last) monotonic = false;
    last = snapshot.percent;
  }
  const fetched = progress.snapshot();
  check('进度单调递增', monotonic);
  check('下载阶段不会越过上限', fetched.percent > 10 && fetched.percent <= 78, `percent=${fetched.percent}`);
  check('统计已获取包数量', fetched.fetched === 60, `fetched=${fetched.fetched}`);
  check('下载阶段文案正确', fetched.phase === '下载依赖包', fetched.phase);

  progress.feed('npm http fetch GET 200 https://registry.npmjs.org/x 1ms');
  check('reify 阶段推进到 82% 以上', (() => {
    progress.feed('reify:foo: timing reifyNode');
    return progress.snapshot().percent >= 82;
  })());

  progress.feed('added 284 packages in 11s');
  const linked = progress.snapshot();
  check('解析出安装包数量', linked.packages === 284, `packages=${linked.packages}`);
  check('完成后为 100%', (() => {
    progress.finish(true);
    return progress.snapshot().percent === 100 && progress.snapshot().done === true;
  })());

  const failing = createInstallProgress();
  failing.feed('npm error code EACCES');
  const failedSnapshot = failing.snapshot();
  check('识别失败输出', failedSnapshot.failed === true && failedSnapshot.phase === '安装失败', failedSnapshot.phase);
}

// ---------------------------------------------------------------- url parsing

section('4. dsh 就绪地址解析 (dsh-server)');
{
  const line = 'dsh web: http://127.0.0.1:53211/?token=abc123 (LAN: http://192.168.1.5:53211/?token=abc123)';
  const parsed = extractReadyUrl(line);
  check('解析出带 token 的回环地址', parsed?.url === 'http://127.0.0.1:53211/?token=abc123', String(parsed?.url));
  check('解析出端口', parsed?.port === 53211, String(parsed?.port));
  check('解析出身 host', parsed?.host === '127.0.0.1', String(parsed?.host));
  check('忽略 ANSI 颜色码', extractReadyUrl('\u001b[32mdsh web: http://127.0.0.1:1/?token=t\u001b[0m')?.url === 'http://127.0.0.1:1/?token=t');
  check('普通日志行不误判', extractReadyUrl('dsh: booting profile web') === null);
}

// -------------------------------------------------------------- install flow

section('5. 安装流程 (dsh-install，使用 fixture npm)');
for (const fixture of ['fake-npm.sh', 'fake-npm-fail.sh', 'fake-dsh.sh']) {
  chmodSync(path.join(fixtures, fixture), 0o755);
}
{
  const logs = [];
  const progressSnapshots = [];
  const okRun = installDsh({
    npmCommand: path.join(fixtures, 'fake-npm.sh'),
    env: process.env,
    onLog: (entry) => logs.push(entry),
    onProgress: (snapshot) => progressSnapshots.push(snapshot),
  });
  const result = await okRun.promise;
  check('安装成功退出码为 0', result.ok === true && result.code === 0, `code=${result.code}`);
  check('回传 npm 输出日志', result.output.includes('added 284 packages'), '');
  check('日志中回显执行的命令', logs.some((entry) => entry.line.includes('install -g @deepseek-ai/dsh')));
  check('最终进度为 100%', progressSnapshots.at(-1)?.percent === 100, String(progressSnapshots.at(-1)?.percent));
  check('未产生失败提示', result.hint === null, String(result.hint));

  const failRun = installDsh({
    npmCommand: path.join(fixtures, 'fake-npm-fail.sh'),
    env: process.env,
  });
  const failResult = await failRun.promise;
  check('安装失败被识别', failResult.ok === false && failResult.code !== 0, `code=${failResult.code}`);
  check('给出权限相关的修复提示', typeof failResult.hint === 'string' && failResult.hint.includes('权限'), String(failResult.hint));
}

// --------------------------------------------------------------- dsh server

section('6. dsh 服务生命周期 (dsh-server，使用 fixture dsh)');
{
  const server = new DshServer({
    dshCommand: path.join(fixtures, 'fake-dsh.sh'),
    env: process.env,
    readyTimeoutMs: 15_000,
    stopTimeoutMs: 5_000,
  });
  const logs = [];
  server.on('log', (entry) => logs.push(entry));
  server.start();
  check('进程已启动', server.running === true);
  const ready = await waitFor(server, 'url', 15_000, 'dsh web 就绪行');
  check('捕获就绪 URL', ready.url === 'http://127.0.0.1:45678/?token=fake-launch-token', String(ready.url));
  check('记录端口', server.resolvedPort === 45678, String(server.resolvedPort));
  check('日志包含 dsh 输出', logs.some((entry) => entry.line.includes('booting profile web')));

  const exitPromise = waitFor(server, 'exit', 15_000, 'dsh 退出');
  await server.stop();
  const exit = await exitPromise;
  check('停止后进程退出', server.running === false, '');
  check('退出被标记为预期', exit.expected === true, JSON.stringify(exit));
}

section('7. 控制器状态机 (controller)');
{
  const controller = new ShellController({ cwd: here });
  const phases = [];
  controller.on('state', (state) => phases.push(state.phase));
  const detected = await controller.check({ autostart: false });
  const state = controller.getState();
  check('检测到 dsh 后进入 ready-to-start', state.phase === 'ready-to-start', state.phase);
  check('状态中包含检测结果', state.detection?.dsh?.installed === true);
  check('状态中包含日志回放', Array.isArray(state.logs) && state.logs.length > 0, `logs=${state.logs.length}`);
  check('状态中包含机器名', typeof state.hostname === 'string' && state.hostname.length > 0, String(state.hostname));
  check('状态可 JSON 序列化', (() => {
    try {
      JSON.stringify(state);
      return true;
    } catch {
      return false;
    }
  })());
  await controller.dispose();
  check('dispose 后不再广播', controller.listenerCount('state') === 0);
}

section('8. 端到端流程：未安装 → 安装 → 启动 → 运行 (fixtures 注入)');
{
  const fakeDsh = path.join(fixtures, 'fake-dsh.sh');
  let detectCalls = 0;
  /** First detection reports "not installed"; every later one reports the fixture. */
  const fakeDetect = async () => {
    detectCalls += 1;
    const installed = detectCalls > 1;
    return {
      checkedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      packageName: DSH_PACKAGE,
      installArgs: ['install', '-g', DSH_PACKAGE],
      node: { available: true, version: 'v24.18.0', command: '/usr/bin/node', error: null },
      npm: {
        available: true,
        version: '11.16.0',
        command: path.join(fixtures, 'fake-npm.sh'),
        error: null,
        globalRoot: '/tmp/fake/lib/node_modules',
        globalBin: '/tmp/fake/bin',
      },
      dsh: installed
        ? { installed: true, version: '0.1.5-rc.2', command: fakeDsh, error: null, packageManifest: null, viaPath: true }
        : { installed: false, version: null, command: null, error: 'PATH 中未找到 dsh 命令', packageManifest: null, viaPath: false },
    };
  };

  const installCalls = [];
  const fakeInstall = (options) => {
    installCalls.push(options);
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    // Report progress the way the real installer does, then succeed.
    setTimeout(() => options.onProgress({ percent: 46, phase: '下载依赖包', detail: '已获取 12 个包', fetched: 12, packages: 0 }), 5);
    setTimeout(() => {
      options.onLog({ stream: 'stdout', line: 'added 284 packages in 11s' });
      options.onProgress({ percent: 100, phase: '安装完成', detail: '共安装 284 个包', fetched: 284, packages: 284 });
      resolvePromise({ ok: true, code: 0, cancelled: false, hint: null, command: 'npm install -g @deepseek-ai/dsh', output: 'added 284 packages in 11s' });
    }, 20);
    return { promise, cancel: () => {} };
  };

  const flow = new ShellController({ cwd: here, detect: fakeDetect, install: fakeInstall, startDelayMs: 10 });
  const seen = [];
  let lastInstall = null;
  flow.on('state', (snapshot) => {
    if (seen.at(-1) !== snapshot.phase) seen.push(snapshot.phase);
    if (snapshot.install) lastInstall = snapshot.install;
  });

  await flow.check({ autostart: false });
  check('首次检测判定为未安装', flow.getState().phase === 'missing-dsh', flow.getState().phase);
  check('未安装时仍报告 node/npm 可用', flow.getState().detection.npm.available === true);

  // `retry()` must route to the installer while dsh is still missing.
  const installDone = flow.retry();
  await sleep(60);
  check('安装中暴露进度给界面', lastInstall?.percent === 100 && lastInstall?.phase === '安装完成', JSON.stringify(lastInstall));
  await installDone;

  check('安装调用收到 npm 命令', installCalls[0]?.npmCommand.endsWith('fake-npm.sh'), String(installCalls[0]?.npmCommand));
  check('安装后重新检测', detectCalls >= 2, `detectCalls=${detectCalls}`);

  const finalState = await waitForPhase(flow, 'running');
  check('最终进入 running', finalState.phase === 'running', finalState.phase);
  check('拿到带 token 的 GUI 地址', finalState.server.url === 'http://127.0.0.1:45678/?token=fake-launch-token', String(finalState.server.url));
  check('记录 GUI 端口', finalState.server.port === 45678, String(finalState.server.port));
  check('阶段顺序完整', seen.join(' → ').includes('missing-dsh') && seen.join(' → ').includes('installing') && seen.join(' → ').includes('starting'), seen.join(' → '));

  await flow.restart();
  const restarted = await waitForPhase(flow, 'running');
  check('重启后重新运行', restarted.phase === 'running' && restarted.server.url?.includes('token=fake-launch-token'), restarted.phase);

  await flow.stopServer();
  check('停止后回到待启动', flow.getState().phase === 'ready-to-start', flow.getState().phase);

  // With dsh now installed, `retry()` must restart the server instead.
  const installsBefore = installCalls.length;
  await flow.retry();
  const afterRetry = await waitForPhase(flow, 'running');
  check('retry 在已安装时重新启动 dsh', afterRetry.phase === 'running' && installCalls.length === installsBefore, afterRetry.phase);

  await flow.dispose();
}

section('9. Windows 代码路径（模拟 process.platform = win32）');
{
  // The Windows branches cannot be executed here, but the pure decisions can:
  // re-require the module with a faked platform to get its win32 view.
  const originalPlatform = process.platform;
  const reload = () => {
    const file = require.resolve('../src/main/shell-env.js');
    delete require.cache[file];
    return require('../src/main/shell-env.js');
  };

  const posixEnv = reload();
  check('posix 下 .cmd 不需要 shell', posixEnv.needsShell('/usr/local/bin/npm') === false);
  check('posix 下不改写命令', posixEnv.shellCommandFor('/usr/local/bin/npm') === '/usr/local/bin/npm');

  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  let winEnv;
  try {
    winEnv = reload();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }

  check('Windows 下识别 .cmd 需要 shell', winEnv.needsShell('C:\\nodejs\\npm.cmd') === true);
  check('Windows 下识别 .bat 需要 shell', winEnv.needsShell('C:\\tools\\dsh.bat') === true);
  check('Windows 下 .exe 不需要 shell', winEnv.needsShell('C:\\nodejs\\node.exe') === false);
  check(
    'Windows 下带空格的路径会加引号',
    winEnv.shellCommandFor('C:\\Program Files\\nodejs\\npm.cmd') === '"C:\\Program Files\\nodejs\\npm.cmd"',
    winEnv.shellCommandFor('C:\\Program Files\\nodejs\\npm.cmd'),
  );
  check(
    'Windows 下无空格路径保持原样',
    winEnv.shellCommandFor('C:\\nodejs\\npm.cmd') === 'C:\\nodejs\\npm.cmd',
  );
  check('Windows 下 PATH 分隔符为分号', winEnv.PATH_SEPARATOR === ';');
  check(
    'Windows 下会搜索 npm 全局目录与 nodejs 安装目录',
    winEnv.guessDirs('C:\\Users\\me').some((dir) => dir.includes('Roaming') && dir.endsWith('npm')),
    winEnv.guessDirs('C:\\Users\\me').join(' | '),
  );

  // The Windows archive ships BOTH `npm` (a POSIX shell wrapper) and
  // `npm.cmd`; a global npm install likewise writes `dsh`, `dsh.cmd`, `dsh.ps1`.
  // cmd.exe resolves through PATHEXT only, so the wrapper must never win —
  // otherwise a perfectly good npm/dsh looks broken and the flow loops.
  const dualDir = path.join(here, '.tmp-win-dual');
  mkdirSync(dualDir, { recursive: true });
  writeFileSync(path.join(dualDir, 'npm'), '#!/bin/sh\n');
  writeFileSync(path.join(dualDir, 'npm.cmd'), '@echo off\r\n');
  writeFileSync(path.join(dualDir, 'dsh'), '#!/bin/sh\n');
  writeFileSync(path.join(dualDir, 'dsh.cmd'), '@echo off\r\n');
  writeFileSync(path.join(dualDir, 'dsh.ps1'), '# powershell\n');
  const previousPathext2 = process.env.PATHEXT;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const npmResolved = findExecutableOnPath(null, 'npm', dualDir);
    check(
      'Windows 下 npm 解析到 npm.cmd 而不是无扩展名的 shell 包装',
      String(npmResolved).toLowerCase() === path.join(dualDir, 'npm.cmd').toLowerCase(),
      String(npmResolved),
    );
    const dshResolved = findExecutableOnPath(null, 'dsh', dualDir);
    check(
      'Windows 下 dsh 解析到 dsh.cmd 而不是无扩展名的包装',
      String(dshResolved).toLowerCase() === path.join(dualDir, 'dsh.cmd').toLowerCase(),
      String(dshResolved),
    );
    check(
      'Windows 候选名遵循 PATHEXT 顺序（.CMD 在最后但不缺）',
      candidateNamesForWin('npm').join(',') === 'npm.COM,npm.com,npm.EXE,npm.exe,npm.BAT,npm.bat,npm.CMD,npm.cmd',
      candidateNamesForWin('npm').join(','),
    );
  } finally {
    if (previousPathext2 === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathext2;
    rmSync(dualDir, { recursive: true, force: true });
  }

  // PATH scanning with the win32 separator and PATHEXT resolution.
  const binDir = path.join(here, '.tmp-win-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\r\n');
  const previousPathext = process.env.PATHEXT;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const found = winEnv === undefined ? null : require('../src/main/dsh-detect.js');
    const fromWinPath = findExecutableOnPath(found, 'dsh', `${binDir};/usr/bin`);
    // PATHEXT is tried in cmd.exe order (.COM;.EXE;.BAT;.CMD) and Windows paths
    // are case-insensitive, so compare case-insensitively.
    check(
      'Windows 下能按 PATHEXT 解析 dsh.cmd',
      String(fromWinPath).toLowerCase() === path.join(binDir, 'dsh.cmd').toLowerCase(),
      String(fromWinPath),
    );
  } finally {
    if (previousPathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathext;
    rmSync(binDir, { recursive: true, force: true });
  }
}

section('10. Node.js 运行时自动配置 (node-runtime)');
{
  // --- dist resolution ----------------------------------------------------
  const darwin = nodeRuntime.describeDist('v24.21.0', { platform: 'darwin', arch: 'arm64' });
  check(
    'macOS 发行版文件名与地址正确',
    darwin.fileName === 'node-v24.21.0-darwin-arm64.tar.gz' &&
      darwin.url === 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz' &&
      darwin.kind === 'tar.gz',
    darwin.url,
  );
  const win = nodeRuntime.describeDist('v24.21.0', { platform: 'win32', arch: 'x64' });
  check(
    'Windows 发行版为 zip 且地址正确',
    win.fileName === 'node-v24.21.0-win-x64.zip' && win.kind === 'zip' && win.url.endsWith('/v24.21.0/node-v24.21.0-win-x64.zip'),
    win.url,
  );
  const mirrored = nodeRuntime.describeDist('v24.21.0', {
    platform: 'linux',
    arch: 'x64',
    base: 'https://registry.npmmirror.com/-/binary/node/',
  });
  check(
    '镜像地址可用于同一版本',
    mirrored.url === 'https://registry.npmmirror.com/-/binary/node/v24.21.0/node-v24.21.0-linux-x64.tar.gz',
    mirrored.url,
  );
  check(
    'DSH_D_NODE_MIRROR 会优先作为下载源',
    nodeRuntime.nodeDistSources({ DSH_D_NODE_MIRROR: 'https://mirror.example.com/node/' })[0].base === 'https://mirror.example.com/node',
    JSON.stringify(nodeRuntime.nodeDistSources({ DSH_D_NODE_MIRROR: 'https://mirror.example.com/node/' })[0]),
  );
  check(
    '未设置镜像时使用默认源列表',
    nodeRuntime.nodeDistSources({})[0].name === 'nodejs.org' && nodeRuntime.nodeDistSources({}).length >= 2,
  );
  check('版本号可归一化', nodeRuntime.normalizeVersion('24.21.0') === 'v24.21.0' && nodeRuntime.normalizeVersion('v24.21.0/') === 'v24.21.0');
  check('可解析主版本号', nodeRuntime.nodeMajor('v24.21.0') === 24 && nodeRuntime.nodeMajor('garbage') === null);

  // --- version index ------------------------------------------------------
  const indexPayload = JSON.stringify([
    { version: 'v26.8.2', lts: false },
    { version: 'v25.1.0', lts: false },
    { version: 'v24.21.0', lts: 'Krypton' },
    { version: 'v22.20.0', lts: 'Jod' },
  ]);
  check('从索引中选出最新 LTS', nodeRuntime.parseLatestLts(indexPayload) === 'v24.21.0', nodeRuntime.parseLatestLts(indexPayload));
  check(
    '索引无 LTS 时回退到最新版',
    nodeRuntime.parseLatestLts(JSON.stringify([{ version: 'v26.8.2', lts: false }])) === 'v26.8.2',
  );

  // --- sdk requirements ---------------------------------------------------
  check('dsh 要求 Node 22+', nodeRuntime.MIN_NODE_MAJOR === 22, String(nodeRuntime.MIN_NODE_MAJOR));
  const gapCases = [
    ['缺少 node 视为缺口', { node: { available: false, version: null }, npm: { available: true } }, true],
    ['缺少 npm 视为缺口', { node: { available: true, version: 'v24.0.0' }, npm: { available: false } }, true],
    ['Node 20 视为缺口', { node: { available: true, version: 'v20.11.0' }, npm: { available: true } }, true],
    ['Node 22 满足要求', { node: { available: true, version: 'v22.20.0' }, npm: { available: true } }, false],
    ['Node 24 满足要求', { node: { available: true, version: 'v24.21.0' }, npm: { available: true } }, false],
  ];
  for (const [name, detection, expected] of gapCases) {
    check(name, ShellController.runtimeGap(detection) === expected);
  }

  // --- download + extract + verify, fully offline -------------------------
  const workDir = path.join(here, '.tmp-runtime');
  const serveDir = path.join(workDir, 'serve');
  const runtimeRoot = path.join(workDir, 'runtime');
  rmSync(workDir, { recursive: true, force: true });

  // Build a stand-in Node archive with the *real* layout, including the detail
  // that matters most: posix npm is a symlink to a `#!/usr/bin/env node`
  // script, so running it resolves node through PATH.
  const archiveRoot = path.join(workDir, 'node-v9.9.9-darwin-x64');
  const archiveBin = path.join(archiveRoot, 'bin');
  const archiveNpmCli = path.join(archiveRoot, 'lib', 'node_modules', 'npm', 'bin');
  mkdirSync(archiveBin, { recursive: true });
  mkdirSync(archiveNpmCli, { recursive: true });
  writeFileSync(
    path.join(archiveBin, 'node'),
    // Stand-in for node: `--version` reports its own version; anything else
    // "runs" the given script — the only one used here is npm's CLI.
    '#!/bin/sh\ncase "$1" in\n  --version) echo v9.9.9 ;;\n  "") exit 0 ;;\n  *) echo 11.9.9 ;;\nesac\n',
  );
  chmodSync(path.join(archiveBin, 'node'), 0o755);
  writeFileSync(path.join(archiveNpmCli, 'npm-cli.js'), '#!/usr/bin/env node\nconsole.log("11.9.9");\n');
  chmodSync(path.join(archiveNpmCli, 'npm-cli.js'), 0o755);
  symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(archiveBin, 'npm'));
  mkdirSync(path.join(serveDir, 'v9.9.9'), { recursive: true });
  execFileSync('tar', [
    '-czf',
    path.join(serveDir, 'v9.9.9', 'node-v9.9.9-darwin-x64.tar.gz'),
    '-C',
    path.join(workDir),
    'node-v9.9.9-darwin-x64',
  ]);

  // A tiny HTTP server plays the role of the dist mirror.
  const served = [];
  const server = createServer((request, response) => {
    const file = path.join(serveDir, request.url.replace(/^\//, ''));
    try {
      const body = readFileSync(file);
      served.push(request.url);
      response.writeHead(200, { 'content-length': String(body.length) });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Direct download with progress.
    const target = path.join(workDir, 'direct.tar.gz');
    const updates = [];
    await nodeRuntime.downloadFile(`${base}/v9.9.9/node-v9.9.9-darwin-x64.tar.gz`, target, {
      onProgress: (snapshot) => updates.push(snapshot),
    });
    check('可下载文件并写入磁盘', statSync(target).size > 0, `${statSync(target).size} bytes`);
    check('下载过程回报进度', updates.length > 0 && updates.at(-1).percent === 100, JSON.stringify(updates.at(-1)));

    // Full bootstrap: download → extract → verify.
    const logs = [];
    const progressSnapshots = [];
    const first = await nodeRuntime.installNodeRuntime({
      root: runtimeRoot,
      version: 'v9.9.9',
      platform: 'darwin',
      arch: 'x64',
      sources: [{ name: 'test-mirror', base }],
      onLog: (entry) => logs.push(entry.line),
      onProgress: (snapshot) => progressSnapshots.push(snapshot),
    });
    check('运行时自动配置成功', first.ok === true, first.ok ? '' : first.error);
    check('解压后 node 就位', first.ok && statSync(first.nodePath).isFile(), String(first.nodePath));
    check('解压后 npm 就位', first.ok && statSync(first.npmPath).isFile(), String(first.npmPath));
    check('校验会执行 node --version', logs.some((line) => line.includes('v9.9.9')), '');
    check('进度走到 100%', progressSnapshots.at(-1)?.percent === 100, JSON.stringify(progressSnapshots.at(-1)));
    check('首次安装标记为未复用', first.ok && first.reused === false);

    // Second run must reuse the unpacked runtime instead of downloading again.
    const downloadsBefore = served.length;
    const second = await nodeRuntime.installNodeRuntime({
      root: runtimeRoot,
      version: 'v9.9.9',
      platform: 'darwin',
      arch: 'x64',
      sources: [{ name: 'test-mirror', base }],
    });
    check('重复调用复用已装运行时', second.ok === true && second.reused === true);
    check('复用时不再重复下载', served.length === downloadsBefore, `served=${served.length}`);

    // Discovery + PATH injection.
    const found = nodeRuntime.findManagedRuntime(runtimeRoot);
    check('可发现已配置的运行时', found?.version === 'v9.9.9' && found.binDir.endsWith(path.join('node-v9.9.9-darwin-x64', 'bin')), String(found?.binDir));
    const injected = nodeRuntime.withManagedRuntime({ PATH: '/usr/bin:/bin' }, found.binDir);
    check('托管运行时置于 PATH 最前', injected.PATH.startsWith(found.binDir), injected.PATH);
    check('PATH 不重复注入同一目录', nodeRuntime.withManagedRuntime(injected, found.binDir).PATH.split(':').filter((p) => p === found.binDir).length === 1);

    // --- the root cause of the "node ok, npm broken" loop ----------------
    // Running the managed npm with a PATH that has no node must be handled by
    // verifyManagedRuntime itself: it prepends the runtime's own bin directory.
    const emptyPathDir = path.join(workDir, 'empty-path');
    mkdirSync(emptyPathDir, { recursive: true });
    const bareEnv = { PATH: emptyPathDir };
    const npmShim = path.join(first.dir, 'bin', 'npm');
    const bareRun = await runCapture(npmShim, ['--version'], { env: bareEnv });
    check(
      '（根因）posix 下托管 npm 依赖 PATH 找到 node',
      process.platform === 'win32' ? true : bareRun.ok === false,
      `ok=${bareRun.ok} err=${bareRun.error ?? bareRun.stderr.trim()}`,
    );
    const selfHealing = await nodeRuntime.verifyManagedRuntime(first.dir, { env: bareEnv });
    check(
      '校验函数自行补齐 PATH，无 node 的机器上也能用 npm',
      selfHealing.ok === true && selfHealing.npmVersion === '11.9.9',
      selfHealing.ok ? selfHealing.npmVersion : selfHealing.reason,
    );

    // --- npm shim repair -------------------------------------------------
    const npmPath = path.join(first.dir, 'bin', 'npm');
    rmSync(npmPath, { force: true });
    check('缺少 npm 时会被重新建立', nodeRuntime.ensureNpmCommand(first.dir) === true && statSync(npmPath).isFile());
    const repairedRun = await nodeRuntime.verifyManagedRuntime(first.dir, { env: bareEnv });
    check(
      '重建后的 npm 可以运行',
      repairedRun.ok === true,
      repairedRun.ok ? repairedRun.npmVersion : repairedRun.reason,
    );

    // --- a runtime with a broken npm must not be reused blindly ----------
    writeFileSync(npmPath, '#!/bin/sh\nexit 1\n');
    chmodSync(npmPath, 0o755);
    const brokenCheck = await nodeRuntime.verifyManagedRuntime(first.dir, { env: bareEnv });
    check(
      'npm 坏掉时校验会失败并说明原因',
      brokenCheck.ok === false && /npm/.test(brokenCheck.reason),
      brokenCheck.reason,
    );
    const repaired = await nodeRuntime.installNodeRuntime({
      root: runtimeRoot,
      version: 'v9.9.9',
      platform: 'darwin',
      arch: 'x64',
      sources: [{ name: 'test-mirror', base }],
    });
    check('坏运行时不会被误判为可复用', repaired.ok === true && repaired.reused === false, `reused=${repaired.reused}`);
    const afterRepair = repaired.ok
      ? await nodeRuntime.verifyManagedRuntime(repaired.dir, { env: bareEnv })
      : { ok: false, reason: '重装失败' };
    check(
      '重新配置后 npm 恢复可用',
      afterRepair.ok === true,
      afterRepair.ok ? afterRepair.npmVersion : afterRepair.reason,
    );

    // --- environment variable case handling (Windows Path vs PATH) -------
    const collapsed = shellEnv.setEnv({ Path: 'C:\\old', PATH: 'C:\\older', KEEP: '1' }, 'PATH', 'C:\\managed');
    check(
      'PATH 大小写变体会被合并为一个键',
      collapsed.PATH === 'C:\\managed' && collapsed.Path === undefined && collapsed.KEEP === '1',
      JSON.stringify(collapsed),
    );
    const npmKey = shellEnv.setEnv({ NPM_CONFIG_PREFIX: '/system' }, 'npm_config_prefix', '/managed');
    check(
      'npm_config_* 同理避免重复键',
      npmKey.npm_config_prefix === '/managed' && npmKey.NPM_CONFIG_PREFIX === undefined,
      JSON.stringify(npmKey),
    );

    // Managed environment: npm must not inherit a prefix from the launcher.
    const managedEnv = nodeRuntime.managedRuntimeEnv(
      { PATH: '/usr/bin:/bin', npm_config_global_prefix: '/some/system/prefix' },
      found,
      { cacheDir: '/tmp/managed-cache' },
    );
    check(
      '托管环境的 npm 全局 prefix 被锁定到托管目录',
      managedEnv.npm_config_prefix === found.dir && managedEnv.npm_config_global_prefix === found.dir,
      `${managedEnv.npm_config_prefix} / ${managedEnv.npm_config_global_prefix}`,
    );
    check('托管环境显式指定缓存目录', managedEnv.npm_config_cache === '/tmp/managed-cache', String(managedEnv.npm_config_cache));
    check('托管环境仍把运行时放在 PATH 最前', managedEnv.PATH.startsWith(found.binDir), managedEnv.PATH);

    // A cancelled download must fail cleanly, not hang.
    const controllerAbort = new AbortController();
    controllerAbort.abort();
    const aborted = await nodeRuntime.installNodeRuntime({
      root: path.join(workDir, 'runtime-abort'),
      version: 'v9.9.9',
      platform: 'darwin',
      arch: 'x64',
      sources: [{ name: 'test-mirror', base }],
      signal: controllerAbort.signal,
    });
    check('取消后返回失败而非卡住', aborted.ok === false && typeof aborted.error === 'string', String(aborted.error));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  }
}

section('11. 控制器：缺少 Node 时自动配置运行时');
{
  const calls = [];
  const fakeProvision = (options) => {
    calls.push(options);
    // Mimic the real installer's contract.
    options.onLog({ stream: 'system', line: '下载 Node.js 运行时' });
    options.onProgress({ percent: 42, phase: '下载 Node.js 运行时', detail: '12.0 / 30.0 MB' });
    return Promise.resolve({
      ok: true,
      dir: '/tmp/managed/node-v24.21.0-darwin-x64',
      binDir: '/tmp/managed/node-v24.21.0-darwin-x64/bin',
      nodePath: '/tmp/managed/node-v24.21.0-darwin-x64/bin/node',
      npmPath: '/tmp/managed/node-v24.21.0-darwin-x64/bin/npm',
      version: 'v24.21.0',
      reused: false,
    });
  };

  /** Each controller needs its own counter: "before provisioning" is per-run. */
  const makeFakeDetect = () => {
    let calls = 0;
    return async () => {
      calls += 1;
      // Before provisioning: no node at all. After: managed node + npm, no dsh.
      const provisioned = calls > 1;
      return {
      checkedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      packageName: DSH_PACKAGE,
      node: provisioned
        ? { available: true, version: 'v24.21.0', command: '/tmp/managed/bin/node', error: null }
        : { available: false, version: null, command: null, error: 'PATH 中未找到 node' },
      npm: provisioned
        ? { available: true, version: '11.6.0', command: '/tmp/managed/bin/npm', error: null, globalRoot: '/tmp/managed/lib/node_modules', globalBin: '/tmp/managed/bin' }
        : { available: false, version: null, command: null, error: 'PATH 中未找到 npm', globalRoot: null, globalBin: null },
        dsh: { installed: false, version: null, command: null, error: 'PATH 中未找到 dsh 命令' },
      };
    };
  };
  const fakeDetect = makeFakeDetect();

  const controller = new ShellController({
    cwd: here,
    runtimeRoot: path.join(here, '.tmp-managed-runtime'),
    detect: fakeDetect,
    provisionRuntime: fakeProvision,
    startDelayMs: 10,
  });
  const phases = [];
  controller.on('state', (state) => {
    if (phases.at(-1) !== state.phase) phases.push(state.phase);
  });

  await controller.check({ autostart: false });
  check('缺少 Node 时自动进入运行时配置', phases.includes('installing-node'), phases.join(' → '));
  check('自动触发了一次运行时安装', calls.length === 1, `calls=${calls.length}`);
  check('运行时安装收到 root 与取消信号', typeof calls[0].root === 'string' && Boolean(calls[0].signal), String(calls[0].root));
  check('配置完成后进入安装 dsh 提示', controller.getState().phase === 'missing-dsh', controller.getState().phase);
  check('托管运行时的 bin 目录已并入 PATH', String(controller.env.PATH).startsWith('/tmp/managed/node-v24.21.0-darwin-x64/bin'), String(controller.env.PATH).slice(0, 60));
  check('状态里带出运行时信息', controller.getState().runtime?.version === 'v24.21.0', JSON.stringify(controller.getState().runtime));

  // Failure path: provisioning fails → the manual panel with an actionable hint.
  const failing = new ShellController({
    cwd: here,
    runtimeRoot: path.join(here, '.tmp-managed-runtime-fail'),
    detect: makeFakeDetect(),
    provisionRuntime: async () => ({ ok: false, error: 'Node.js 运行时下载失败：HTTP 404', hint: '请检查网络或代理设置' }),
    startDelayMs: 10,
  });
  await failing.check({ autostart: false });
  const failedState = failing.getState();
  check('运行时配置失败时给出提示与建议', failedState.phase === 'no-node' && Boolean(failedState.error?.hint), JSON.stringify(failedState.error));

  await controller.dispose();
  await failing.dispose();
}

// --------------------------------------------------------------------- summary

console.log(`\n${'─'.repeat(58)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
