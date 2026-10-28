// Owner: Persona bounded-source exclusion from automatic workspace Git staging.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AUTHOR_OPERATOR, WorkspaceGit } from '../../packages/cortico-bot-xiaoshen-alont1/persona/workspaceGit.ts';

const privateFiles = [
  '.persona/recent-sources.json', '.persona/recent-ledger.json',
  '.persona/recent-sources.json.lock', '.persona/recent-ledger.json.lock',
];

function fixture(t: TestContext, existingIgnore?: string) {
  const base = resolve('scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'recent-git-'));
  mkdirSync(join(dir, '.persona'));
  if (existingIgnore !== undefined) writeFileSync(join(dir, '.gitignore'), existingIgnore);
  for (const file of privateFiles) writeFileSync(join(dir, file), 'synthetic bounded source');
  writeFileSync(join(dir, 'notes.md'), 'ordinary initial note');
  writeFileSync(join(dir, '.persona/other-settings.json'), 'unrelated owned data');
  const git = new WorkspaceGit(dir);
  assert.equal(git.available(), true, 'This regression requires a real Git executable');
  const command = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'safe.directory=*', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tracked = () => command('ls-files').split(/\r?\n/);
  const assertExcluded = () => { for (const file of privateFiles) assert.equal(tracked().includes(file), false, file); };
  t.after(() => { assert.ok(dir.startsWith(base + sep)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, git, command, tracked, assertExcluded };
}

test('initial workspace history ignores only new bounded source files and their locks', t => {
  const f = fixture(t);
  assert.equal(f.git.init().created, true);
  f.assertExcluded();
  assert.ok(f.tracked().includes('notes.md'));
  assert.ok(f.tracked().includes('.persona/other-settings.json'));
  const ignore = readFileSync(join(f.dir, '.gitignore'), 'utf8');
  for (const file of privateFiles) assert.ok(ignore.includes('/' + file + '\n'), file);
  assert.equal(ignore.split('\n').includes('/.persona/'), false);
});

test('existing ignore rules stay unchanged and exclusions apply to sync and async staging', async t => {
  const ignore = '# operator rules\n*.operator-only\n';
  const f = fixture(t, ignore);
  f.git.init();
  f.assertExcluded();
  assert.equal(readFileSync(join(f.dir, '.gitignore'), 'utf8'), ignore);

  writeFileSync(join(f.dir, 'notes.md'), 'ordinary sync change');
  assert.ok(f.git.commitAll('synthetic sync', AUTHOR_OPERATOR));
  assert.equal(f.command('show', 'HEAD:notes.md'), 'ordinary sync change');
  f.assertExcluded();

  writeFileSync(join(f.dir, 'notes.md'), 'ordinary async change');
  writeFileSync(join(f.dir, '.persona/other-settings.json'), 'settings still tracked');
  assert.ok(await f.git.commitAllAsync('synthetic async', AUTHOR_OPERATOR));
  assert.equal(f.command('show', 'HEAD:notes.md'), 'ordinary async change');
  assert.equal(f.command('show', 'HEAD:.persona/other-settings.json'), 'settings still tracked');
  f.assertExcluded();
  assert.equal(readFileSync(join(f.dir, '.gitignore'), 'utf8'), ignore);
});

test('excluded files alone do not cause empty commits or false commit failures', async t => {
  const f = fixture(t, '# existing rules\n');
  f.git.init();
  const head = f.command('rev-parse', 'HEAD');
  for (const file of privateFiles) writeFileSync(join(f.dir, file), 'synthetic updated source');
  assert.equal(f.git.commitAll('no ordinary changes', AUTHOR_OPERATOR), null);
  assert.equal(await f.git.commitAllAsync('no ordinary changes async', AUTHOR_OPERATOR), null);
  assert.equal(f.git.status().commitError, null);
  assert.equal(f.command('rev-parse', 'HEAD'), head);
  f.assertExcluded();
});

test('already tracked historical data is neither silently removed nor newly staged', t => {
  const f = fixture(t, '# old workspace\n');
  f.git.init();
  const file = '.persona/recent-sources.json';
  f.command('add', '--', file);
  f.command('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic prior history');
  const prior = f.command('rev-parse', 'HEAD');
  writeFileSync(join(f.dir, file), 'synthetic replacement after historical commit');
  writeFileSync(join(f.dir, 'notes.md'), 'ordinary change after old data');
  assert.ok(f.git.commitAll('ordinary update', AUTHOR_OPERATOR));
  assert.ok(f.tracked().includes(file));
  assert.equal(f.command('show', 'HEAD:' + file), 'synthetic bounded source');
  assert.equal(f.command('show', prior + ':' + file), 'synthetic bounded source');
  assert.equal(readFileSync(join(f.dir, file), 'utf8'), 'synthetic replacement after historical commit');
  assert.equal(f.command('show', 'HEAD:notes.md'), 'ordinary change after old data');
});

test('crash leftovers stay outside sync and async commits with existing operator ignore rules', async t => {
  const f = fixture(t, '# existing rules without temporary-file patterns\n');
  const leftovers = ['.persona/recent-sources.json.tmp-fixture', '.persona/recent-ledger.json.tmp-fixture'];
  for (const file of leftovers) writeFileSync(join(f.dir, file), 'synthetic crash leftover');
  f.git.init();
  for (const file of leftovers) assert.ok(!f.tracked().includes(file));
  writeFileSync(join(f.dir, 'notes.md'), 'normal sync');
  assert.ok(f.git.commitAll('sync fixture', AUTHOR_OPERATOR));
  for (const file of leftovers) assert.ok(!f.tracked().includes(file));
  writeFileSync(join(f.dir, 'notes.md'), 'normal async');
  assert.ok(await f.git.commitAllAsync('async fixture', AUTHOR_OPERATOR));
  for (const file of leftovers) assert.ok(!f.tracked().includes(file));
});

test('an operator ignoring the whole persona directory can still commit ordinary notes', async t => {
  const f = fixture(t, '/.persona/\n');
  assert.equal(f.git.init().created, true);
  f.assertExcluded();
  writeFileSync(join(f.dir, 'notes.md'), 'ordinary sync with ignored parent');
  assert.ok(f.git.commitAll('ordinary sync', AUTHOR_OPERATOR));
  writeFileSync(join(f.dir, 'notes.md'), 'ordinary async with ignored parent');
  assert.ok(await f.git.commitAllAsync('ordinary async', AUTHOR_OPERATOR));
  assert.equal(f.command('show', 'HEAD:notes.md'), 'ordinary async with ignored parent');
  f.assertExcluded();
});
