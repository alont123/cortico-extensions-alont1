/** Real PowerShell/helper code with blocked GUI spawn and synthetic local DevTools HTTP. */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../scripts/start-browser.ps1', import.meta.url));
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const roots: string[] = [];
const q = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const ROOT = () => { const root = mkdtempSync(join(realpathSync(tmpdir()), 'bili-helper-unit-')); roots.push(root); return root; };
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(realpathSync(root)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !basename(root).startsWith('bili-helper-unit-')) throw Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

async function powershell(body: string) {
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
function Start-Process { throw 'Unit tests forbid real browser launch' }
. ${q(helper)}
${body}`;
  // Only a human operator's explicit opt-in may answer a remote-file Run Once prompt.
  // This flag is test-only; neither production launcher changes policy nor answers it.
  const approved = process.env.BILI_HELPER_RUN_ONCE_APPROVED === '1';
  const pending = run(ps, ['-NoLogo', '-NoProfile', ...(approved ? [] : ['-NonInteractive']), '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 });
  if (approved) pending.child.stdin?.end('R\r\n');
  const { stdout } = await pending.catch((error: {stderr?: string; message: string}) => {
    throw new Error('PowerShell helper test failed (review policy prompt before explicit Run Once opt-in): ' + (error.stderr ?? error.message).slice(-1800));
  });
  const result = stdout.match(/BILI_RESULT:(.*)/);
  if (!result) throw Error('Missing PowerShell result: ' + stdout);
  return JSON.parse(result[1]);
}
const result = (expression: string) => `[Console]::WriteLine('BILI_RESULT:' + ((${expression}) | ConvertTo-Json -Depth 8 -Compress))`;
const fakeEndpoint = `function Wait-Endpoint { return [pscustomobject]@{Port=48123;WebSocket='ws://127.0.0.1:48123/devtools/browser/helper-test';Browser='Edg/test'} }`;

describe.skipIf(process.platform !== 'win32')('desktop helper boundaries', () => {
  it('quotes spaces, embedded quotes and trailing backslashes as Windows argv', async () => {
    const inputs = ['plain', 'D:\\中文 空格\\', 'a\\"b', 'x & calc.exe'];
    const output = await powershell(result('@(' + inputs.map(s => '(Quote-Argument ' + q(s) + ')').join(',') + ')'));
    expect(output).toEqual(['"plain"', '"D:\\中文 空格\\\\"', '"a\\\\\\"b"', '"x & calc.exe"']);
  });

  it('writes only its connection record and preserves configuration and user files', async () => {
    const root = ROOT(); const config = join(root, 'config.json'); writeFileSync(config, '{"private":"preserve"}');
    writeFileSync(join(root, 'keep.txt'), 'preserve');
    const output = await powershell(`
function Find-Browsers { return @('edge-fixture.exe') }
$script:captured=''
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$ErrorAction) $script:captured=$ArgumentList; return [pscustomobject]@{Id=42} }
${fakeEndpoint}
$connection=Invoke-BrowserHelper -DataDir ${q(root)}
${result('@{connection=$connection;arguments=$script:captured}')}`);
    const connection = output.connection;
    expect(connection.cdpUrl).toBe('http://127.0.0.1:48123');
    expect(connection.launcherPid).toBe(42);
    expect(output.arguments).toContain('"--remote-debugging-port=0"');
    expect(output.arguments).toContain('"--user-data-dir=' + connection.profile + '"');
    const marker = JSON.parse(readFileSync(join(connection.profile, '.cortico-external-browser.json'), 'utf8'));
    expect(marker.token).toBe(connection.token);
    const recorded = JSON.parse(readFileSync(join(root, 'bilibili-video/external-browser-connection.json'), 'utf8'));
    expect(recorded).toEqual(connection);
    expect(readFileSync(config, 'utf8')).toBe('{"private":"preserve"}');
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('preserve');
  });

  it('uses a fresh profile for each failed candidate and every invocation', async () => {
    const root = ROOT();
    const output = await powershell(`
function Find-Browsers { return @('broken.exe','edge.exe') }
$script:arguments=@()
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$ErrorAction)
  $script:arguments+=,$ArgumentList
  if($FilePath -eq 'broken.exe'){throw 'synthetic ENOENT'}
  return [pscustomobject]@{Id=43}
}
${fakeEndpoint}
$a=Invoke-BrowserHelper -DataDir ${q(root)}
$b=Invoke-BrowserHelper -DataDir ${q(root)}
${result('@{a=$a;b=$b;arguments=$script:arguments}')}`);
    expect(output.arguments).toHaveLength(4);
    expect(new Set(output.arguments).size).toBe(4);
    expect(output.a.profile).not.toBe(output.b.profile);
    expect(existsSync(output.a.profile)).toBe(true);
    expect(existsSync(output.b.profile)).toBe(true);
  });

  it('replaces an existing connection record with the newly verified endpoint', async () => {
    const root = ROOT(); const record = join(root, 'bilibili-video/external-browser-connection.json');
    mkdirSync(dirname(record)); writeFileSync(record, '{"old":"preserve-until-replaced"}');
    const output = await powershell(`
function Find-Browsers { return @('edge-fixture.exe') }
function Start-Process { return [pscustomobject]@{Id=44} }
${fakeEndpoint}
$connection=Invoke-BrowserHelper -DataDir ${q(root)}
${result('$connection')}`);
    expect(output.cdpUrl).toBe('http://127.0.0.1:48123');
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(output);
    expect(existsSync(join(dirname(record), '.external-browser-connection-' + output.token + '.tmp'))).toBe(false);
  });

  it('preserves the exact old record bytes when a real file lock prevents replacement', async () => {
    const root = ROOT(); const record = join(root, 'bilibili-video/external-browser-connection.json');
    const oldBytes = Buffer.from('\ufeff{"old":"keep exact bytes"}\r\n', 'utf8');
    mkdirSync(dirname(record)); writeFileSync(record, oldBytes);
    const output = await powershell(`
