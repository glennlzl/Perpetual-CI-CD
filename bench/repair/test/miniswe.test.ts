// The mini-swe-agent adapter without Docker or a model. First pure units: the job (the model, the gateway's URL and
// token, INSTRUCTIONS with the harness note, the limits), the driver's environment (no host variable, no token), the
// box command, the driver's messages read as unknown, and how mini's exit statuses map to the shared outcome. Then,
// once adapters/miniswe/.venv is synced, whole attempts: the real driver and mini behind a real gateway and the fake
// upstream, its commands running in a host-folder box double (the product's test fixture), the gateway accounting.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenRepository, hostBox } from '../../../test/fixtures/repair-box.ts';
import { COMMAND, HERE, LOCKED, PYTHON, REQUEST, adapter, boxCommand, driverEnvironment, driverJob, lockedVersion, outcomeOf, readMessage, type DriverResult } from '../adapters/miniswe/index.ts';
import type { BenchBox } from '../box.ts';
import { FAKE_KEY, SUBMIT, createFakeUpstream, type FakeReply } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { LIMITS, appendedInstructions, type AttemptEvent } from '../harness.ts';
import { finalReason } from '../run.ts';

const MODEL = { id: 'fake/coder', contextWindow: 200_000, maxOutput: 32_000, reasoning: true };
const UNAME = { system: 'Linux', node: 'box', release: '6.10.14-linuxkit', version: '#1 SMP', machine: 'aarch64', processor: '' };
const synced = await access(PYTHON).then(() => true, () => false);
const skip = !synced && 'Run `uv sync --frozen` in adapters/miniswe, or node run.ts setup, to run mini-swe-agent.';

test('the job carries the model, the gateway and its token, INSTRUCTIONS with the harness note and the limits; the environment holds no token', () => {
  const job = driverJob({ system: 'Fix it.', prompt: 'Repository acme/app. Fix the build.', model: MODEL, gateway: { baseUrl: 'http://127.0.0.1:1234/api/v1', token: 'attempt-token' }, limits: LIMITS,
    image: 'node:22-bookworm', root: '/workspace', uname: UNAME, trajectory: '/scratch/trajectory.json' });
  assert.deepEqual([job.model, job.baseUrl, job.token, job.prompt, job.image, job.root], ['fake/coder', 'http://127.0.0.1:1234/api/v1', 'attempt-token', 'Repository acme/app. Fix the build.', 'node:22-bookworm', '/workspace']);
  assert.equal(job.instructions, appendedInstructions('miniswe', 'Fix it.'));
  assert.ok(job.instructions.startsWith('Fix it.\n\n') && job.instructions.includes(SUBMIT), 'INSTRUCTIONS verbatim, then the harness note.');
  assert.deepEqual([job.stepLimit, job.costLimit, job.wallSeconds, job.commandSeconds, job.requestSeconds], [100, 0.5, 900, COMMAND.seconds, REQUEST.seconds]);
  const env = driverEnvironment('/scratch');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'MSWEA_GLOBAL_CONFIG_DIR', 'MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT', 'MSWEA_SILENT_STARTUP', 'PATH']);
  assert.deepEqual([env.HOME, env.MSWEA_GLOBAL_CONFIG_DIR, env.MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT], ['/scratch', '/scratch/mini-swe-agent', '3']);
  assert.ok(!JSON.stringify(env).includes('attempt-token'));
});

test('a command runs as mini\'s DockerEnvironment runs one: mini.yaml\'s variables, then bash -lc, stderr merged', () => {
  assert.deepEqual(boxCommand('npm test 2>/dev/null', { PAGER: 'cat', TQDM_DISABLE: '1' }, ['bash', '-lc']),
    ['env', 'PAGER=cat', 'TQDM_DISABLE=1', 'sh', '-c', 'exec 2>&1; exec "$@"', 'sh', 'bash', '-lc', 'npm test 2>/dev/null']);
});

