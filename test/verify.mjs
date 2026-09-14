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
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

const { resolveShellEnv, runCapture } = require('../src/main/shell-env.js');
const { detectDsh, findExecutable, parseVersion, DSH_PACKAGE } = require('../src/main/dsh-detect.js');
const { createInstallProgress } = require('../src/main/progress.js');
const { installDsh } = require('../src/main/dsh-install.js');
const { DshServer, extractReadyUrl } = require('../src/main/dsh-server.js');
const { ShellController } = require('../src/main/controller.js');

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
