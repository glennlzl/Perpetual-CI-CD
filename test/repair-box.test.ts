import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepairBoxes, type DISK } from '../src/repair/box.ts';
import { EGRESS_SCRIPT } from '../src/repair/egress.ts';

// A docker CLI double: it records each call's arguments and answers from state.json beside it. `exec ... sleep` runs
// until the box is removed, as a command in a real box dies with it. No Docker runs.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = __dirname, args = process.argv.slice(2), [command, ...rest] = args;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const removed = () => fs.existsSync(path.join(dir, 'removed'));
const out = text => process.stdout.write(text);
if (command === 'version') out('29.0.0\\n');
else if (command === 'ps') out(state.containers.join('\\n'));
else if (command === 'network' && rest[0] === 'ls') out(state.networks.join('\\n'));
else if (command === 'network' && rest[0] === 'create' || command === 'create') out('b'.repeat(64) + '\\n');
else if (command === 'container') out(String(state.size) + '\\n');
else if (command === 'rm') fs.writeFileSync(path.join(dir, 'removed'), rest.join(' '));
else if (command === 'exec' && rest.includes('df')) out('Filesystem 1024-blocks Used Available Capacity Mounted on\\noverlay 100000000 1000 ' + state.availableKb + ' 1% /\\n');
else if (command === 'exec' && rest.includes('sleep')) { const timer = setInterval(() => { if (removed()) process.exit(137); }, 10); setTimeout(() => { clearInterval(timer); }, 5000); }
`;
async function fake(t: TestContext, state: Partial<{ size: number; availableKb: number; containers: string[]; networks: string[] }> = {}, disk: Partial<typeof DISK> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-fake-docker-')), docker = join(dir, 'docker');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(docker, FAKE, { mode: 0o755 });
  const write = (next: object) => writeFile(join(dir, 'state.json'), JSON.stringify({ size: 1000, availableKb: 50 * 1024 * 1024, containers: [], networks: [], ...next }));
  await write(state);
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  return { boxes: createRepairBoxes({ dataDir: dir, owner: 'repair-unit', docker, disk: { checkMs: 20, ...disk } }), calls, write, dir };
}

test('a box sits alone on an internal network, reaching out only through its egress proxy, and is removed with both', async t => {
  const f = await fake(t, { containers: ['c'.repeat(64)], networks: ['d'.repeat(64)] });
  const box = await f.boxes.create({ id: 'r1', image: 'node:22-bookworm', source: f.dir });
  const calls = await f.calls(), name = 'perpetual-repair-unit-r1', proxy = `${name}-proxy`;
  assert.ok(calls.some(call => call.join(' ') === `rm -f -v ${'c'.repeat(64)}`) && calls.some(call => call.join(' ') === `network rm ${'d'.repeat(64)}`), 'Leftover boxes, proxies and networks go first.');
  const network = calls.find(call => call[0] === 'network' && call[1] === 'create')!;
  assert.deepEqual([network.includes('--internal'), network.at(-1), network.filter(arg => arg.startsWith('perpetual.')).length], [true, name, 3]);
  const proxied = calls.find(call => call[0] === 'create' && call[2] === proxy)!;
  for (const flag of ['--read-only', '--init']) assert.ok(proxied.includes(flag), flag);
  assert.deepEqual([proxied[proxied.indexOf('--cap-drop') + 1], proxied[proxied.indexOf('--user') + 1], proxied[proxied.indexOf('--network') + 1]], ['ALL', 'node', 'bridge']);
  assert.deepEqual(proxied.slice(-5), ['node:22-bookworm-slim', 'node', '-e', EGRESS_SCRIPT, '3128']);
  assert.ok(calls.some(call => call.join(' ') === `network connect --alias proxy ${name} ${proxy}`));
  const created = calls.find(call => call[0] === 'create' && call[2] === name)!;
  assert.equal(created[created.indexOf('--network') + 1], name, 'The box joins only its internal network.');
  assert.ok(!created.includes('bridge') && !created.includes('host') && !created.some(arg => /^(?:-v|--volume|--mount|--privileged)$/.test(arg) || arg.includes('docker.sock')));
  assert.ok(created.includes('HTTPS_PROXY=http://proxy:3128') && created.includes('NO_PROXY=localhost,127.0.0.1,::1'));
  await box.remove();
  const after = await f.calls();
  assert.ok(after.some(call => call.join(' ') === `rm -f -v ${name} ${proxy}`) && after.some(call => call.join(' ') === `network rm ${name}`));
});

test('a box that writes more than its disk limit is removed while it works, and its commands reject with why', async t => {
  const f = await fake(t, {}, { limit: 1024 ** 3 });
  const box = await f.boxes.create({ id: 'r2', image: 'node:22-bookworm', source: f.dir });
  await f.write({ size: 2 * 1024 ** 3 });
  await assert.rejects(box.exec(['sleep', '5']), /The repair box wrote more than 1 GB and was removed\./);
  assert.equal(box.signal?.aborted, true);
  await assert.rejects(box.exec(['true']), /wrote more than 1 GB/, 'A removed box runs nothing.');
  assert.ok((await f.calls()).some(call => call.join(' ') === 'rm -f -v perpetual-repair-unit-r2 perpetual-repair-unit-r2-proxy'));
});

test('a box is removed when Docker runs low on disk space, whoever filled it', async t => {
  const f = await fake(t, {}, { floor: 2 * 1024 ** 3 });
  const box = await f.boxes.create({ id: 'r3', image: 'node:22-bookworm', source: f.dir });
  await f.write({ availableKb: 1024 * 1024 });
  await assert.rejects(box.exec(['sleep', '5']), /Docker has less than 2 GB of disk space left, so the repair box was removed\./);
});

test('an idle box is not read, and one within its bounds keeps working', async t => {
  const f = await fake(t);
  const box = await f.boxes.create({ id: 'r4', image: 'node:22-bookworm', source: f.dir });
  await new Promise(done => setTimeout(done, 100));
  assert.ok(!(await f.calls()).some(call => call[0] === 'container'), 'Nothing is read while the box is idle.');
  assert.equal((await box.exec(['true'])).exitCode, 0);
  await new Promise(done => setTimeout(done, 100));
  assert.ok((await f.calls()).some(call => call[0] === 'container'), 'Its writes are read after it worked.');
  assert.equal(box.signal?.aborted, false);
  await box.remove();
});
