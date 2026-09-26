import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairTools, workspacePath } from '../src/repair/tools.ts';
import { brokenRepository, hostBox } from './fixtures/repair-box.ts';

type Output = { ok: boolean; error?: string; [key: string]: unknown };
async function tools(t: TestContext) {
  const source = await mkdtemp(join(tmpdir(), 'perpetual-repair-tools-'));
  const outside = await mkdtemp(join(tmpdir(), 'perpetual-repair-outside-'));
  await brokenRepository(source);
  await writeFile(join(outside, 'secret.txt'), 'outside the workspace\n');
  const made = await hostBox(source);
  t.after(async () => { await made.box.remove(); await rm(source, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const events = { runs: [] as [string, number][], changes: [] as string[] };
  const set = repairTools(made.box, { events: { run: (command, code) => events.runs.push([command, code]), change: path => events.changes.push(path) } });
  const call = async (name: keyof typeof set, input: unknown) => (await (set[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(input, { toolCallId: 'x', messages: [] })) as Output;
  return { ...made, outside, events, call };
}

test('paths are relative to /workspace, never outside it or in .git', () => {
  assert.deepEqual(workspacePath('src/../add.js'), { path: 'add.js' });
  assert.deepEqual(workspacePath('/workspace/src/a.ts'), { path: 'src/a.ts' });
  assert.deepEqual(workspacePath(undefined, '.'), { path: '.' });
  for (const value of ['../x', '/etc/passwd', 'a/../../x', '.git/config', 'pkg/.GIT/HEAD', 42, 'a\0b']) assert.ok('error' in workspacePath(value), String(value));
});

test('list, read and grep see the workspace only, capped with a truncated flag', async t => {
  const f = await tools(t);
  const listed = await f.call('list', {});
  assert.deepEqual([listed.ok, listed.entries], [true, ['.github/', 'add.js', 'check.js', 'package.json']], '.git is not listed.');
  const read = await f.call('read', { path: 'check.js', offset: 2, limit: 1 });
  assert.deepEqual([read.content, read.truncated, read.next], ['2\tconst sum = add(2, 3);', true, 3]);
  assert.equal((await f.call('read', { path: 'add.js' })).truncated, false);
  const grep = await f.call('grep', { pattern: 'add\\(', include: '*.js' });
  assert.deepEqual(grep.matches, ['check.js:2:const sum = add(2, 3);', 'check.js:3:if (sum !== 5) { console.error(`Error: add(2, 3) returned ${sum}, expected 5`); process.exit(1); }']);
  assert.match((await f.call('grep', { pattern: '(' })).error ?? '', /The search failed/);
  assert.match((await f.call('read', { path: 'missing.js' })).error ?? '', /not a file/);
});

test('a link cannot lead a tool out of the workspace or into .git', async t => {
  const f = await tools(t);
  await symlink(f.outside, join(f.root, 'out'));
  await symlink(join(f.root, '.git'), join(f.root, 'meta'));
  await symlink(join(f.outside, 'secret.txt'), join(f.root, 'secret-link'));
  for (const [name, input] of [['read', { path: 'out/secret.txt' }], ['read', { path: 'secret-link' }], ['list', { path: 'out' }], ['grep', { pattern: 'outside', path: 'out' }],
    ['write', { path: 'out/new.txt', text: 'x' }], ['edit', { path: 'secret-link', old: 'outside', new: 'inside' }]] as const) {
    assert.match((await f.call(name, input)).error ?? '', /leads outside \/workspace/, `${name} ${JSON.stringify(input)}`);
  }
  assert.match((await f.call('read', { path: 'meta/config' })).error ?? '', /leads into \.git/);
  assert.match((await f.call('write', { path: 'meta/hooks/pre-commit', text: 'x' })).error ?? '', /leads into \.git/);
  assert.match((await f.call('read', { path: '/etc/hosts' })).error ?? '', /outside \/workspace/);
  assert.equal(await readFile(join(f.outside, 'secret.txt'), 'utf8'), 'outside the workspace\n');
  assert.deepEqual(f.events.changes, []);
});

test('edit replaces text that occurs once, write creates folders, and both report the change', async t => {
  const f = await tools(t);
  assert.match((await f.call('edit', { path: 'add.js', old: 'a * b', new: 'x' })).error ?? '', /not found/);
  await writeFile(join(f.root, 'twice.js'), 'x\nx\n');
  assert.match((await f.call('edit', { path: 'twice.js', old: 'x', new: 'y' })).error ?? '', /occurs 2 times/);
  assert.equal((await f.call('edit', { path: 'add.js', old: 'a - b', new: 'a + b' })).ok, true);
  assert.equal(await readFile(join(f.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  assert.equal((await f.call('write', { path: 'docs/notes/fix.md', text: '# Fix\n' })).ok, true);
  assert.equal(await readFile(join(f.root, 'docs/notes/fix.md'), 'utf8'), '# Fix\n');
  await mkdir(join(f.root, 'folder'));
  assert.match((await f.call('write', { path: 'folder', text: 'x' })).error ?? '', /is a folder/);
  assert.deepEqual(f.events.changes, ['add.js', 'docs/notes/fix.md']);
});

test('run returns the exit code and the tail of the merged output, and stops at its time limit', async t => {
  const f = await tools(t);
  const failing = await f.call('run', { command: 'node check.js' });
  assert.deepEqual([failing.exitCode, failing.timedOut], [1, false]);
  assert.match(String(failing.output), /add\(2, 3\) returned -1, expected 5/);
  const long = await f.call('run', { command: 'for i in $(seq 1 20000); do echo "line $i"; done' });
  assert.equal(long.truncated, true);
  assert.match(String(long.output), /line 20000\n$/);
  const slow = await f.call('run', { command: 'sleep 5', timeoutSeconds: 1 });
  assert.equal(slow.timedOut, true);
  assert.match((await f.call('run', { command: 'true', timeoutSeconds: 901 })).error ?? '', /at most|from 1 to 900/);
  assert.deepEqual(f.events.runs.map(([, code]) => code).slice(0, 2), [1, 0]);
});
