/**
 * Windows-only REAL Edge smoke test. Run explicitly with `pnpm exec tsx scripts/edge-smoke.ts`.
 * It never reads a daily profile, production configuration or existing cookies. All windows,
 * pages, cookies and profiles used here belong to the fresh run directory below.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import type { Logger } from 'cortico/core/types.ts';
import { VideoBrowser, discoverBrowserCandidates, profileProcessIds, type BrowserLaunchOverrides } from '../src/browser.ts';
import { BILIBILI_VIDEO_DEFAULTS } from '../src/config.ts';
import { CookieJar } from '../src/login.ts';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FORK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(FORK, 'scratch', 'edge-smoke.json');
const TOTAL_MS = 180_000;
const started = Date.now();
const token = randomUUID();
const cases: Array<Record<string, unknown>> = [];
const instances: Instance[] = [];
const profiles = new Set<string>();
let root = '';
let closing: Promise<void> | null = null;
let totalExpired = false;
type Event = { atMs: number; level: string; event: string; [key: string]: unknown };
type Instance = { name: string; video: VideoBrowser; events: Event[] };
type Endpoint = { profile: string; port: number; pid: number | null; browser: string; browserVersion: string; protocolVersion: string; file: string };
const report: Record<string, unknown> = {
  schema: 1, startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  executable: EDGE, cases, realWindowsAndEdge: true, mockedBrowserOrCdp: false,
  boundaries: [
    'No production Coo process, configuration, extension installation or user browser profile is accessed.',
    'The baseline is another fresh plugin-owned Edge window; an existing personal Edge window is not inspected.',
    'Only an anonymous Bilibili homepage navigation is attempted; login, account data, playback and paid content are not tested.',
    'Object reconstruction is tested, not a production World reload or a complete Coo process restart.',
    'Coo 0.2.8 marketplace installation and console button integration are not tested by this standalone script.',
  ],
};

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/((?:SESSDATA|bili_jct|token|password|access_token)\s*[=:]\s*)[^\s&;,]+/gi, '$1[redacted]').slice(0, 1500);
}
function samePath(a: string, b: string): boolean { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }
function ownedPath(path: string): boolean {
  if (!root) return false;
  const rel = relative(root, resolve(path));
  return rel !== '' && rel !== '..' && !isAbsolute(rel) && !rel.startsWith('..\\') && !rel.startsWith('../') && !resolve(path).startsWith('\\\\');
}
async function limit<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function timeLeft(max = 35_000): number {
  const left = TOTAL_MS - (Date.now() - started);
  assert(left > 0 && !totalExpired, 'total smoke-test deadline exceeded');
  return Math.min(left, max);
}
async function save(): Promise<void> {
  report.elapsedMs = Date.now() - started;
  report.instances = instances.map(({ name, events }) => ({ name, events }));
  await mkdir(dirname(REPORT), { recursive: true });
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n');
}
async function step<T>(name: string, action: () => Promise<T>, mode = 'real Edge and real CDP'): Promise<T> {
  timeLeft();
  const at = Date.now();
  const item: Record<string, unknown> = { name, mode, real: true };
  cases.push(item);
  try {
    const result = await action();
    Object.assign(item, { status: 'passed', elapsedMs: Date.now() - at, result });
    console.log(`PASS ${name}`);
    return result;
  } catch (error) {
    Object.assign(item, { status: 'failed', elapsedMs: Date.now() - at, error: cleanError(error) });
    console.log(`FAIL ${name}: ${cleanError(error)}`);
    throw error;
  } finally { await save(); }
}
function make(name: string, section: string, browserConfig: Partial<typeof BILIBILI_VIDEO_DEFAULTS.browser> = {}, launch?: BrowserLaunchOverrides): Instance {
  const cfg = structuredClone(BILIBILI_VIDEO_DEFAULTS);
  Object.assign(cfg.browser, browserConfig);
  const events: Event[] = [];
  const append = (level: string) => (event: string, data?: unknown) => {
    const item: Event = { atMs: Date.now() - started, level, event };
    if (data && typeof data === 'object') {
      const source = data as Record<string, unknown>;
      // Deliberately omit args, stderr and arbitrary objects; no raw command line is emitted.
      for (const key of ['file', 'profile', 'pid', 'port', 'browser', 'version', 'uniqueProfile', 'attempt', 'round', 'exitCode', 'aliveMs']) {
        if (typeof source[key] === 'string' || typeof source[key] === 'number' || typeof source[key] === 'boolean' || source[key] === null) item[key] = source[key];
      }
      if (typeof source.profile === 'string') {
        assert(ownedPath(source.profile), 'launcher attempted a profile outside this smoke run');
        profiles.add(resolve(source.profile));
      }
      if (typeof source.file === 'string') {
        const allowedNegative = name.startsWith('negative-') && (samePath(source.file, process.execPath) || samePath(source.file, join(root, 'missing-edge.exe')));
        assert(samePath(source.file, EDGE) || allowedNegative, 'launcher selected an unapproved executable');
      }
    }
    events.push(item);
  };
  const logger = { debug: append('debug'), info: append('info'), warn: append('warn'), error: append('error') } as unknown as Logger;
  const video = new VideoBrowser({
    cfg, dataDir: join(root, section), jar: new CookieJar(join(root, section, 'empty-smoke-cookies.json')),
    log: () => logger, onNavigated: () => {}, onLost: () => {}, onDanmaku: () => {}, onSubtitleTracks: () => {},
    // These overrides adjust only time budgets/candidates. Real spawn, fetch, connect and cleanup are used.
    launch: { timeoutMs: Math.min(20_000, timeLeft()), ...launch },
  });
  const instance = { name, video, events };
  instances.push(instance);
  return instance;
}

/** Decode complete Windows argv fields, including quoted paths and escaped quotes. */
function commandLineArgv(command: string): string[] {
  const argv: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i === command.length) break;
    let value = '', quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === '\\') { slashes++; i++; }
      if (command[i] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else if (quoted && command[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
        i++;
      } else {
        value += '\\'.repeat(slashes);
        if (i < command.length && (quoted || !/\s/.test(command[i]))) value += command[i++];
      }
    }
    assert(!quoted, 'unbalanced quotes in owned browser command line');
    argv.push(value);
  }
  return argv;
}

