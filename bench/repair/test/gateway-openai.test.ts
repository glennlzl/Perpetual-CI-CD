// The gateway's OpenAI track against the fake OpenAI, without network or a model: both wire APIs reach OpenAI's paths
// with the real key while an OpenRouter gateway serves chat completions only; the store rule, streamed chat usage, the
// Standard tier and the reasoning policy; another model, hosted tools and an unpriced model refused before anything is
// forwarded; the dollars computed from usage and the price table for JSON and SSE on both wires, a serving tier's
// factor and no cost recovery; the caps on computed dollars; the key file's provider checks; and the IPC child.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_OPENAI_KEY, createFakeOpenAI } from '../fake-openai.ts';
import { FAKE_KEY, type FakeScript } from '../fake-upstream.ts';
import { createGateway, forkGateway, readKeyFile, rewriteOpenAI, type GatewayOptions } from '../gateway.ts';
import { parsePrices } from '../prices.ts';

const MODEL = 'fake-gpt';
// Round rates: every fake reply (1000 input tokens, 200 of them cached reads and 100 cache writes, then 50 output
// tokens) costs 700 × $1 + 200 × $0.10 + 100 × $1.25 + 50 × $10 per million tokens.
const PRICES = parsePrices({ source: 'https://example.com/pricing', checked: '2026-09-25', tiers: { priority: 2 }, models: {
  [MODEL]: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 10, contextWindow: 200_000, maxOutput: 32_000, reasoning: true },
} });
const COST = (700 + 20 + 125 + 500) / 1e6;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
type Body = Record<string, unknown>;