test('the driver\'s messages are read as unknown, and a malformed one fails closed', () => {
  const exec = { type: 'exec', id: 1, command: 'ls', timeout: 300, env: { PAGER: 'cat' }, interpreter: ['bash', '-lc'] };
  assert.deepEqual(readMessage(JSON.stringify(exec)), { type: 'exec', request: { id: 1, command: 'ls', timeout: 300, env: { PAGER: 'cat' }, interpreter: ['bash', '-lc'] } });
  const bad = [{ ...exec, id: 0 }, { ...exec, id: '1' }, { ...exec, command: 1 }, { ...exec, timeout: 1.5 }, { ...exec, env: { 'A=B': 'x' } }, { ...exec, env: { A: 1 } },
    { ...exec, interpreter: [] }, { ...exec, interpreter: ['bash\0'] }, { type: 'other' }, [exec], null];
  for (const message of bad) assert.equal(readMessage(JSON.stringify(message)), null, JSON.stringify(message));
  assert.equal(readMessage('{"type":"exec"'), null);
  assert.deepEqual(readMessage(JSON.stringify({ type: 'result', exitStatus: 'Submitted', submission: 'Done.\n', steps: 4, cost: 0.04, version: '2.4.6', errorKind: 'odd', extra: 1 })),
    { type: 'result', result: { exitStatus: 'Submitted', submission: 'Done.\n', steps: 4, cost: 0.04, version: '2.4.6', errorKind: null, error: '' } });
  assert.deepEqual(readMessage(JSON.stringify({ type: 'result', steps: -1, cost: 'x', error: 7 })),
    { type: 'result', result: { exitStatus: '', submission: '', steps: 0, cost: 0, version: '', errorKind: null, error: '' } });
});

test('mini\'s exit statuses map to the shared outcome', () => {
  const result = (changes: Partial<DriverResult>): DriverResult => ({ exitStatus: '', submission: '', steps: 3, cost: 0.03, version: '2.4.6', errorKind: null, error: '', ...changes });
  assert.deepEqual(outcomeOf(result({ exitStatus: 'Submitted', submission: '  The cause and the fix.\n' }), LIMITS), { reason: 'done', summary: 'The cause and the fix.', steps: 3, frameworkCost: 0.03 });
  assert.equal(outcomeOf(result({ exitStatus: 'LimitsExceeded', steps: 100 }), LIMITS).reason, 'steps');
  assert.equal(outcomeOf(result({ exitStatus: 'LimitsExceeded', steps: 12 }), LIMITS).reason, 'cost');
  assert.equal(outcomeOf(result({ exitStatus: 'TimeExceeded' }), LIMITS).reason, 'time');
  assert.equal(outcomeOf(result({ exitStatus: 'RepeatedFormatError' }), LIMITS).reason, 'idle');
  assert.deepEqual(outcomeOf(result({ exitStatus: 'BenchRefused', errorKind: 'provider', error: 'HTTP 402: Bench limit.' }), LIMITS), { reason: 'provider', error: 'HTTP 402: Bench limit.', steps: 3, frameworkCost: 0.03 });
  assert.equal(outcomeOf(result({ exitStatus: 'BenchRejected', errorKind: 'provider', error: 'HTTP 400: This endpoint\'s maximum context length is 200000 tokens.' }), LIMITS).reason, 'context');
  assert.equal(outcomeOf(result({ exitStatus: 'BridgeError', errorKind: 'bridge', error: 'The bench runner closed the command channel.' }), LIMITS).reason, 'error');
  assert.deepEqual(outcomeOf(result({ exitStatus: 'KeyError', errorKind: 'error' }), LIMITS), { reason: 'error', error: 'mini-swe-agent ended with KeyError.', steps: 3, frameworkCost: 0.03 });
});

test('mini-swe-agent 2.4.6 is pinned, locked for Python 3.12 and reported as the framework under test', async () => {
  assert.match(await readFile(join(HERE, 'pyproject.toml'), 'utf8'), /"mini-swe-agent==2\.4\.6"/);
  const lock = await readFile(join(HERE, 'uv.lock'), 'utf8');
  assert.deepEqual([lockedVersion(lock, 'mini-swe-agent'), LOCKED, adapter.version, adapter.inBox], ['2.4.6', '2.4.6', 'mini-swe-agent@2.4.6', false]);
  assert.equal(lockedVersion(lock, 'no-such-package'), null);
  assert.equal((await readFile(join(HERE, '.python-version'), 'utf8')).trim(), '3.12');
});

