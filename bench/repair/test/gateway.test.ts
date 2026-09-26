// The model gateway against the fake upstream, without network or a model: auth by attempt token, the real key only
// upstream, the forced body fields and reasoning policy, the model allowlist, usage and tool calls from JSON and SSE,
// byte-identical passthrough, every refusal, budget reservation, cost recovery, the key file and the IPC child.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createGateway, forkGateway, readKeyFile, rewrite, sseObserver, type GatewayOptions } from '../gateway.ts';
import { FAKE_KEY, createFakeUpstream, type FakeReply, type FakeScript } from '../fake-upstream.ts';

const MODEL = 'fake/coder';
async function setup(t: TestContext, script: FakeScript = () => ({ text: 'ok' }), options: Partial<GatewayOptions> = {}) {
  const upstream = await createFakeUpstream({ script });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 10, upstream: upstream.url, recovery: { tries: 2, delayMs: 10 }, closeWaitMs: 2_000, ...options });
  t.after(async () => { await gateway.stop(); await upstream.stop(); });
  const opened = await gateway.open({ attempt: 'a1', model: MODEL, cap: 0.5, deadline: Date.now() + 60_000 });
  assert.ok(opened);
  const post = (body: Record<string, unknown>, token = opened.token, headers: Record<string, string> = {}) => fetch(`${gateway.url}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  return { upstream, gateway, token: opened.token, post };
}
const reply = (value: FakeReply): FakeScript => () => value;
// A process's environment as the OS shows it to its owner: /proc on Linux, ps on macOS; null elsewhere.
const readEnvironment = (pid: number) => readFile(`/proc/${pid}/environ`, 'utf8').catch(() => promisify(execFile)('ps', ['eww', '-o', 'command=', '-p', String(pid)]).then(result => result.stdout, () => null));

test('a caller needs an open attempt\'s token; the upstream sees only the real key, and nothing answers with it', async t => {
  const f = await setup(t);
  const none = await fetch(`${f.gateway.url}/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(none.status, 401);
  assert.equal((await f.post({}, 'not-a-token')).status, 401);
  const answer = await f.post({}, f.token, { 'x-title': 'bench', 'http-referer': 'https://bench.example', 'x-unrelated': 'dropped' });
  assert.equal(answer.status, 200);
  const text = await answer.text();
  assert.ok(!text.includes(FAKE_KEY));
  const forwarded = f.upstream.received.find(item => item.path === '/api/v1/chat/completions');
  assert.equal(forwarded?.authorization, `Bearer ${FAKE_KEY}`);
  assert.ok(!JSON.stringify(forwarded).includes(f.token), 'The attempt token never reaches the upstream.');
  assert.deepEqual([forwarded?.headers['x-title'], forwarded?.headers['http-referer'], forwarded?.headers['x-unrelated']], ['bench', 'https://bench.example', undefined]);
  assert.equal((await fetch(`${f.gateway.url}/models`)).status, 404, 'Only chat completions are served.');
  const usage = await f.gateway.close(f.token);
  assert.ok(!JSON.stringify(usage).includes(FAKE_KEY));
  const closed = await f.post({});
  assert.deepEqual([closed.status, closed.headers.get('x-bench-refusal')], [402, 'closed']);
});

test('every request denies data collection and includes usage, keeping the rest of provider and the messages as sent', async t => {
  const f = await setup(t);
  const details = [{ type: 'reasoning.encrypted', data: 'opaque', id: 'r1' }];
  await f.post({ provider: { order: ['a'], data_collection: 'allow' }, usage: { include: false }, reasoning: { effort: 'high' }, include_reasoning: true, temperature: 0.2, max_tokens: 99,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', reasoning_details: details }], tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] });
  const body = f.upstream.received.at(-1)?.body as Record<string, unknown>;
  assert.deepEqual(body.provider, { order: ['a'], data_collection: 'deny' });
  assert.deepEqual(body.usage, { include: true });
  assert.equal('reasoning' in body || 'include_reasoning' in body, false, 'The default policy leaves reasoning to the model\'s OpenRouter default.');
  assert.deepEqual([body.temperature, body.max_tokens, (body.messages as { reasoning_details?: unknown }[])[1].reasoning_details], [0.2, 99, details]);
  assert.deepEqual(rewrite({ reasoning_effort: 'low' }, { reasoning: 'high', providerOnly: 'Fake' }), { provider: { data_collection: 'deny', only: ['Fake'] }, usage: { include: true }, reasoning: { effort: 'high' } });
  assert.deepEqual(rewrite({ reasoning: { max_tokens: 5 } }, { reasoning: 'native' }).reasoning, { max_tokens: 5 });
});

test('a request for another model is refused and recorded, never forwarded', async t => {
  const f = await setup(t);
  const answer = await f.post({ model: 'fake/small' });
  assert.equal(answer.status, 400);
  assert.equal(f.upstream.received.length, 0);
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.modelViolations, usage.requests], [['fake/small'], 0]);
});

