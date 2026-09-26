// The pi adapter without Docker or a model: pi's own session and tools, pointed at the gateway, drive the box double
// (the product's test fixture, a host folder) from scripted fake-upstream replies, and the requests that reach the fake
// show the model, prompt, instructions, tools and key pi sent. Skipped where pi is not installed (npm ci --prefix
// adapters/pi).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenRepository, hostBox } from '../../../test/fixtures/repair-box.ts';
import { adapter } from '../adapters/pi/index.ts';
import type { BenchBox } from '../box.ts';
import { FAKE_KEY, createFakeUpstream, type FakeReply } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { LIMITS, appendedInstructions, type AttemptEvent } from '../harness.ts';

const skip = await adapter.available() ?? false;
const pi = skip ? null : { ...await import('../adapters/pi/session.ts'), ...await import('../adapters/pi/operations.ts') };
const MODEL = { id: 'fake/coder', contextWindow: 200_000, maxOutput: 32_000, reasoning: true };
const PROMPT = 'Repository acme/app, branch main. The failing step runs node check.js.';
type Body = { model: string; stream: boolean; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };
const text = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: unknown }).text).filter(part => typeof part === 'string').join('') : '';

async function setup(t: TestContext, replies: FakeReply[], { cap = 0.5 } = {}) {
  const source = await mkdtemp(join(tmpdir(), 'bench-pi-'));
  await brokenRepository(source);
  const made = await hostBox(source);
  const upstream = await createFakeUpstream({ script: (_body, index) => replies[index] ?? { text: 'Finished.' } });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 5, upstream: upstream.url });
  t.after(async () => { await made.box.remove(); await gateway.stop(); await upstream.stop(); await rm(source, { recursive: true, force: true }); });
  const opened = await gateway.open({ attempt: 'pi', model: MODEL.id, cap, deadline: Date.now() + 60_000 });
  const events: AttemptEvent[] = [];
  const run = (limits = LIMITS, signal = new AbortController().signal) => adapter.runAttempt({ box: made.box as unknown as BenchBox, system: 'Fix it.', prompt: PROMPT, failing: ['node check.js'],
    model: MODEL, gateway: { baseUrl: gateway.url, token: opened!.token }, limits, signal, scratch: source, log: event => { events.push(event); } });
  const bodies = () => upstream.received.filter(item => item.path === '/api/v1/chat/completions').map(item => item.body as Body);
  return { made, upstream, gateway, token: opened!.token, run, events, bodies };
}

