// The OpenAI track's AI SDK arm without Docker or a model: the product's own attempt loop, on @ai-sdk/openai's
// Responses model, drives the product's tools in a host-folder box double (the product's test fixture) from scripted
// replies of a stand-in for the gateway's Responses route, statelessly: store off, the encrypted reasoning of one turn
// sent back on the next, and the product's tools non-strict.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenRepository, hostBox } from '../../../test/fixtures/repair-box.ts';
import { createFakeResponses } from '../adapters/aisdk-openai/fake-responses.ts';
import { adapter, responsesOnly } from '../adapters/aisdk-openai/index.ts';
import type { BenchBox } from '../box.ts';
import type { FakeReply } from '../fake-upstream.ts';
import { ADAPTERS, ADAPTER_KEYS, LIMITS, type ModelInfo } from '../harness.ts';
import { finalReason } from '../run.ts';

const TOKEN = 'bench-attempt-token', LUNA: ModelInfo = { id: 'gpt-6-luna', contextWindow: 400_000, maxOutput: 128_000, reasoning: true };
type Item = Record<string, unknown>;
async function setup(t: TestContext, replies: FakeReply[], model = LUNA) {
  const source = await mkdtemp(join(tmpdir(), 'bench-aisdk-openai-'));
  await brokenRepository(source);
  const made = await hostBox(source);
  const gateway = await createFakeResponses({ script: (_body, index) => replies[index] ?? { text: 'Finished.' }, token: TOKEN });
  t.after(async () => { await made.box.remove(); await gateway.stop(); await rm(source, { recursive: true, force: true }); });
  const run = () => adapter.runAttempt({ box: made.box as unknown as BenchBox, system: 'Fix it.', prompt: 'Repository acme/app. Fix the build.', failing: ['node check.js'], model,
    gateway: { baseUrl: gateway.url, token: TOKEN }, limits: LIMITS, signal: new AbortController().signal, scratch: source, log: () => {} });
  return { made, gateway, run, bodies: () => gateway.received.map(item => item.body as Item) };
}

test('the arm is registered for OpenAI over the Responses API, runs on the host and can run here', async () => {
  assert.ok(ADAPTER_KEYS.includes('aisdk-openai'));
  assert.equal(await ADAPTERS['aisdk-openai'](), adapter);
  assert.deepEqual([adapter.key, adapter.providers, adapter.inBox, adapter.harnessPaths], ['aisdk-openai', { openai: 'responses' }, false, undefined]);
  assert.match(adapter.version, /^ai@7\.\d+\.\d+ \+ @ai-sdk\/openai@4\.0\.77$/);
  assert.equal(await adapter.available(), null);
});