test('JSON and SSE completions record usage, cost, tool calls, provider and finish reason; SSE reasoning details pass through', async t => {
  const details = [{ type: 'reasoning.text', text: 'think' }];
  const script: FakeScript = (_body, index) => index === 0
    ? { calls: [{ name: 'run', arguments: { command: 'npm test' } }, { name: 'read', arguments: { path: 'src/a.js' } }], cost: 0.01, upstreamCost: 0.02, provider: 'Alpha' }
    : { calls: [{ name: 'run', arguments: { command: 'npm ci && npm run build && npm test -- --reporter spec' } }], text: 'Running the tests now.', cost: 0.03, reasoningDetails: details, provider: 'Beta' };
  const f = await setup(t, script);
  const first = await (await f.post({})).json() as { choices: { message: { tool_calls: unknown[] } }[] };
  assert.equal(first.choices[0].message.tool_calls.length, 2);
  const stream = await f.post({ stream: true });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const events = await stream.text();
  assert.match(events, /: OPENROUTER PROCESSING/);
  assert.ok(events.includes(JSON.stringify(details)), 'Reasoning details reach the client untouched.');
  const usage = await f.gateway.close(f.token);
  assert.equal(usage.requests, 2);
  assert.equal(usage.toolCalls, 3, 'A streamed call with split argument deltas counts once.');
  assert.ok(Math.abs(usage.cost - 0.06) < 1e-9, 'A BYOK request adds its upstream inference cost.');
  assert.deepEqual([usage.costSources, usage.providers, usage.byok], [{ usage: 2, generation: 0, unknown: 0 }, { Alpha: 1, Beta: 1 }, 1]);
  assert.deepEqual(usage.tokens, { prompt: 2000, completion: 100, reasoning: 20, cached: 400, cacheWrite: 0 });
  assert.deepEqual(usage.log.map(entry => [entry.stream, entry.finish, entry.toolCalls]), [[false, 'tool_calls', 2], [true, 'tool_calls', 1]]);
});