/**
 * Observe the already-connected browser, rather than enumerating every browser on
 * the machine. CDP identifies the browser PID; CIM independently verifies its
 * executable and one complete --user-data-dir argument. No raw command line is
 * retained in the report. This does not replace the strict empty-PID cleanup check.
 */
async function inspectLivePid(instance: Instance, page: Page, profile: string): Promise<number> {
  assert(ownedPath(profile), 'live PID observation requires this run\'s profile');
  const cdp = await page.browser().target().createCDPSession();
  let pid: number;
  try {
    const info = await limit(cdp.send('SystemInfo.getProcessInfo'), timeLeft(3000), 'browser PID via real CDP');
    const browsers = info.processInfo.filter(process => process.type === 'browser');
    assert.equal(browsers.length, 1, 'CDP did not identify one browser process');
    pid = browsers[0].id;
    assert(Number.isSafeInteger(pid) && pid > 0, 'CDP returned an invalid browser PID');
  } finally { await cdp.detach(); }
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$watch=[Diagnostics.Stopwatch]::StartNew()
$items=@(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}')
if ($items.Count -ne 1) { throw 'Expected one owned browser PID' }
$item=$items[0]
@{pid=[int]$item.ProcessId;name=[string]$item.Name;file=[string]$item.ExecutablePath;command=[string]$item.CommandLine;queryMs=$watch.ElapsedMilliseconds} | ConvertTo-Json -Compress`;
  const began = Date.now();
  const observation: Record<string, unknown> = { pid, method: 'CDP browser PID + exact-PID CIM + complete argv' };
  try {
    const output = await new Promise<string>((resolveOutput, reject) => execFile(ps,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: timeLeft(8000), maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(new Error(`owned PID query failed: code=${String(error.code)} killed=${String(error.killed)} signal=${String(error.signal)}`)) : resolveOutput(stdout)));
    const item = JSON.parse(output.replace(/^\uFEFF/, '')) as { pid: number; name: string; file: string; command: string; queryMs: number };
    assert.equal(item.pid, pid);
    assert.equal(item.name.toLowerCase(), 'msedge.exe');
    assert(samePath(item.file, EDGE), 'owned PID has an unexpected executable');
    assert(typeof item.command === 'string' && item.command.length > 0, 'owned PID command line is unavailable');
    const argv = commandLineArgv(item.command);
    assert(samePath(argv[0], EDGE), 'owned browser argv executable does not match');
    const directories: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--user-data-dir') directories.push(argv[++i] ?? '');
      else if (argv[i].startsWith('--user-data-dir=')) directories.push(argv[i].slice('--user-data-dir='.length));
    }
    assert.equal(directories.length, 1, 'owned PID must have exactly one user-data-dir switch');
    assert(isAbsolute(directories[0]) && samePath(directories[0], profile), 'owned PID has a different complete profile argument');
    assert(page.browser().connected && !page.isClosed(), 'browser disconnected during PID observation');
    Object.assign(observation, { queryMs: item.queryMs, exactProfileConfirmed: true });
    return pid;
  } catch (error) {
    observation.error = cleanError(error);
    throw error;
  } finally {
    instance.events.push({ atMs: Date.now() - started, level: 'info', event: 'smoke exact-profile PID confirmation', elapsedMs: Date.now() - began, ...observation });
  }
}

/** Unknown occupancy is retried within a finite observation budget, never accepted as empty. */
async function inspectExitedPids(profile: string): Promise<number[] | null> {
  assert(ownedPath(profile), 'exit observation requires this run\'s profile');
  const until = Date.now() + 7000;
  const observations: Array<number[] | null> = [];
  let pids: number[] | null;
  do {
    pids = await profileProcessIds(profile);
    observations.push(pids);
    if (pids !== null) break;
    if (Date.now() >= until) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 150));
  } while (Date.now() < until);
  const exitObservations = (report.exitObservations ??= []) as unknown[];
  exitObservations.push({ profile, observations });
  return pids;
}

async function inspect(instance: Instance, page: Page): Promise<Endpoint> {
  const connected = [...instance.events].reverse().find(e => e.event === 'bilibili-video browser CDP connected');
  assert(connected && typeof connected.profile === 'string', 'missing real launch completion diagnostic');
  const profile = connected.profile;
  assert(ownedPath(profile), 'profile does not belong to this run');
  const [line, wsPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  const port = Number(line);
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid actual DAP port');
  assert.equal(port, connected.port, 'diagnostic port differs from DAP');
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  assert(response.ok, 'real DevTools endpoint is not healthy');
  const metadata = await response.json() as { Browser: string; webSocketDebuggerUrl: string };
  const ws = new URL(metadata.webSocketDebuggerUrl);
  assert.equal(ws.pathname, wsPath);
  assert.equal(Number(ws.port), port);
  const cdp = await page.createCDPSession();
  let version: { product: string; protocolVersion: string };
  try { version = await cdp.send('Browser.getVersion'); } finally { await cdp.detach(); }
  const browserVersion = await page.browser().version();
  assert(/Chrome|Edg/i.test(version.product) && browserVersion.length > 0);
  const pid = await inspectLivePid(instance, page, profile);
  return { profile, port, pid, browser: metadata.Browser,
    browserVersion, protocolVersion: version.protocolVersion, file: String(connected.file) };
}
async function stopAndVerify(instance: Instance, endpoint: Endpoint): Promise<Record<string, unknown>> {
  await limit(instance.video.stop(), timeLeft(18_000), `stop ${instance.name}`);
  assert.equal(instance.video.connected, false);
  const remainingPids = await inspectExitedPids(endpoint.profile);
  assert.deepEqual(remainingPids, [], 'owned browser PID exit could not be confirmed');
  return { launcherPid: endpoint.pid, remainingExactProfilePids: remainingPids, exited: true, temporaryProfileRemoved: !existsSync(endpoint.profile) };
}
async function fileVersion(): Promise<string> {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `(Get-Item -LiteralPath '${EDGE}').VersionInfo.FileVersion`;
  return new Promise((resolveVersion, reject) => execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolveVersion(stdout.trim())));
}
async function finish(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const cleanup: Array<Record<string, unknown>> = [];
    report.cleanup = cleanup;
    await Promise.all([...instances].reverse().map(async instance => {
      try { await limit(instance.video.stop(), 18_000, `final stop ${instance.name}`); cleanup.push({ instance: instance.name, stopCompleted: true }); }
      catch (error) { cleanup.push({ instance: instance.name, stopCompleted: false, error: cleanError(error) }); }
    }));
    let safeToRemove = cleanup.every(entry => entry.stopCompleted === true);
    for (const profile of profiles) {
      if (!ownedPath(profile)) { safeToRemove = false; continue; }
      const pids = await inspectExitedPids(profile);
      cleanup.push({ profile, remainingExactProfilePids: pids, exited: Array.isArray(pids) && pids.length === 0 });
      if (pids === null || pids.length) safeToRemove = false;
    }
    if (root && safeToRemove) {
      try {
        const stat = await lstat(root);
        const marker = JSON.parse(await readFile(join(root, '.edge-smoke-owner.json'), 'utf8'));
        assert(stat.isDirectory() && !stat.isSymbolicLink());
        assert.equal(await realpath(root), root);
        assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
        assert(basename(root).startsWith('bili-edge-smoke-') && marker.token === token && marker.pid === process.pid);
        await rm(root, { recursive: true, force: false });
        report.runDirectoryRemoved = true;
      } catch (error) { report.runDirectoryRemoved = false; report.cleanupError = cleanError(error); }
    } else if (root) { report.runDirectoryRemoved = false; report.cleanupNote = 'Ownership or browser exit could not be confirmed; directory retained without broad process termination.'; }
    report.cleanupConfirmed = safeToRemove;
    report.finishedAt = new Date().toISOString();
    report.passed = cases.length > 0 && cases.every(c => c.status === 'passed') && !report.fatalError && !totalExpired && safeToRemove && !report.cleanupError;
    await save();
  })();
  return closing;
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'this smoke test is restricted to Windows');
  assert(existsSync(EDGE), 'the reviewed system Edge executable is missing');
  root = await mkdtemp(join(await realpath(tmpdir()), 'bili-edge-smoke-'));
  await writeFile(join(root, '.edge-smoke-owner.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx' });
  report.runDirectory = root;
  report.executableFileVersion = await fileVersion();
  const detected = await discoverBrowserCandidates('');
  assert(detected.length > 0 && detected.every(file => samePath(file, EDGE)), 'automatic discovery found an unexpected browser; review before real launch');
  report.autoDiscoveredExecutables = detected;
  const baseline = make('baseline-default-discovery', 'baseline');
  const baselinePage = await limit(baseline.video.ensure(), timeLeft(), 'baseline auto-discovery launch');
  await baselinePage.setContent('<title>Plugin-owned Edge isolation baseline</title><p>Fresh test profile, no personal data.</p>');
  const baselineEndpoint = await step('default automatic discovery launches real Edge with DAP and CDP', () => inspect(baseline, baselinePage));

  const pluginSection = '中文目录-空格 测试';
  const plugin = make('second-plugin-window', pluginSection, {}, { candidates: async () => [EDGE] });
  const pluginPage = await limit(plugin.video.ensure(), timeLeft(), 'second independent Edge launch');
  let pluginEndpoint = await step('independent plugin Edge starts while baseline Edge is already open', async () => {
    const endpoint = await inspect(plugin, pluginPage);
    assert.notEqual(endpoint.profile, baselineEndpoint.profile);
    assert.notEqual(endpoint.port, baselineEndpoint.port);
    assert(!baselinePage.isClosed() && baseline.video.connected);
    return endpoint;
  });
  try {
    await step('anonymous Bilibili homepage navigation', async () => {
      await limit(plugin.video.goto('https://www.bilibili.com/'), timeLeft(32_000), 'Bilibili anonymous navigation');
      const url = new URL(plugin.video.url());
      assert(url.protocol === 'https:' && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')));
      return { origin: url.origin, path: url.pathname, title: (await pluginPage.title()).slice(0, 160), authenticated: false };
    });
  } catch { /* A network/Bilibili failure is recorded independently; continue the local lifecycle checks. */ }
  const firstProfile = pluginEndpoint.profile;
  await step('close plugin window and confirm only owned browser exits', () => stopAndVerify(plugin, pluginEndpoint));
  await step('same plugin object reopens using a fresh profile', async () => {
    const page = await limit(plugin.video.ensure(), timeLeft(), 'same-object reopen');
    pluginEndpoint = await inspect(plugin, page);
    assert.notEqual(pluginEndpoint.profile, firstProfile);
    return pluginEndpoint;
  });
  await stopAndVerify(plugin, pluginEndpoint);
  const rebuilt = make('rebuilt-plugin-object', pluginSection, {}, { candidates: async () => [EDGE] });
  await step('new plugin object reopens against the same isolated dataDir', async () => {
    const page = await limit(rebuilt.video.ensure(), timeLeft(), 'rebuilt-object launch');
    const endpoint = await inspect(rebuilt, page);
    assert.notEqual(endpoint.profile, firstProfile);
    await stopAndVerify(rebuilt, endpoint);
    return endpoint;
  });

  for (const kind of ['cdpUrl', 'profileDir'] as const) {
    await step(`real ${kind} attach preserves baseline window and every original tab`, async () => {
      const baselineBrowser = baselinePage.browser();
      const before = await baselineBrowser.pages();
      const attach = make(`attached-${kind}`, `attach-${kind}`, kind === 'cdpUrl'
        ? { cdpUrl: `http://127.0.0.1:${baselineEndpoint.port}` }
        : { profileDir: baselineEndpoint.profile });
      const page = await limit(attach.video.ensure(), timeLeft(), `${kind} attach`);
      assert.notEqual(page, baselinePage);
      assert.equal((await baselineBrowser.pages()).length, before.length + 1);
      assert(!baselinePage.isClosed() && baselineBrowser.connected);
      await limit(attach.video.stop(), timeLeft(15_000), `${kind} detach`);
      assert.equal((await baselineBrowser.pages()).length, before.length);
      assert(!baselinePage.isClosed() && baselineBrowser.connected && baseline.video.connected);
      assert.equal(await baselinePage.title(), 'Plugin-owned Edge isolation baseline');
      const pid = await inspectLivePid(baseline, baselinePage, baselineEndpoint.profile);
      return { originalTabsPreserved: true, pluginTabClosed: true, baselineAlive: true, baselineExactProfilePids: [pid], port: baselineEndpoint.port };
    });
  }
  for (const [name, file] of [['node', process.execPath], ['missing-path', join(root, 'missing-edge.exe')]]) {
    await step(`real OS spawn failure for ${name} is readable and bounded`, async () => {
      const negative = make(`negative-${name}`, `negative-${name}`, { executableFile: file }, { candidates: async () => [file], timeoutMs: 5000, exitGraceMs: 200 });
      const at = Date.now();
      let failure: unknown;
      try { await limit(negative.video.ensure(), timeLeft(9000), `negative ${name}`); } catch (error) { failure = error; }
      assert(failure instanceof Error, 'invalid executable unexpectedly succeeded');
      assert(Date.now() - at < 9000 && /浏览器|启动|程序|端口/.test(failure.message));
      assert.equal(negative.video.connected, false);
      return { elapsedMs: Date.now() - at, message: cleanError(failure), injected: 'candidate-list only; OS spawn, connect, fetch and cleanup remain real' };
    }, 'real OS spawn of controlled invalid executable; no fake browser');
  }
  await step('final baseline close confirms all plugin-owned baseline PIDs exit', () => stopAndVerify(baseline, baselineEndpoint));
}

const watchdog = setTimeout(() => {
  totalExpired = true;
  report.fatalError = 'total smoke-test deadline exceeded';
  // Close only VideoBrowser instances created by this run. If exit cannot be confirmed,
  // finish() retains their profiles and records the PIDs; there is no global taskkill here.
  void limit(finish(), 30_000, 'deadline cleanup').catch(async error => { report.cleanupError = cleanError(error); await save(); })
    .finally(() => process.exit(1));
}, TOTAL_MS);
try { await main(); }
catch (error) { report.fatalError = cleanError(error); process.exitCode = 1; }
finally {
  await finish();
  clearTimeout(watchdog);
  if (report.passed !== true) process.exitCode = 1;
  console.log(JSON.stringify({ report: REPORT, passed: report.passed, cases: cases.length, elapsedMs: report.elapsedMs, runDirectoryRemoved: report.runDirectoryRemoved }));
}
