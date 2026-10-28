/** Offline API 6 package check; never starts the World, a browser, a server or a network request. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = await realpath(resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..')));
const attempts = { network: 0, process: 0 };
const undo: Array<() => void> = [];
const originalFetch = globalThis.fetch;
let dataRoot = '';
let world: ReturnType<typeof import('../src/index.ts').default.create> | undefined;
const result: Record<string, unknown> = { check: 'offline-api6-package', packageRoot, worldStarted: false, browserStarted: false };
const markerToken = randomUUID();

// Fail closed if an import/constructor/state receipt starts doing I/O in a future revision.
function block(object: object, key: string, category: keyof typeof attempts): void {
  const target = object as Record<string, unknown>;
  const original = target[key];
  assert.equal(typeof original, 'function', `missing guard target ${key}`);
  target[key] = () => { attempts[category]++; throw new Error(`offline package smoke forbids ${category} I/O (${key})`); };
  undo.push(() => { target[key] = original; });
}
for (const object of [http, https]) for (const key of ['request', 'get']) block(object, key, 'network');
for (const key of ['connect', 'createConnection']) block(net, key, 'network');
block(net.Socket.prototype, 'connect', 'network');
block(tls, 'connect', 'network');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(childProcess, key, 'process');
globalThis.fetch = async () => { attempts.network++; throw new Error('offline package smoke forbids network I/O (fetch)'); };
syncBuiltinESMExports();

const LEGACY_DEFAULTS = {
  enabled: false,
  browser: { executableFile: '', profileDir: '', cdpUrl: '', windowWidth: 1280, windowHeight: 720, windowLeft: 0, windowTop: 0, uposHost: '' },
  playback: { stallSec: 6 },
  observe: { minIntervalSec: 5, frameDensity: 0.8, maxFrames: 9, cellWidth: 640, cellHeight: 360, captureFps: 2, ratio: 0.618, dedupeHamming: 6, cutThreshold: 40, blackLuma: 16, jpegQuality: 0.8 },
  danmaku: { enabled: true, maxPerScene: 12 }, subtitle: { enabled: true },
};
function inside(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel !== '..' && !isAbsolute(rel) && !rel.startsWith('..\\') && !rel.startsWith('../');
}
function atPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object'
    ? (current as Record<string, unknown>)[key] : undefined, value);
}
async function limit<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

try {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, any>;
  assert.equal(manifest.cortico?.kind, 'world');
  assert.equal(manifest.cortico.api, 6);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './src/index.ts');
  assert.equal(manifest.cortico.webUiClient, 'dist/webui.js');
  const entry = await limit(import(pathToFileURL(join(packageRoot, 'src', 'index.ts')).href), 12_000, 'package import') as typeof import('../src/index.ts');
  const definition = entry.default;
  assert.equal(definition.id, 'bilibili-video');
  assert.equal(entry.BILIBILI_VIDEO_ID, definition.id);
  assert.equal(entry.BILIBILI_VIDEO, definition);
  const cfg = definition.defaults();
  assert.deepEqual(cfg, LEGACY_DEFAULTS, 'configuration defaults drifted from the fixed upstream 0.2.2 baseline');
  const secondDefaults = definition.defaults();
  secondDefaults.browser.profileDir = 'synthetic-mutation-only';
  secondDefaults.observe.maxFrames = 1;
  assert.deepEqual(definition.defaults(), LEGACY_DEFAULTS, 'defaults() shares mutable state');
  assert.deepEqual(entry.BILIBILI_VIDEO_DEFAULTS, LEGACY_DEFAULTS);

  const tempParent = await realpath(tmpdir());
  dataRoot = await mkdtemp(join(tempParent, 'bili-package-smoke-'));
  await writeFile(join(dataRoot, '.package-smoke-owner.json'), JSON.stringify({ token: markerToken, pid: process.pid }), { flag: 'wx' });
  // Deliberately provide only the three context fields this definition reads. No host/start.
  world = definition.create({ cfg, timezone: 'Asia/Shanghai', dataDir: dataRoot } as Parameters<typeof definition.create>[0]);
  assert.equal(world.id, definition.id);
  const tools = world.tools();
  const names = tools.map(tool => tool.name).sort();
  assert(names.length > 0 && new Set(names).size === names.length);
  assert(tools.every(tool => typeof tool.handler === 'function' && typeof tool.description === 'string'));
  assert.deepEqual(names, entry.BILIBILI_VIDEO_TOOL_DECLS.map(tool => tool.name).sort());
  assert(definition.describe);
  assert.deepEqual(names, definition.describe.tools.map(tool => tool.name).sort());
  const describe = JSON.parse(await readFile(join(packageRoot, manifest.cortico.describe), 'utf8')) as { tools: Array<{ name: string }>; events: Array<{ type: string }> };
  assert.deepEqual(names, describe.tools.map(tool => tool.name).sort());
  assert.deepEqual(describe.events.map(event => event.type).sort(), definition.describe.events.map(event => event.type).sort());

  assert(world.webUi);
  const ui = world.webUi('zh');
  assert.deepEqual(ui.panels?.map(panel => panel.id).sort(), ['auth', 'player']);
  assert(ui.lamps?.every(lamp => lamp.state === 'offline'), 'unstarted World claims an online connection');
  assert(ui.config && ui.config.length > 0);
  const keys: string[] = [];
  for (const group of ui.config) {
    assert.equal(group.owner, 'world:bilibili-video');
    for (const [key, schema] of Object.entries(group.schema.properties ?? {})) {
      assert(key.startsWith('worlds.bilibili-video.'));
      assert(!keys.includes(key), 'duplicate config field'); keys.push(key);
      const current = atPath(cfg, key.slice('worlds.bilibili-video.'.length));
      assert(current !== undefined, `missing default for ${key}`);
      if (schema.type === 'integer') assert(Number.isInteger(current));
      else if (schema.type === 'number') assert.equal(typeof current, 'number');
      else if (schema.type === 'boolean') assert.equal(typeof current, 'boolean');
      else if (schema.type === 'string') assert.equal(typeof current, 'string');
    }
  }
  for (const key of Object.keys(LEGACY_DEFAULTS.browser)) assert(keys.includes(`worlds.bilibili-video.browser.${key}`));
  const tutorial = ui.config.map(group => group.schema.description || '').join('\n');
  assert(tutorial.includes('中文使用教程') && tutorial.includes('扫码') && tutorial.includes('重开'));
  for (const prompt of ui.promptDocs ?? []) {
    assert(inside(packageRoot, prompt.path), 'prompt path escapes package root');
    assert((await lstat(prompt.path)).isFile());
  }
  for (const storage of ui.storage ?? []) {
    if (storage.location) assert(inside(dataRoot, storage.location), 'storage points outside the fresh temporary directory');
  }
  assert(ui.invoke);
  const auth = await ui.invoke('auth', 'state', []) as Record<string, unknown>;
  const player = await ui.invoke('player', 'state', []) as Record<string, unknown>;
  assert.equal(auth.status, 'none'); assert.equal(auth.isLogin, false); assert.equal(auth.uname, null);
  assert.equal(player.mode, 'idle'); assert.equal(player.url, ''); assert.equal(player.video, null);
  assert.equal(player.samples, 0); assert.equal(player.scenes, 0);
  const client = await lstat(join(packageRoot, manifest.cortico.webUiClient));
  assert(client.isFile() && client.size > 0);
  assert.deepEqual(attempts, { network: 0, process: 0 });
  Object.assign(result, { passed: true, name: manifest.name, version: manifest.version, api: manifest.cortico.api,
    id: definition.id, toolCount: names.length, describeToolCount: describe.tools.length, eventCount: describe.events.length,
    panels: ui.panels!.map(panel => panel.id), configFieldCount: keys.length, browserFieldCount: Object.keys(LEGACY_DEFAULTS.browser).length,
    defaultsMatchUpstream022: true, defaultsIndependent: true, chineseTutorial: true, staticWebUiPresent: true,
    stateReceipts: { auth: 'none/not-signed-in', player: 'idle/no-browser' }, attempts });
} catch (error) {
  result.passed = false;
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try { if (world) await limit(world.stop(), 5000, 'unstarted World stop'); }
  catch (error) { result.passed = false; result.stopError = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  if (dataRoot) {
    try {
      const stat = await lstat(dataRoot);
      const marker = JSON.parse(await readFile(join(dataRoot, '.package-smoke-owner.json'), 'utf8'));
      assert(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(await realpath(dataRoot), dataRoot);
      assert.equal(dirname(dataRoot).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert(basename(dataRoot).startsWith('bili-package-smoke-') && marker.token === markerToken && marker.pid === process.pid);
      await rm(dataRoot, { recursive: true, force: false });
      result.temporaryDirectoryRemoved = true;
    } catch (error) { result.passed = false; result.temporaryDirectoryRemoved = false; result.cleanupError = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  }
  for (const restore of undo.reverse()) restore();
  globalThis.fetch = originalFetch;
  syncBuiltinESMExports();
  result.attempts = attempts;
  if (attempts.network || attempts.process) { result.passed = false; process.exitCode = 1; }
  console.log(JSON.stringify(result));
}