test('responses reach the client byte for byte, however the upstream splits its chunks', async t => {
  const json = Buffer.from('{"id":"gen-1","choices":[{"message":{"role":"assistant","content":"é  ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.004}}');
  const sse = Buffer.from(': OPENROUTER PROCESSING\n\ndata: {"id":"gen-2","choices":[{"delta":{"content":"é"},"finish_reason":null}]}\r\n\r\ndata: {"id":"gen-2","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"cost":0.005}}\n\ndata: [DONE]\n\n');
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (calls === 1) return new Response(json, { headers: { 'content-type': 'application/json; charset=utf-8' } });
    const pieces = [sse.subarray(0, 7), sse.subarray(7, 50), sse.subarray(50, 51), sse.subarray(51)];
    return new Response(new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(new Uint8Array(piece)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const f = await setup(t, undefined, { fetch: fetcher });
  const first = await f.post({});
  assert.equal(first.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), json);
  assert.deepEqual(Buffer.from(await (await f.post({ stream: true })).arrayBuffer()), sse);
  const usage = await f.gateway.close(f.token);
  assert.ok(Math.abs(usage.cost - 0.009) < 1e-9);
  assert.deepEqual(usage.tokens.prompt, 4);
});

test('the SSE reader ignores comments, [DONE] and broken lines, and keeps the last usage and any error', () => {
  const reader = sseObserver(), encode = (text: string) => new TextEncoder().encode(text);
  for (const part of [': ping\n', 'data: {"id":"g","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run","arguments":"{\\"com"}}]}}]}\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\\":1}"}}]}}]}\n',
    'data: {broken\n', 'data: {"error":{"code":502,"message":"Provider disconnected"}}\n', 'data: {"choices":[],"usage":{"cost":1}}\n', 'data: [DONE]']) reader.push(encode(part));
  reader.end();
  assert.deepEqual([reader.seen.toolCalls, reader.seen.id, reader.seen.error, reader.seen.usage], [1, 'g', 'Provider disconnected', { cost: 1 }]);
});

test('the gateway refuses with 402 once an attempt reaches its cap, the run its budget, or the attempt its deadline', async t => {
  const f = await setup(t, reply({ text: 'ok', cost: 0.3 }), { budget: 1 });
  assert.equal((await f.post({})).status, 200);
  assert.equal((await f.post({})).status, 200, 'The request that passes the cap is the last.');
  const capped = await f.post({});
  assert.deepEqual([capped.status, capped.headers.get('x-bench-refusal')], [402, 'cost']);
  assert.deepEqual(await capped.json(), { error: { code: 402, type: 'bench_limit', message: 'Bench limit: the attempt reached its cost cap.' } });
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.requests, usage.firstRefusal, usage.refusals], [2, 'cost', { cost: 1 }]);
  const late = await f.gateway.open({ attempt: 'late', model: MODEL, cap: 0.01, deadline: Date.now() - 1 });
  assert.equal((await f.post({}, late!.token)).headers.get('x-bench-refusal'), 'deadline');
  // Two attempts share a budget of 1: A overshoots its cap to 0.8, B's first request takes the run to 1.2, and B's
  // second, still under B's cap, is refused for the budget.
  const shared = await setup(t, reply({ text: 'ok', cost: 0.4 }), { budget: 1 });
  const b = await shared.gateway.open({ attempt: 'b', model: MODEL, cap: 0.5, deadline: Date.now() + 60_000 });
  for (let index = 0; index < 2; index += 1) assert.equal((await shared.post({})).status, 200);
  assert.equal((await shared.post({}, b!.token)).status, 200);
  const over = await shared.post({}, b!.token);
  assert.deepEqual([over.status, over.headers.get('x-bench-refusal')], [402, 'budget']);
  assert.equal((await shared.gateway.close(b!.token)).firstRefusal, 'budget');
});

test('an attempt past its request limit is refused before its cap', async t => {
  const f = await setup(t, reply({ text: 'ok', cost: 0.0001 }));
  const limited = await f.gateway.open({ attempt: 'r', model: MODEL, cap: 1, deadline: Date.now() + 60_000, maxRequests: 2 });
  for (let index = 0; index < 2; index += 1) assert.equal((await f.post({}, limited!.token)).status, 200);
  assert.equal((await f.post({}, limited!.token)).headers.get('x-bench-refusal'), 'requests');
  const usage = await f.gateway.close(limited!.token);
  assert.deepEqual([usage.requests, usage.firstRefusal], [2, 'requests']);
});

test('the global budget reserves every open attempt\'s remaining cap and releases it on close', async t => {
  const f = await setup(t, reply({ text: 'ok', cost: 0.1 }), { budget: 1 });
  assert.deepEqual(await f.gateway.status(), { spent: 0, reserved: 0.5, budget: 1 });
  const second = await f.gateway.open({ attempt: 'b', model: MODEL, cap: 0.5, deadline: Date.now() + 60_000 });
  assert.ok(second);
  assert.equal(await f.gateway.open({ attempt: 'c', model: MODEL, cap: 0.01, deadline: Date.now() + 60_000 }), null);
  await f.post({});
  const status = await f.gateway.status();
  assert.ok(Math.abs(status.spent - 0.1) < 1e-9 && Math.abs(status.reserved - 0.9) < 1e-9);
  await f.gateway.close(second.token);
  assert.ok(await f.gateway.open({ attempt: 'd', model: MODEL, cap: 0.5, deadline: Date.now() + 60_000 }));
});

