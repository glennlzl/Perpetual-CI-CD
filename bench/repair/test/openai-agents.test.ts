// The OpenAI Agents SDK adapter without Docker or a model: the product's tools as function tools (names, descriptions
// and JSON schemas unchanged, not strict), the agent and runner it builds (INSTRUCTIONS verbatim, done ends the run,
// tracing off, no named model), and its runs through the gateway, via the product's OpenRouter factory, in a
// host-folder box double (the product's test fixture) from scripted fake-upstream replies: the model is offered exactly
// the baseline's request, and a run ends at done, at its turn limit, idle, at its time limit, at a gateway refusal or
// when its conversation outgrew the context window.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoopTrace, RunContext, withTrace } from '@openai/agents';
import { AiSdkModel } from '@openai/agents-extensions/ai-sdk';
import { INSTRUCTIONS } from '../../../src/repair/context.ts';
import { repairTools } from '../../../src/repair/tools.ts';
import { brokenRepository, hostBox } from '../../../test/fixtures/repair-box.ts';
import { adapter as baseline } from '../adapters/aisdk/index.ts';
import { NO_NAMED_MODELS, adapter, repairAgent } from '../adapters/openai-agents/index.ts';
import { FINISHED, agentTools } from '../adapters/openai-agents/tools.ts';
import type { BenchBox } from '../box.ts';
import { FAKE_KEY, createFakeUpstream, type FakeReply } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { LIMITS, type Adapter, type AttemptLimits } from '../harness.ts';
import { finalReason } from '../run.ts';

const MODEL = { id: 'fake/coder', contextWindow: 200_000, maxOutput: 32_000, reasoning: true };
const PROMPT = 'Repository acme/app. Fix the build: node check.js fails.';
type Body = { model: string; messages: { role: string; content: unknown; tool_call_id?: string }[]; tools?: unknown[] };

async function folder(t: TestContext) {
  const source = await mkdtemp(join(tmpdir(), 'bench-openai-agents-'));
  await brokenRepository(source);
  const made = await hostBox(source);
  t.after(async () => { await made.box.remove(); await rm(source, { recursive: true, force: true }); });
  return { source, made };
}

async function setup(t: TestContext, replies: FakeReply[], { cap = 0.5, framework = adapter }: { cap?: number; framework?: Adapter } = {}) {
  const { source, made } = await folder(t);
  const upstream = await createFakeUpstream({ script: (_body, index) => replies[index] ?? { text: 'Finished.' } });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 5, upstream: upstream.url });
  t.after(async () => { await gateway.stop(); await upstream.stop(); });
  const opened = await gateway.open({ attempt: framework.key, model: MODEL.id, cap, deadline: Date.now() + 60_000 });
  const run = (limits: AttemptLimits = LIMITS, signal = new AbortController().signal) => framework.runAttempt({ box: made.box as unknown as BenchBox, system: INSTRUCTIONS, prompt: PROMPT,
    failing: ['node check.js'], model: MODEL, gateway: { baseUrl: gateway.url, token: opened!.token }, limits, signal, scratch: source, log: () => {} });
  const bodies = () => upstream.received.filter(item => item.path === '/api/v1/chat/completions').map(item => item.body as Body);
  return { made, upstream, gateway, token: opened!.token, run, bodies };
}

test('the product\'s tools keep their names, descriptions and JSON schemas, not strict, and run the product\'s tool in the box', async t => {
  const { made } = await folder(t);
  const product = repairTools(made.box), tools = await agentTools(product), entries: [string, unknown][] = Object.entries(product);
  assert.deepEqual(tools.map(tool => tool.name), ['list', 'read', 'grep', 'edit', 'write', 'run', 'done']);
  for (const [index, [name, value]] of entries.entries()) {
    const source = value as { description: string; inputSchema: { jsonSchema: unknown } };
    assert.deepEqual([tools[index].name, tools[index].description, tools[index].strict], [name, source.description, false]);
    assert.deepEqual(tools[index].parameters, await source.inputSchema.jsonSchema);
  }
  const named = (name: string) => tools.find(tool => tool.name === name)!;
  assert.deepEqual(JSON.parse(String(await named('read').invoke(new RunContext(), JSON.stringify({ path: '../outside.txt' })))), { ok: false, error: '../outside.txt is outside /workspace.' });
  const listed = JSON.parse(String(await named('list').invoke(new RunContext(), '{}'))) as { ok: boolean; entries: string[] };
  assert.ok(listed.ok && listed.entries.includes('add.js') && !listed.entries.includes('.git/'));
  assert.equal(await named('done').invoke(new RunContext(), JSON.stringify({ summary: 'Fixed.' })), FINISHED);
});