test('the model\'s fetch reaches only POST <gateway>/responses', async () => {
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${input instanceof Request ? input.url : String(input)}`);
    return new Response('{}');
  }) as typeof fetch;
  const routed = responsesOnly('http://127.0.0.1:1234/api/v1/', fetcher);
  await routed('http://127.0.0.1:1234/api/v1/responses', { method: 'POST', body: '{}' });
  await routed(new Request('http://127.0.0.1:1234/api/v1/responses', { method: 'POST', body: '{}' }));
  assert.deepEqual(seen, ['POST http://127.0.0.1:1234/api/v1/responses', 'POST http://127.0.0.1:1234/api/v1/responses']);
  for (const [url, method] of [['http://127.0.0.1:1234/api/v1/chat/completions', 'POST'], ['https://api.openai.com/v1/responses', 'POST'], ['http://127.0.0.1:1234/api/v1/responses/resp_1', 'POST'], ['http://127.0.0.1:1234/api/v1/responses', 'GET']])
    await assert.rejects(routed(url, { method }), /reaches only POST http:\/\/127\.0\.0\.1:1234\/api\/v1\/responses/);
  assert.equal(seen.length, 2);
});

test('the product\'s loop repairs statelessly over the Responses API: store off, encrypted reasoning sent back, the product\'s tools non-strict', async t => {
  const f = await setup(t, [
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }] },
    { calls: [{ name: 'edit', arguments: { path: 'add.js', old: 'a - b', new: 'a + b' } }] },
    { calls: [{ name: 'run', arguments: { command: 'node check.js' } }] },
    { calls: [{ name: 'done', arguments: { summary: 'add() subtracted; node check.js passes.' } }] },
  ]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced, outcome.summary, outcome.frameworkCost], ['done', 4, true, 'add() subtracted; node check.js passes.', undefined]);
  assert.equal(await readFile(join(f.made.root, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  assert.deepEqual(f.gateway.received.map(item => [item.path, item.authorization]), Array.from({ length: 4 }, () => ['/api/v1/responses', `Bearer ${TOKEN}`]), 'Only the attempt token, only the Responses route.');
  const [first, second] = f.bodies();
  assert.deepEqual([first.model, first.store, first.include, 'previous_response_id' in first, first.stream], ['gpt-6-luna', false, ['reasoning.encrypted_content'], false, undefined]);
  assert.deepEqual((first.input as Item[]).slice(0, 2), [{ role: 'developer', content: 'Fix it.' }, { role: 'user', content: [{ type: 'input_text', text: 'Repository acme/app. Fix the build.' }] }]);
  const tools = first.tools as { type: string; name: string; strict?: boolean; parameters: { required?: string[] } }[];
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['done', 'edit', 'grep', 'list', 'read', 'run', 'write']);
  assert.ok(tools.every(tool => tool.type === 'function' && tool.strict === false), 'Every product tool goes out non-strict.');
  assert.deepEqual(tools.find(tool => tool.name === 'list')?.parameters.required, [], 'The product\'s optional parameters stay optional.');
  // The second turn resends the first: its reasoning with the encrypted content, its call, and the call's output.
  const answered = f.gateway.sent[0].output, input = second.input as Item[];
  const reasoning = answered.find(item => item.type === 'reasoning') as Item, call = answered.find(item => item.type === 'function_call') as Item;
  assert.deepEqual(input.find(item => item.type === 'reasoning'), { type: 'reasoning', id: reasoning.id, encrypted_content: reasoning.encrypted_content, summary: [] });
  const resent = input.find(item => item.type === 'function_call'), output = input.find(item => item.type === 'function_call_output');
  assert.deepEqual([resent?.call_id, resent?.name, resent?.arguments, output?.call_id], [call.call_id, 'run', '{"command":"node check.js"}', call.call_id]);
  assert.match(String(output?.output), /"exitCode":1/);
  assert.ok(f.bodies().every(body => body.store === false && !('previous_response_id' in body)));
});

test('a model the provider does not know reasons keeps store off without asking for encrypted reasoning', async t => {
  const f = await setup(t, [{ calls: [{ name: 'done', arguments: { summary: 'Nothing to fix.' } }] }], { ...LUNA, id: 'gpt-4.1', reasoning: false });
  const outcome = await f.run();
  const [body] = f.bodies();
  assert.deepEqual([outcome.reason, body.model, body.store, body.include, (body.input as Item[])[0].role], ['done', 'gpt-4.1', false, undefined, 'system']);
});

test('a gateway refusal ends the attempt as a provider error without a retry, and the runner reports the gateway\'s reason', async t => {
  const f = await setup(t, [{ calls: [{ name: 'run', arguments: { command: 'true' } }] }, { status: 402, error: 'Bench limit: the attempt reached its cost cap.' }]);
  const outcome = await f.run();
  assert.deepEqual([outcome.reason, outcome.steps, f.gateway.received.length], ['provider', 1, 2]);
  assert.match(outcome.error ?? '', /402.*Bench limit: the attempt reached its cost cap/);
  assert.equal(finalReason('cost', false, outcome.reason), 'cost');
});