const bash = (command: string, cost = 0.01): FakeReply => ({ calls: [{ name: 'bash', arguments: { command } }], cost });
async function setup(t: TestContext, replies: FakeReply[], { cap = 0.5 } = {}) {
  const source = await mkdtemp(join(tmpdir(), 'bench-miniswe-')), scratch = await mkdtemp(join(tmpdir(), 'bench-miniswe-scratch-'));
  await brokenRepository(source);
  const made = await hostBox(source);
  const upstream = await createFakeUpstream({ script: (_body, index) => replies[index] ?? { text: 'Finished.' } });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 5, upstream: upstream.url });
  t.after(async () => { await made.box.remove(); await gateway.stop(); await upstream.stop(); for (const path of [source, scratch]) await rm(path, { recursive: true, force: true }); });
  const opened = await gateway.open({ attempt: 'miniswe', model: MODEL.id, cap, deadline: Date.now() + 120_000 });
  const events: AttemptEvent[] = [];
  const run = (limits = LIMITS) => adapter.runAttempt({ box: made.box as unknown as BenchBox, system: 'Fix it.', prompt: 'Repository acme/app. Fix the build.', failing: ['node check.js'], model: MODEL,
    gateway: { baseUrl: gateway.url, token: opened!.token }, limits, signal: new AbortController().signal, scratch, log: event => { events.push(event); } });
  return { made, upstream, gateway, token: opened!.token, run, events };
}

test('mini reproduces, edits, verifies and submits through the gateway, every command running in the box as DockerEnvironment runs it', { skip, timeout: 120_000 }, async t => {
  const f = await setup(t, [
    bash('node check.js'),
    bash('sed -i.bak "s/a - b/a + b/" add.js && rm add.js.bak'),
    bash('node check.js'),
    bash(`echo ${SUBMIT} && echo 'add() subtracted; node check.js passes.'`),
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced, outcome.summary], ['done', 4, true, 'add() subtracted; node check.js passes.']);
  assert.ok(Math.abs((outcome.frameworkCost ?? 0) - 0.04) < 1e-9, 'mini and the gateway read the same cost.');
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.requests, usage.toolCalls, usage.modelViolations], [4, 4, []]);
  const bodies = f.upstream.received.filter(item => item.path === '/api/v1/chat/completions');
  assert.ok(bodies.every(item => item.authorization === `Bearer ${FAKE_KEY}`));
  const first = bodies[0].body as { model: string; messages: { role: string; content: string }[]; tools: { function: { name: string } }[]; usage: unknown; stream?: unknown; drop_params?: unknown };
  assert.deepEqual([first.model, first.tools.map(tool => tool.function.name), first.usage, first.stream, first.drop_params], ['fake/coder', ['bash'], { include: true }, undefined, undefined]);
  assert.deepEqual(first.messages.map(message => message.role), ['system', 'user']);
  assert.ok(first.messages[0].content.endsWith(`\n\n${appendedInstructions('miniswe', 'Fix it.')}`), 'INSTRUCTIONS and the harness note follow mini\'s system template.');
  assert.match(first.messages[1].content, /^Please solve this issue: Repository acme\/app\. Fix the build\./);
  // The box ran the probe and the four commands, each under mini.yaml's variables and bash -lc; nothing ran on the host.
  const commands = f.made.calls.map(call => call.argv).filter(argv => argv[0] === 'env');
  assert.deepEqual(commands.map(argv => argv.slice(-3)), ['node check.js', 'sed -i.bak "s/a - b/a + b/" add.js && rm add.js.bak', 'node check.js', `echo ${SUBMIT} && echo 'add() subtracted; node check.js passes.'`].map(command => ['bash', '-lc', command]));
  assert.ok(commands.every(argv => argv.includes('PAGER=cat') && argv.includes('TQDM_DISABLE=1')));
  assert.deepEqual(f.events.filter(event => event.type === 'exec').map(event => event.exit), [1, 0, 0, 0]);
});

test('a gateway refusal ends the attempt at once, unretried, and outranks it; mini\'s own cost limit stops first when it can', { skip, timeout: 120_000 }, async t => {
  const capped = await setup(t, Array.from({ length: 5 }, () => bash('true', 0.3)));
  const own = await capped.run();
  assert.deepEqual([own.reason, own.steps, own.reproduced], ['cost', 2, false]);
  const refused = await setup(t, [bash('true', 0.3), bash('true', 0.3)], { cap: 0.2 });
  const cut = await refused.run({ ...LIMITS, cost: 5 });
  const usage = await refused.gateway.close(refused.token);
  assert.equal(cut.reason, 'provider');
  assert.match(cut.error ?? '', /HTTP 402/);
  assert.deepEqual([usage.requests, usage.refusals.cost, usage.firstRefusal, finalReason(usage.firstRefusal, false, cut.reason)], [1, 1, 'cost', 'cost']);
});