function Find-Browsers { return @('edge-fixture.exe') }
function Start-Process { return [pscustomobject]@{Id=45} }
${fakeEndpoint}
$message=''
$lock=[IO.File]::Open(${q(record)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try{Invoke-BrowserHelper -DataDir ${q(root)}}catch{$message=$_.Exception.Message}finally{$lock.Dispose()}
${result('@{message=$message;profiles=@(Get-ChildItem -LiteralPath ' + q(join(root, 'bilibili-video/external-browser')) + ').Count}')}`);
    expect(output.message).toContain('浏览器未就绪');
    expect(output.message).toMatch(/Replace/);
    expect(output.message).toMatch(/进程|process/i);
    expect(output.profiles).toBe(1);
    expect(readFileSync(record)).toEqual(oldBytes);
  });

  it('rejects invalid bounds before writing files or attempting spawn', async () => {
    const root = ROOT();
    const output = await powershell(`
$rejected=0
foreach($seconds in @(0,31)){try{Invoke-BrowserHelper -DataDir ${q(root)} -TimeoutSec $seconds}catch{$rejected++}}
try{Invoke-BrowserHelper -DataDir ${q(root)} -WindowWidth 0}catch{$rejected++}
${result('@{rejected=$rejected;files=@(Get-ChildItem -LiteralPath ' + q(root) + ').Count}')}`);
    expect(output).toEqual({ rejected: 3, files: 0 });
  });

  it('refuses a junction in its output directory without touching the target', async () => {
    const root = ROOT(); const target = join(root, 'target'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'unchanged');
    symlinkSync(target, join(root, 'bilibili-video'), 'junction');
    const output = await powershell(`function Find-Browsers { return @('edge.exe') }
$message='';try{Invoke-BrowserHelper -DataDir ${q(root)}}catch{$message=$_.Exception.Message}
${result('@{message=$message}')}`);
    expect(output.message).toMatch(/链接/);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('unchanged');
  });

  it('keeps a previous connection record and profiles when startup fails', async () => {
    const root = ROOT(); const record = join(root, 'bilibili-video/external-browser-connection.json'); mkdirSync(dirname(record));
    writeFileSync(record, '{"old":"preserve"}');
    const output = await powershell(`function Find-Browsers { return @('missing.exe') }
$message='';try{Invoke-BrowserHelper -DataDir ${q(root)}}catch{$message=$_.Exception.Message}
${result('@{message=$message;profiles=@(Get-ChildItem -LiteralPath ' + q(join(root, 'bilibili-video/external-browser')) + ').Count}')}`);
    expect(output.message).toContain('Unit tests forbid real browser launch');
    expect(output.profiles).toBe(1);
    expect(readFileSync(record, 'utf8')).toBe('{"old":"preserve"}');
  });

  it('waits only its short deadline when DAP is absent', async () => {
    const root = ROOT();
    const output = await powershell(`$watch=[Diagnostics.Stopwatch]::StartNew();$message=''
try{Wait-Endpoint ${q(root)} 90}catch{$message=$_.Exception.Message}
${result('@{ms=$watch.ElapsedMilliseconds;message=$message}')}`);
    expect(output.ms).toBeLessThan(1000);
    expect(output.message).toContain('端口未就绪');
  });

  it.each(['matching', 'path', 'port', 'credentials', 'query', 'remote', 'redirect', 'large', 'bad-json', 'slow'])('validates real local HTTP response: %s', async (mode) => {
    const root = ROOT(); let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      if (mode === 'slow') {
        res.writeHead(200); res.write(' ');
        const timer = setInterval(() => res.write(' '), 40);
        res.on('close', () => clearInterval(timer)); return;
      }
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.invalid/' }); res.end(); return; }
      if (mode === 'large') { res.end(' '.repeat(65537)); return; }
      if (mode === 'bad-json') { res.end('invalid'); return; }
      const port = (server.address() as {port: number}).port;
      const host = mode === 'remote' ? 'example.invalid' : '127.0.0.1';
      const auth = mode === 'credentials' ? 'user:secret@' : '';
      res.end(JSON.stringify({ Browser: 'Edg/test', webSocketDebuggerUrl: `ws://${auth}${host}:${mode === 'port' ? port + 1 : port}/devtools/browser/${mode === 'path' ? 'wrong' : 'helper-test'}${mode === 'query' ? '?x=1' : ''}` }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    writeFileSync(join(root, 'DevToolsActivePort'), `${port}\n/devtools/browser/helper-test\n`);
    try {
      const output = await powershell(`$value=$null;$rejected=$false;$failure=''
try{$value=Read-Endpoint ${q(root)} ${mode === 'slow' ? 250 : 3000}}catch{$rejected=$true;$failure=$_.Exception.Message}
${result('@{value=$value;rejected=$rejected;failure=$failure}')}`);
      expect(output.rejected, output.failure).toBe(mode !== 'matching');
      if (mode === 'matching') expect(output.value.Port).toBe(port);
      expect(requests).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(['0\n/devtools/browser/test', '65536\n/devtools/browser/test', 'x'.repeat(4097)])('rejects invalid DAP before any HTTP request (%#)', async (contents) => {
    const root = ROOT(); writeFileSync(join(root, 'DevToolsActivePort'), contents);
    const output = await powershell(`$rejected=$false;try{Read-Endpoint ${q(root)}}catch{$rejected=$true}
${result('@{rejected=$rejected}')}`);
    expect(output.rejected).toBe(true);
  });
});
