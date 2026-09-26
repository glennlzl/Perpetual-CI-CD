// The OpenAI track's Agents SDK adapter without Docker or a model: the SDK's own loop, on its Responses model over an
// OpenAI client pointed at a fake Responses endpoint (in the gateway's place) with the attempt's token, drives the
// product's tools in a host-folder box double (the product's test fixture) from scripted replies. The tests that load
// the SDK are skipped until npm ci has run in bench/repair.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairTools } from '../../../src/repair/tools.ts';
import { brokenRepository, hostBox } from '../../../test/fixtures/repair-box.ts';
import { createFakeResponses, type ResponsesReply } from '../adapters/agents-openai/fake-responses.ts';
import { adapter, gatewayOnly, load, readiness } from '../adapters/agents-openai/index.ts';
import type { BenchBox } from '../box.ts';
import { LIMITS, type AttemptEvent, type AttemptLimits, type ModelInfo } from '../harness.ts';

const MODEL: ModelInfo = { id: 'gpt-6-luna', contextWindow: 400_000, maxOutput: 128_000, reasoning: true };
const TOKEN = 'bench-attempt-token', SYSTEM = 'Fix the build, then call done.', PROMPT = 'Repository acme/app. node check.js fails.';
const skip = await adapter.available() ?? false;
type Item = Record<string, unknown>;
type Body = Item & { input: Item[]; tools: Item[] };

async function setup(t: TestContext, replies: ResponsesReply[], { model = MODEL, limits = LIMITS }: { model?: ModelInfo; limits?: AttemptLimits } = {}) {
  const source = await mkdtemp(join(tmpdir(), 'bench-agents-openai-'));
  await brokenRepository(source);
  const made = await hostBox(source);
  const fake = await createFakeResponses({ token: TOKEN, script: (_body, index) => replies[index] ?? { text: 'Finished.' } });
  t.after(async () => { await made.box.remove(); await fake.stop(); await rm(source, { recursive: true, force: true }); });
  const events: AttemptEvent[] = [];
  const run = (signal = new AbortController().signal) => adapter.runAttempt({ box: made.box as unknown as BenchBox, system: SYSTEM, prompt: PROMPT, failing: ['node check.js'], model,
    gateway: { baseUrl: fake.url, token: TOKEN }, limits, signal, scratch: source, log: event => { events.push(event); } });
  return { made, fake, run, events, bodies: () => fake.received.map(request => request.body as Body) };
}
/** A product tool's JSON schema, read as unknown: the product's ai and the bench's copy type schemas against different zod versions. */
const schemaOf = async (inputSchema: unknown): Promise<unknown> => typeof inputSchema === 'object' && inputSchema !== null && 'jsonSchema' in inputSchema ? await inputSchema.jsonSchema : undefined;
const outputOf = (body: Body) => body.input.filter(item => item.type === 'function_call_output').map(item => String(item.output));

test('the client\'s fetch reaches only the gateway\'s base URL, without headers the environment adds', async () => {
  const seen: Request[] = [];
  const fetcher = (async (input: string | URL | Request) => { seen.push(input as Request); return new Response('{}'); }) as typeof fetch;
  const routed = gatewayOnly('http://127.0.0.1:1234/api/v1/', fetcher);
  await routed('http://127.0.0.1:1234/api/v1/responses', { method: 'POST', body: '{}', headers: { authorization: 'Bearer t', 'content-type': 'application/json', 'x-stainless-lang': 'js', 'openai-organization': 'org-host', 'x-host-secret': '1' } });
  assert.equal(seen[0].url, 'http://127.0.0.1:1234/api/v1/responses');
  assert.deepEqual([...seen[0].headers.keys()].sort(), ['authorization', 'content-type', 'x-stainless-lang']);
  await assert.rejects(routed('https://api.openai.com/v1/responses', { method: 'POST' }), /only the gateway, not https:\/\/api\.openai\.com\./);
  await assert.rejects(routed('http://127.0.0.1:1234/api/v10/responses'), /only the gateway/);
  assert.equal(seen.length, 1);
});

test('the adapter declares the OpenAI track and is available only with the pinned packages installed', () => {
  assert.deepEqual([adapter.key, adapter.inBox, adapter.providers], ['agents-openai', false, { openai: 'responses' }]);
  assert.match(adapter.version, /^@openai\/agents@.+ \+ openai@.+$/);
  assert.equal(readiness([{ name: '@openai/agents', pinned: '0.18.0', installed: '0.18.0' }, { name: 'openai', pinned: '7.23.0', installed: '7.23.0' }]), null);
  assert.equal(readiness([{ name: '@openai/agents', pinned: '0.18.0', installed: '' }, { name: 'openai', pinned: '7.23.0', installed: '7.22.0' }]),
    'Run npm ci in bench/repair (@openai/agents is not installed; openai 7.22.0 is installed, 7.23.0 pinned).');
});