test('the agent has INSTRUCTIONS verbatim, the product\'s model and tools and stops at done; its runner traces nothing and resolves no named model', async t => {
  const { made } = await folder(t);
  const { agent, runner } = repairAgent({ system: INSTRUCTIONS, model: MODEL, gateway: { baseUrl: 'http://127.0.0.1:9/api/v1', token: 'bench-token' }, tools: await agentTools(repairTools(made.box)) });
  assert.equal(agent.instructions, INSTRUCTIONS);
  assert.ok(agent.model instanceof AiSdkModel);
  assert.deepEqual(agent.toolUseBehavior, { stopAtToolNames: ['done'] });
  assert.deepEqual(agent.tools.map(tool => tool.name), ['list', 'read', 'grep', 'edit', 'write', 'run', 'done']);
  assert.deepEqual([runner.config.tracingDisabled, runner.config.toolNotFoundBehavior, runner.config.modelProvider === NO_NAMED_MODELS], [true, 'return_error_to_model', true]);
  await assert.rejects(async () => NO_NAMED_MODELS.getModel('gpt-5.6-luna'), /not resolved/);
  assert.ok(await withTrace('bench', async trace => trace) instanceof NoopTrace, 'Loading the adapter turns tracing off.');
});

test('the model is offered exactly the baseline\'s first request: its model, the system text, the prompt and the tools', async t => {
  const ours = await setup(t, [{ text: 'Nothing to change.' }]), theirs = await setup(t, [{ text: 'Nothing to change.' }], { framework: baseline });
  assert.equal((await ours.run()).reason, 'idle');
  assert.equal((await theirs.run()).reason, 'idle');
  const [mine] = ours.bodies(), [base] = theirs.bodies();
  assert.equal(mine.model, MODEL.id);
  assert.deepEqual(mine.messages.map(message => message.role), ['system', 'user']);
  assert.equal(mine.messages[1].content, PROMPT);
  assert.deepEqual(mine.messages, base.messages);
  assert.deepEqual(mine.tools, base.tools);
});

test('a run reproduces, edits, verifies and ends at done through the gateway, which counts every step', async t => {
  const f = await setup(t, [
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }], cost: 0.01 },
    { calls: [{ name: 'edit', arguments: { path: 'add.js', old: 'a - b', new: 'a + b' } }], cost: 0.01 },
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }], cost: 0.01 },
    { calls: [{ name: 'done', arguments: { summary: 'add() subtracted; node check.js passes.' } }], cost: 0.01 },
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced, outcome.summary], ['done', 4, true, 'add() subtracted; node check.js passes.']);
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.requests, usage.toolCalls, usage.modelViolations], [4, 4, []]);
  assert.ok(f.upstream.received.filter(item => item.path === '/api/v1/chat/completions').every(item => item.authorization === `Bearer ${FAKE_KEY}`), 'The gateway swapped the token for the key.');
  const answer = f.bodies()[1].messages.find(message => message.role === 'tool');
  assert.equal((JSON.parse(String(answer?.content)) as { exitCode: number }).exitCode, 1, 'The failing check\'s result went back as the product\'s JSON.');
});

test('the SDK\'s turn limit ends a run at limits.steps', async t => {
  const f = await setup(t, Array.from({ length: 5 }, () => ({ calls: [{ name: 'run', arguments: { command: 'true' } }], cost: 0.01 })));
  const outcome = await f.run({ ...LIMITS, steps: 2 });
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced], ['steps', 2, false]);
  assert.equal((await f.gateway.close(f.token)).requests, 2);
});

test('a refusal and an unknown tool go back to the model as tool results, and a reply without a tool call ends the run idle', async t => {
  const f = await setup(t, [
    { calls: [{ name: 'read', arguments: { path: '../outside.txt' } }] },
    { calls: [{ name: 'bash', arguments: { command: 'ls' } }] },
    { text: 'I cannot fix this build.' },
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.summary], ['idle', 3, undefined]);
  const answers = f.bodies()[2].messages.filter(message => message.role === 'tool');
  assert.equal(answers.length, 2);
  assert.deepEqual(JSON.parse(String(answers[0].content)), { ok: false, error: '../outside.txt is outside /workspace.' });
  assert.match(String(answers[1].content), /bash/);
});

test('a gateway refusal ends the run as a provider error, and the refusal outranks it as the final reason', async t => {
  const call = { calls: [{ name: 'run', arguments: { command: 'true' } }], cost: 0.3 };
  const f = await setup(t, [call, call], { cap: 0.2 });
  const outcome = await f.run();
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([outcome.reason, outcome.steps], ['provider', 1]);
  assert.match(outcome.error ?? '', /402/);
  assert.deepEqual([usage.firstRefusal, finalReason(usage.firstRefusal, false, outcome.reason)], ['cost', 'cost']);
});

test('a conversation that outgrew the context window ends the run as context', async t => {
  const f = await setup(t, [{ status: 400, error: 'This endpoint\'s maximum context length is 200000 tokens.' }]);
  const outcome = await f.run();
  assert.equal(outcome.reason, 'context');
  assert.match(outcome.error ?? '', /maximum context length/);
});

test('the time limit ends a run as time, and a stopped runner rejects', async t => {
  const slow = await setup(t, [{ hang: true }]);
  assert.deepEqual(await slow.run({ ...LIMITS, timeMs: 300 }).then(outcome => [outcome.reason, outcome.steps]), ['time', 0]);
  const stopped = await setup(t, [{ hang: true }]), stop = new AbortController();
  setTimeout(() => stop.abort(new Error('Stopped.')), 300);
  await assert.rejects(stopped.run(LIMITS, stop.signal), /Stopped\./);
});