async function setup(t: TestContext, script: FakeScript = () => ({ text: 'ok' }), options: Partial<GatewayOptions> = {}) {
  const upstream = await createFakeOpenAI({ script });
  const gateway = await createGateway({ key: FAKE_OPENAI_KEY, budget: 10, provider: 'openai', prices: PRICES, upstream: upstream.url, closeWaitMs: 2_000, ...options });
  t.after(async () => { await gateway.stop(); await upstream.stop(); });
  const opened = await gateway.open({ attempt: 'o1', model: MODEL, cap: 0.5, deadline: Date.now() + 60_000 });
  assert.ok(opened);
  const post = (path: string, body: Body, token = opened.token) => fetch(`${gateway.url}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, ...body }),
  });
  const chat = (body: Body = {}, token?: string) => post('/chat/completions', { messages: [{ role: 'user', content: 'hi' }], ...body }, token);
  const responses = (body: Body = {}, token?: string) => post('/responses', { input: 'hi', ...body }, token);
  /** The body the fake OpenAI received last, as the gateway forwarded it. */
  const sent = () => upstream.received.at(-1)?.body as Body;
  return { upstream, gateway, token: opened.token, chat, responses, sent };
}

test('both wire APIs reach OpenAI\'s paths with the real key, the token never leaves, and an OpenRouter run serves no /responses', async t => {
  const f = await setup(t);
  assert.equal((await f.chat()).status, 200);
  assert.equal((await f.responses()).status, 200);
  assert.deepEqual(f.upstream.received.map(item => [item.path, item.authorization]), [['/v1/chat/completions', `Bearer ${FAKE_OPENAI_KEY}`], ['/v1/responses', `Bearer ${FAKE_OPENAI_KEY}`]]);
  assert.ok(!JSON.stringify(f.upstream.received).includes(f.token), 'The attempt token never reaches OpenAI.');
  assert.equal((await fetch(`${f.gateway.url}/models`)).status, 404);
  assert.deepEqual((await f.gateway.close(f.token)).log.map(entry => entry.wire), ['chat', 'responses']);
  const fake = await createFakeOpenAI({ script: () => ({ text: 'ok' }) });
  const openrouter = await createGateway({ key: FAKE_KEY, budget: 1, upstream: fake.url });
  t.after(async () => { await openrouter.stop(); await fake.stop(); });
  const opened = await openrouter.open({ attempt: 'r', model: MODEL, cap: 0.1, deadline: Date.now() + 60_000 });
  const refused = await fetch(`${openrouter.url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${opened!.token}` }, body: JSON.stringify({ model: MODEL, input: 'hi' }) });
  assert.equal(refused.status, 404);
  assert.match(await refused.text(), /only POST \/api\/v1\/chat\/completions is served/);
  assert.equal(fake.received.length, 0);
});

test('a Responses request is not stored unless it chains with previous_response_id, and its reasoning stays replayable', async t => {
  const f = await setup(t);
  const items = [{ role: 'user', content: 'hi' }, { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAB00' }];
  assert.equal((await f.responses({ store: true, include: ['message.output_text.logprobs'], reasoning: { effort: 'high', summary: 'auto' }, input: items, max_output_tokens: 99 })).status, 200);
  assert.deepEqual(f.sent(), { model: MODEL, input: items, max_output_tokens: 99, store: false, include: ['message.output_text.logprobs', 'reasoning.encrypted_content'], reasoning: { summary: 'auto' }, service_tier: 'default' },
    'Only store, include, the effort (left to the model) and the tier change; the input items pass untouched.');
  // A chaining request keeps store and include as sent. Under this rule no chain can start: its first request names no
  // previous response, so it is not stored, and OpenAI finds no previous response for the second.
  const first = await (await f.responses()).json() as { id: string };
  const chained = await f.responses({ previous_response_id: first.id, input: [{ role: 'user', content: 'next' }] });
  assert.deepEqual(f.sent(), { model: MODEL, previous_response_id: first.id, input: [{ role: 'user', content: 'next' }], service_tier: 'default' });
  assert.equal(chained.status, 400);
  assert.match(await chained.text(), /Previous response with id '\w+' not found/);
  await (await f.responses({ previous_response_id: 'resp_elsewhere', store: true, include: [] })).text();
  assert.deepEqual([f.sent().store, f.sent().include], [true, []]);
});

test('a chat request keeps its body but for the Standard tier, and a streamed one asks for its usage', async t => {
  const f = await setup(t);
  await (await f.chat({ store: true, reasoning_effort: 'none', temperature: 0.2, max_completion_tokens: 99 })).text();
  assert.deepEqual(f.sent(), { model: MODEL, messages: [{ role: 'user', content: 'hi' }], store: true, reasoning_effort: 'none', temperature: 0.2, max_completion_tokens: 99, service_tier: 'default' });
  await (await f.chat({ stream: true, stream_options: { include_obfuscation: false } })).text();
  assert.deepEqual(f.sent().stream_options, { include_obfuscation: false, include_usage: true });
  // The reasoning policy removes or sets a Responses request's effort; a chat request keeps its reasoning_effort.
  assert.deepEqual(rewriteOpenAI({ reasoning: { summary: 'auto' } }, 'responses', { reasoning: 'low' }).reasoning, { summary: 'auto', effort: 'low' });
  assert.deepEqual(rewriteOpenAI({ reasoning: { effort: 'max' } }, 'responses', { reasoning: 'native' }).reasoning, { effort: 'max' });
  assert.equal('reasoning' in rewriteOpenAI({ reasoning: { effort: 'max' } }, 'responses'), false);
  assert.equal(rewriteOpenAI({ reasoning_effort: 'none' }, 'chat', { reasoning: 'high' }).reasoning_effort, 'none');
  assert.equal('include' in rewriteOpenAI({}, 'responses'), false, 'A model without reasoning is not asked for encrypted reasoning.');
  assert.deepEqual(rewriteOpenAI({ include: ['reasoning.encrypted_content'] }, 'responses', { reasoningModel: true }).include, ['reasoning.encrypted_content']);
});

test('another model, hosted tools and an unpriced model are refused before anything is forwarded', async t => {
  const f = await setup(t);
  assert.equal((await f.chat({ model: 'gpt-other' })).status, 400);
  const hosted = await f.responses({ tools: [{ type: 'function', name: 'run', parameters: {} }, { type: 'web_search' }, { type: 'mcp', server_label: 'x' }] });
  assert.equal(hosted.status, 400);
  assert.match(await hosted.text(), /not web_search, mcp\./);
  assert.equal((await f.chat({ web_search_options: {} })).status, 400);
  assert.equal(f.upstream.received.length, 0);
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.modelViolations, usage.requests, usage.log.map(entry => entry.status)], [['gpt-other'], 0, [400, 400, 400]]);
  await assert.rejects(f.gateway.open({ attempt: 'u', model: 'gpt-unpriced', cap: 0.1, deadline: Date.now() + 60_000 }), /No price for gpt-unpriced/);
});

test('dollars come from the usage and the price table, for JSON and SSE on both wires, with tool calls, finish and tier', async t => {
  const f = await setup(t, () => ({ calls: [{ name: 'run', arguments: { command: 'npm test' } }, { name: 'read', arguments: { path: 'src/a.js' } }] }));
  const json = await (await f.chat()).json() as { usage: Body };
  assert.equal('cost' in json.usage, false, 'OpenAI reports no dollars.');
  await (await f.chat({ stream: true })).text();
  await (await f.responses()).text();
  assert.match(await (await f.responses({ stream: true })).text(), /^event: response\.completed$/m);
  const usage = await f.gateway.close(f.token);
  assert.equal(usage.requests, 4);
  close(usage.cost, 4 * COST);
  assert.deepEqual([usage.costSources, usage.tokens], [{ usage: 4, generation: 0, unknown: 0 }, { prompt: 4000, completion: 200, reasoning: 40, cached: 800, cacheWrite: 400 }]);
  assert.equal(usage.toolCalls, 8, 'Each call counts once, however many deltas or events name it.');
  assert.deepEqual(usage.log.map(entry => [entry.wire, entry.stream, entry.toolCalls, entry.finish, entry.tier, entry.costSource]), [
    ['chat', false, 2, 'tool_calls', 'default', 'usage'], ['chat', true, 2, 'tool_calls', 'default', 'usage'],
    ['responses', false, 2, 'completed', 'default', 'usage'], ['responses', true, 2, 'completed', 'default', 'usage'],
  ]);
});

test('a response served at another tier is priced at its factor, and one without usage stays unknown, with no recovery lookup', async t => {
  const replies: Body[] = [
    { id: 'chatcmpl-1', object: 'chat.completion', service_tier: 'priority', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } } },
    { id: 'resp_2', object: 'response', status: 'completed', output: [], usage: null },
  ];
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(replies.shift() ?? {}), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const f = await setup(t, undefined, { fetch: fetcher, upstream: 'http://127.0.0.1:9/v1' });
  await (await f.chat()).text();
  await (await f.responses()).text();
  const usage = await f.gateway.close(f.token);
  close(usage.log[0].cost, 2 * COST);
  assert.deepEqual([usage.log[0].tier, usage.log.map(entry => entry.costSource)], ['priority', ['usage', 'unknown']]);
  assert.deepEqual(urls, ['http://127.0.0.1:9/v1/chat/completions', 'http://127.0.0.1:9/v1/responses'], 'Nothing asks OpenAI for a generation record.');
});

test('computed dollars trip an attempt\'s cap and the run\'s budget as reported ones do', async t => {
  const f = await setup(t);
  // $0.001345 a request: a $0.002 cap lets two through, the second crossing it.
  const small = await f.gateway.open({ attempt: 'c', model: MODEL, cap: 0.002, deadline: Date.now() + 60_000 });
  assert.equal((await f.chat({}, small!.token)).status, 200);
  assert.equal((await f.responses({}, small!.token)).status, 200);
  const capped = await f.chat({}, small!.token);
  assert.deepEqual([capped.status, capped.headers.get('x-bench-refusal')], [402, 'cost']);
  const usage = await f.gateway.close(small!.token);
  assert.deepEqual([usage.requests, usage.firstRefusal], [2, 'cost']);
  close(usage.cost, 2 * COST);
  // A budget the first attempt's reserved cap already fills admits no other attempt.
  const tight = await setup(t, undefined, { budget: 0.5 });
  assert.equal(await tight.gateway.open({ attempt: 'd', model: MODEL, cap: 0.01, deadline: Date.now() + 60_000 }), null);
});

test('a key file for the OpenAI track holds an OpenAI key for OpenAI\'s API, and neither track takes the other\'s key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name: string, value: unknown) => { const path = join(dir, name); await writeFile(path, JSON.stringify(value)); return path; };
  assert.deepEqual(await readKeyFile(await file('openai.json', { apiKey: FAKE_OPENAI_KEY, model: 'gpt-6-luna' }), 'openai'), { apiKey: FAKE_OPENAI_KEY, models: ['gpt-6-luna'] });
  assert.equal((await readKeyFile(await file('base.json', { apiKey: FAKE_OPENAI_KEY, baseUrl: 'https://api.openai.com/v1' }), 'openai')).apiKey, FAKE_OPENAI_KEY);
  await assert.rejects(readKeyFile(await file('router-url.json', { apiKey: FAKE_OPENAI_KEY, baseUrl: 'https://openrouter.ai/api/v1' }), 'openai'), /not for OpenAI/);
  await assert.rejects(readKeyFile(await file('router-key.json', { apiKey: FAKE_KEY }), 'openai'), /not for OpenAI/);
  await assert.rejects(readKeyFile(await file('openai-key.json', { apiKey: FAKE_OPENAI_KEY }), 'openrouter'), /not for OpenRouter/);
  await assert.rejects(readKeyFile(await file('default.json', { apiKey: FAKE_OPENAI_KEY })), /not for OpenRouter/, 'The default track is OpenRouter\'s.');
});

test('under node --test the OpenAI track never targets OpenAI', async () => {
  await assert.rejects(createGateway({ key: 'x', budget: 1, provider: 'openai', prices: PRICES }), /never reach OpenRouter or OpenAI/);
});

test('the IPC child of the OpenAI track reads its key file, prices with the table it is given, and scrubs the key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-key-'));
  const upstream = await createFakeOpenAI({ script: () => ({ text: 'ok' }) });
  const file = join(dir, 'key.json');
  await writeFile(file, JSON.stringify({ apiKey: FAKE_OPENAI_KEY }));
  const gateway = await forkGateway({ keyFile: file, budget: 1, provider: 'openai', prices: PRICES, upstream: upstream.url });
  t.after(async () => { await gateway.stop(); await upstream.stop(); await rm(dir, { recursive: true, force: true }); });
  const opened = await gateway.open({ attempt: 'ipc', model: MODEL, cap: 0.1, deadline: Date.now() + 60_000 });
  const answer = await fetch(`${gateway.url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${opened!.token}` }, body: JSON.stringify({ model: MODEL, input: 'hi' }) });
  assert.equal(answer.status, 200);
  await answer.text();
  assert.equal(upstream.received[0].authorization, `Bearer ${FAKE_OPENAI_KEY}`);
  close((await gateway.close(opened!.token)).cost, COST);
  assert.equal(await gateway.scrub(`key=${FAKE_OPENAI_KEY}`), 'key=[REDACTED]');
});