test('the SDK loop reproduces, edits, verifies and ends at done on the Responses API, keeping nothing at OpenAI', { skip }, async t => {
  const f = await setup(t, [
    { reasoning: true, calls: [{ name: 'run', arguments: { command: 'node check.js' } }] },
    { reasoning: true, calls: [{ name: 'edit', arguments: { path: 'add.js', old: 'a - b', new: 'a + b' } }] },
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }] },
    { calls: [{ name: 'done', arguments: { summary: 'add() subtracted; node check.js passes.' } }] },
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced, outcome.summary], ['done', 4, true, 'add() subtracted; node check.js passes.']);
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  assert.ok(f.fake.received.every(request => request.path === '/v1/responses' && request.authorization === `Bearer ${TOKEN}`), 'Every request reached the gateway with the attempt\'s token.');
  const bodies = f.bodies(), [first, second] = bodies;
  assert.equal(bodies.length, 4, 'done ends the run without another request.');
  assert.deepEqual([first.model, first.instructions, first.store, first.stream, first.include], [MODEL.id, SYSTEM, false, false, ['reasoning.encrypted_content']]);
  assert.deepEqual(first.input.map(item => [item.role, item.content]), [['user', PROMPT]]);
  assert.ok(bodies.every(body => body.store === false && !('previous_response_id' in body) && !('reasoning' in body)), 'No state at OpenAI, and reasoning left to the gateway\'s policy.');
  const tools = repairTools(f.made.box);
  assert.deepEqual(first.tools.map(tool => tool.name), Object.keys(tools));
  for (const tool of first.tools) {
    const product = tools[tool.name as keyof typeof tools];
    assert.deepEqual([tool.type, tool.strict, tool.description, tool.parameters], ['function', false, product.description, await schemaOf(product.inputSchema)]);
  }
  // Statelessly, the first turn's reasoning goes back as its encrypted content, beside the call and the tool's JSON result.
  assert.match(String(second.input.find(item => item.type === 'reasoning')?.encrypted_content), /^enc_[\da-f]{16}$/);
  const [result] = outputOf(second).map(text => JSON.parse(text) as Item);
  assert.deepEqual([result.ok, result.exitCode], [true, 1]);
  assert.deepEqual(f.events.map(event => [event.type, event.end, event.steps, event.inputTokens, event.reproduced]), [['attempt', 'done', 4, 4000, true]]);
});

test('the client sends only the token, nothing from the environment; a model without reasoning asks for none; nothing is traced', { skip }, async t => {
  const names = ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_BASE_URL', 'OPENAI_CUSTOM_HEADERS', 'OPENAI_AGENTS_DISABLE_TRACING'];
  const saved = new Map(names.map(name => [name, process.env[name]])), original = globalThis.fetch, reached: string[] = [];
  Object.assign(process.env, { OPENAI_API_KEY: 'sk-host-0000', OPENAI_ORG_ID: 'org-host', OPENAI_PROJECT_ID: 'proj-host', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_CUSTOM_HEADERS: 'x-host-secret: 1', OPENAI_AGENTS_DISABLE_TRACING: '0' });
  // Whatever tries to leave 127.0.0.1, such as a trace export, is recorded and answered here.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    reached.push(url);
    return url.startsWith('http://127.0.0.1:') ? original(input, init) : new Response('{}', { status: 418 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const f = await setup(t, [{ calls: [{ name: 'done', arguments: { summary: 'Nothing to change.' } }] }], { model: { ...MODEL, reasoning: false } });
  const outcome = await f.run();
  const [sdk] = await load();
  await sdk.getGlobalTraceProvider().forceFlush();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.summary], ['done', 1, 'Nothing to change.']);
  assert.ok(reached.length === 1 && reached.every(url => url === `${f.fake.url}/responses`), `Only the gateway was reached: ${reached.join(', ')}`);
  const [request] = f.fake.received;
  assert.equal(request.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(Object.keys(request.headers).filter(name => /organization|project|host-secret/i.test(name)), []);
  assert.deepEqual((request.body as Body).include, []);
});

test('the SDK\'s turn limit ends the attempt at steps, a final message without done is idle, and an unknown tool answers the model', { skip }, async t => {
  const busy = await setup(t, Array.from({ length: 5 }, () => ({ calls: [{ name: 'run', arguments: { command: 'true' } }] })), { limits: { ...LIMITS, steps: 2 } });
  const stepped = await busy.run();
  assert.deepEqual([stepped.reason, stepped.steps, busy.fake.received.length], ['steps', 2, 2]);
  const quiet = await setup(t, [{ text: 'It should work now.' }]);
  const idle = await quiet.run();
  assert.deepEqual([idle.reason, idle.steps, idle.summary], ['idle', 1, '']);
  const astray = await setup(t, [{ calls: [{ name: 'bash', arguments: { command: 'node check.js' } }] }, { calls: [{ name: 'done', arguments: { summary: 'Gave up.' } }] }]);
  const recovered = await astray.run();
  assert.deepEqual([recovered.reason, recovered.steps, recovered.reproduced], ['done', 2, false]);
  assert.deepEqual(outputOf(astray.bodies()[1]), ['Tool \'bash\' not found.']);
});

test('a gateway refusal ends the attempt as provider, an overflow as context, the time limit as time, and an abort throws', { skip }, async t => {
  const refused = await setup(t, [{ status: 402, error: { message: 'Bench limit: the attempt reached its cost cap.', type: 'bench_limit', code: 402 } }]);
  const cut = await refused.run();
  assert.equal(cut.reason, 'provider');
  assert.match(cut.error ?? '', /402 Bench limit: the attempt reached its cost cap\./);
  assert.equal(refused.fake.received.length, 1, 'A 402 is never retried.');
  const full = await setup(t, [{ status: 400, error: { message: 'Your input exceeds the context window of this model. Please adjust your input and try again.', code: 'context_length_exceeded' } }]);
  assert.equal((await full.run()).reason, 'context');
  const slow = await setup(t, [{ hang: true }], { limits: { ...LIMITS, timeMs: 300 } });
  assert.equal((await slow.run()).reason, 'time');
  const stuck = await setup(t, [{ hang: true }]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Stopped.')), 300).unref();
  await assert.rejects(stuck.run(controller.signal), /Stopped\./);
});