test('pi\'s model is chat completions at the gateway with the bench\'s limits, keeping what pi lists for the id', { skip }, () => {
  const { piModel } = pi!;
  const info = { id: 'vendor/model', contextWindow: 100_000, maxOutput: 8_000, reasoning: true }, base = 'http://127.0.0.1:9/api/v1';
  const built = piModel(info, base);
  assert.deepEqual(built, { id: 'vendor/model', name: 'vendor/model', api: 'openai-completions', provider: 'openrouter', baseUrl: base, reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8_000 });
  const listed = { ...built, name: 'Vendor: Model', baseUrl: 'https://openrouter.ai/api/v1', reasoning: false, contextWindow: 1, maxTokens: 1, thinkingLevelMap: { off: null }, compat: { supportsStrictMode: true } };
  const kept = piModel(info, base, listed);
  assert.deepEqual([kept.name, kept.baseUrl, kept.reasoning, kept.contextWindow, kept.maxTokens, kept.thinkingLevelMap, kept.compat], ['Vendor: Model', base, true, 100_000, 8_000, { off: null }, { supportsStrictMode: true }]);
  const messages = piModel(info, base, { ...listed, api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api' });
  assert.deepEqual([messages.api, messages.baseUrl, messages.compat], ['openai-completions', base, undefined]);
});

test('pi loads nothing but its own system prompt with INSTRUCTIONS appended, and keeps its default tools with done', { skip }, () => {
  const { resourceLoader, SETTINGS, TOOLS } = pi!;
  const loader = resourceLoader('INSTRUCTIONS');
  assert.deepEqual([loader.getSystemPrompt(), loader.getAppendSystemPrompt()], [undefined, ['INSTRUCTIONS']]);
  assert.deepEqual([loader.getExtensions().extensions, loader.getSkills().skills, loader.getPrompts().prompts, loader.getThemes().themes, loader.getAgentsFiles().agentsFiles], [[], [], [], [], []]);
  assert.deepEqual(SETTINGS, { retry: { enabled: true, maxRetries: 2 }, cacheWarming: 'off', enableInstallTelemetry: false });
  assert.deepEqual(TOOLS, ['read', 'bash', 'edit', 'write', 'done']);
  assert.deepEqual([process.env.PI_OFFLINE, process.env.PI_TELEMETRY], ['1', '0']);
});

test('pi\'s operations act in the box: files through sh, commands through bash -c in the named folder with the box\'s environment only', { skip }, async t => {
  const { boxOperations } = pi!;
  const source = await mkdtemp(join(tmpdir(), 'bench-pi-ops-'));
  await brokenRepository(source);
  const made = await hostBox(source);
  t.after(async () => { await made.box.remove(); await rm(source, { recursive: true, force: true }); });
  const runs: [string, number][] = [], changes: string[] = [], seen: string[] = [];
  const ops = boxOperations(made.box, { events: { run(command, exitCode) { runs.push([command, exitCode]); }, change(path) { changes.push(path); } } });
  const folder = join(made.root, 'lib'), file = join(folder, 'new.js');
  await ops.write.mkdir(folder);
  await ops.write.writeFile(file, 'export {};\n');
  assert.equal(await readFile(file, 'utf8'), 'export {};\n');
  assert.equal((await ops.read.readFile(file)).toString('utf8'), 'export {};\n');
  await ops.edit.access(file);
  await assert.rejects(ops.read.access(join(made.root, 'missing.js')), { code: 'ENOENT' });
  await assert.rejects(ops.read.readFile(folder), { code: 'EISDIR' });
  assert.equal(await ops.read.detectImageMimeType?.(file), null);
  assert.deepEqual(changes, [file]);
  const exec = (command: string, cwd = made.root, timeout?: number) => ops.bash.exec(command, cwd, { onData: data => { seen.push(data.toString('utf8')); }, timeout, env: { ...process.env, PI_BENCH_HOST: 'host' } });
  assert.deepEqual(await exec('echo out; echo err >&2; echo "[$PI_BENCH_HOST]"; exit 3'), { exitCode: 3 });
  assert.equal(seen.pop(), 'out\nerr\n[]\n', 'stderr joins stdout, and the host environment pi passes is not the box\'s');
  await exec('pwd', folder);
  assert.equal(seen.pop(), `${folder}\n`);
  await assert.rejects(exec('sleep 5', made.root, 1), /timeout:1/);
  assert.deepEqual(runs.slice(0, 2), [['echo out; echo err >&2; echo "[$PI_BENCH_HOST]"; exit 3', 3], ['pwd', 0]]);
  assert.equal(runs[2]?.[0], 'sleep 5');
  assert.ok(made.calls.every(call => call.argv[0] === 'sh' || call.argv[0] === 'bash'));
});

test('pi reproduces, edits, verifies and calls done in the box through the gateway, with its own prompt, INSTRUCTIONS and the token only at the gateway', { skip }, async t => {
  const f = await setup(t, [
    { calls: [{ name: 'bash', arguments: { command: 'node check.js' } }], cost: 0.01 },
    { calls: [{ name: 'edit', arguments: { path: 'add.js', edits: [{ oldText: 'a - b', newText: 'a + b' }] } }], cost: 0.01 },
    { calls: [{ name: 'bash', arguments: { command: 'node check.js' } }], cost: 0.01 },
    { calls: [{ name: 'done', arguments: { summary: 'add() subtracted; node check.js passes.' } }], cost: 0.01 },
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced, outcome.summary], ['done', 4, true, 'add() subtracted; node check.js passes.']);
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.requests, usage.toolCalls, usage.modelViolations], [4, 4, []]);
  const received = f.upstream.received.filter(item => item.path === '/api/v1/chat/completions');
  assert.ok(received.every(item => item.authorization === `Bearer ${FAKE_KEY}`) && !JSON.stringify(received).includes(f.token), 'The gateway swaps the token for the key.');
  const [first] = f.bodies();
  assert.deepEqual([first.model, first.stream], [MODEL.id, true]);
  assert.deepEqual(first.tools.map(tool => tool.function.name).sort(), ['bash', 'done', 'edit', 'read', 'write']);
  const system = text(first.messages[0].content);
  assert.deepEqual([first.messages[0].role, system.includes('operating inside pi'), system.includes(appendedInstructions('pi', 'Fix it.'))], ['system', true, true]);
  assert.equal(text(first.messages.find(message => message.role === 'user')?.content), PROMPT);
  assert.ok(f.made.calls.every(call => call.argv[0] === 'sh' || call.argv[0] === 'bash'), 'Every tool operation ran through the box.');
  assert.deepEqual(f.events.filter(event => event.type === 'turn').map(event => event.tools), [['bash'], ['edit'], ['bash'], ['done']]);
});