test('a stream the client abandons is costed from OpenRouter\'s generation record, and one it cannot find is marked unknown', async t => {
  const f = await setup(t, (_body, index) => index === 0 ? { hang: true, cost: 0.07 } : { noUsage: true, cost: 0.01 });
  const reader = (await f.post({ stream: true })).body!.getReader();
  await reader.read();
  await reader.cancel();
  // The second completion carries an id without usage; the fake knows it, so it is recovered too.
  await (await f.post({})).text();
  const usage = await f.gateway.close(f.token);
  assert.deepEqual(usage.log.map(entry => entry.costSource), ['generation', 'generation']);
  assert.ok(Math.abs(usage.cost - 0.08) < 1e-9);
  const fetcher = (async (input: string | URL | Request) => String(input).includes('/generation') ? new Response('{}', { status: 404 }) : new Response('{"id":"gen-x","choices":[]}', { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const lost = await setup(t, undefined, { fetch: fetcher });
  await (await lost.post({})).text();
  const unknown = await lost.gateway.close(lost.token);
  assert.deepEqual([unknown.costSources.unknown, unknown.cost], [1, 0]);
});

test('an upstream error passes through with its status and costs nothing', async t => {
  const f = await setup(t, reply({ status: 400, error: 'This endpoint\'s maximum context length is 1000 tokens' }));
  const answer = await f.post({});
  assert.equal(answer.status, 400);
  assert.match(await answer.text(), /maximum context length/);
  const usage = await f.gateway.close(f.token);
  assert.deepEqual([usage.requests, usage.cost, usage.log[0].costSource], [1, 0, 'none']);
});

test('under node --test the gateway never targets OpenRouter', async () => {
  await assert.rejects(createGateway({ key: 'x', budget: 1 }), /never reach OpenRouter/);
});

test('a key file is a regular JSON file with apiKey, never a link or a large file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'browser-model.json');
  await writeFile(file, JSON.stringify({ apiKey: FAKE_KEY, model: 'fake/coder', escalationModel: 'fake/escalation', baseUrl: 'https://openrouter.ai/api/v1' }));
  assert.deepEqual(await readKeyFile(file), { apiKey: FAKE_KEY, models: ['fake/coder', 'fake/escalation'] });
  await symlink(file, join(dir, 'link.json'));
  await assert.rejects(readKeyFile(join(dir, 'link.json')), /regular file/);
  await writeFile(join(dir, 'big.json'), JSON.stringify({ apiKey: 'x'.repeat(20_000) }));
  await assert.rejects(readKeyFile(join(dir, 'big.json')), /16 KB/);
  await writeFile(join(dir, 'other.json'), JSON.stringify({ apiKey: FAKE_KEY, baseUrl: 'https://api.example.com/v1' }));
  await assert.rejects(readKeyFile(join(dir, 'other.json')), /not for OpenRouter/);
  await writeFile(join(dir, 'none.json'), '{"model":"x"}');
  await assert.rejects(readKeyFile(join(dir, 'none.json')), /no apiKey/);
});

test('the IPC child holds the key: not in its argv or environment, and scrub removes it from any text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-key-'));
  const upstream = await createFakeUpstream({ script: () => ({ text: 'ok', cost: 0.02 }) });
  const file = join(dir, 'key.json');
  await writeFile(file, JSON.stringify({ apiKey: FAKE_KEY }));
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-should-not-reach-the-child-000000000000000000000000';
  const gateway = await forkGateway({ keyFile: file, budget: 1, upstream: upstream.url });
  delete process.env.OPENROUTER_API_KEY;
  t.after(async () => { await gateway.stop(); await upstream.stop(); await rm(dir, { recursive: true, force: true }); });
  assert.ok(!gateway.child.spawnargs.join(' ').includes(FAKE_KEY));
  const environment = await readEnvironment(gateway.child.pid!);
  if (environment !== null) assert.ok(!environment.includes('OPENROUTER_API_KEY') && !environment.includes(FAKE_KEY), 'The child\'s environment holds no key.');
  const opened = await gateway.open({ attempt: 'ipc', model: MODEL, cap: 0.1, deadline: Date.now() + 60_000 });
  const answer = await fetch(`${gateway.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${opened!.token}` }, body: JSON.stringify({ model: MODEL, messages: [] }) });
  assert.equal(answer.status, 200);
  await answer.text();
  assert.equal(upstream.received[0].authorization, `Bearer ${FAKE_KEY}`);
  const usage = await gateway.close(opened!.token);
  assert.ok(Math.abs(usage.cost - 0.02) < 1e-9);
  assert.deepEqual(await gateway.status(), { spent: 0.02, reserved: 0, budget: 1 });
  assert.equal(await gateway.scrub(`key=${FAKE_KEY} and more`), 'key=[REDACTED] and more');
});