test('done ends the attempt at the end of its turn, even beside another call', { skip }, async t => {
  const f = await setup(t, [{ calls: [{ name: 'bash', arguments: { command: 'node check.js' } }, { name: 'done', arguments: { summary: 'Stopping here.' } }] }, { calls: [{ name: 'bash', arguments: { command: 'true' } }] }]);
  const outcome = await f.run();
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([outcome.reason, outcome.steps, outcome.summary, outcome.reproduced, usage.requests], ['done', 1, 'Stopping here.', true, 1]);
});

test('the step limit ends the attempt at the end of the turn that reaches it', { skip }, async t => {
  const f = await setup(t, Array.from({ length: 5 }, () => ({ calls: [{ name: 'bash', arguments: { command: 'true' } }] })));
  const outcome = await f.run({ ...LIMITS, steps: 2 });
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([outcome.reason, outcome.steps, usage.requests], ['steps', 2, 2]);
});

test('a gateway refusal ends the attempt as a provider error that pi does not retry', { skip }, async t => {
  const f = await setup(t, [{ calls: [{ name: 'bash', arguments: { command: 'true' } }], cost: 0.3 }, { calls: [{ name: 'bash', arguments: { command: 'true' } }], cost: 0.3 }], { cap: 0.2 });
  const outcome = await f.run();
  const usage = await f.gateway.close(f.token);
  assert.equal(outcome.reason, 'provider');
  assert.match(outcome.error ?? '', /402|Bench limit/);
  assert.deepEqual([usage.firstRefusal, usage.log.filter(record => record.status === 402).length, outcome.steps], ['cost', 1, 1]);
});

test('a final answer without done is idle', { skip }, async t => {
  const f = await setup(t, [{ text: 'The build looks fine to me.' }]);
  const outcome = await f.run();
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([outcome.reason, outcome.steps, outcome.summary, usage.requests], ['idle', 1, undefined, 1]);
});

test('a long output shows pi\'s tail, and its log moves into the box at the path pi names', { skip }, async t => {
  const f = await setup(t, [{ calls: [{ name: 'bash', arguments: { command: 'seq 1 3000' } }] }, { calls: [{ name: 'done', arguments: { summary: 'Read it.' } }] }]);
  assert.equal((await f.run()).reason, 'done');
  const result = text(f.bodies()[1].messages.find(message => message.role === 'tool')?.content);
  const path = /Full output: ([^\n\]]+)\]/.exec(result)?.[1] ?? '';
  assert.match(result, /Showing lines 1001-3000 of 3000\. Full output: /);
  assert.ok(path.startsWith(tmpdir()) && !/(^|\n)1000\n/.test(result));
  assert.ok(f.made.calls.some(call => call.argv.at(-1) === path && call.stdin?.startsWith('1\n2\n3\n')), 'The whole output went into the box at that path.');
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('an abort of the attempt\'s signal stops pi and throws its reason', { skip }, async t => {
  const f = await setup(t, [{ hang: true }]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Stopped.')), 300);
  await assert.rejects(f.run(LIMITS, controller.signal), /Stopped\./);
});
