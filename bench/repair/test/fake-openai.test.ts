// The fake OpenAI and the dry-run solver on the Responses wire, without network: the key it demands, OpenAI's chat and
// Responses shapes with usage and no dollars, chat usage only when asked, the store rules it holds requests to as OpenAI
// does, and the solver driving a framework's function tools through reproduce, patch, verify and done over Responses.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases } from '../corpus.ts';
import { FAKE_OPENAI_KEY, chatView, createFakeOpenAI } from '../fake-openai.ts';
import { corpusSolutions, solver, type FakeScript } from '../fake-upstream.ts';

async function fake(t: TestContext, script: FakeScript) {
  const upstream = await createFakeOpenAI({ script });
  t.after(() => upstream.stop());
  const post = (path: string, body: Record<string, unknown>, key = FAKE_OPENAI_KEY) => fetch(`${upstream.url}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'gpt-6-luna', ...body }),
  });
  return { upstream, post };
}
type Item = { type: string; encrypted_content?: string };
type Event = { type: string; sequence_number: number; response?: { status: string; output: Item[]; usage: Record<string, unknown> | null } };
/** A Responses stream's events, each checked to name its type on its event line. */
const events = (text: string) => text.split('\n\n').filter(Boolean).map(block => {
  const [line, data] = block.split('\n');
  const event = JSON.parse(data.slice('data: '.length)) as Event;
  assert.equal(line, `event: ${event.type}`);
  return event;
});

test('the fake demands the real key, reports usage without dollars, and streams chat usage only when asked', async t => {
  const { post } = await fake(t, () => ({ calls: [{ name: 'run', arguments: { command: 'npm test' } }] }));
  assert.equal((await post('/chat/completions', { messages: [] }, 'sk-proj-wrong')).status, 401);
  assert.equal((await post('/embeddings', { input: 'x' })).status, 404);
  const body = await (await post('/chat/completions', { messages: [] })).json() as { choices: { finish_reason: string }[]; usage: Record<string, unknown> };
  assert.deepEqual([body.choices[0].finish_reason, 'cost' in body.usage, body.usage.prompt_tokens], ['tool_calls', false, 1000]);
  assert.ok(!(await (await post('/chat/completions', { messages: [], stream: true })).text()).includes('"usage"'), 'Without include_usage a stream carries no usage.');
  const chunks = (await (await post('/chat/completions', { messages: [], stream: true, stream_options: { include_usage: true } })).text()).split('\n\n').filter(Boolean);
  assert.equal(chunks.at(-1), 'data: [DONE]');
  const last = JSON.parse(chunks.at(-2)!.slice('data: '.length)) as { choices: unknown[]; usage: { prompt_tokens_details: unknown } };
  assert.deepEqual([last.choices, last.usage.prompt_tokens_details], [[], { cached_tokens: 200, cache_write_tokens: 100, audio_tokens: 0 }]);
});

test('a Responses stream is typed events ending at response.completed with usage, and reasoning is encrypted only when include asks', async t => {
  const { post } = await fake(t, () => ({ calls: [{ name: 'run', arguments: { command: 'npm ci && npm test' } }] }));
  const streamed = events(await (await post('/responses', { input: 'hi', stream: true })).text());
  assert.deepEqual(streamed.map(event => event.sequence_number), streamed.map((_event, index) => index));
  assert.deepEqual([streamed[0].type, streamed.at(-1)?.type], ['response.created', 'response.completed']);
  assert.ok(streamed.some(event => event.type === 'response.function_call_arguments.delta'), 'Arguments arrive in deltas.');
  const done = streamed.at(-1)!.response!;
  assert.deepEqual([done.status, done.output.map(item => item.type), done.usage?.input_tokens, 'cost' in (done.usage ?? {})], ['completed', ['reasoning', 'function_call'], 1000, false]);
  assert.equal(done.output[0].encrypted_content, undefined);
  const encrypted = await (await post('/responses', { input: 'hi', include: ['reasoning.encrypted_content'] })).json() as { output: Item[] };
  assert.match(encrypted.output[0].encrypted_content ?? '', /^gAAAAB/);
});

test('with store=false, reasoning without its encrypted content and item references are refused, and previous_response_id must name a stored response', async t => {
  const { post } = await fake(t, () => ({ text: 'ok' }));
  const refused = await post('/responses', { store: false, input: [{ role: 'user', content: 'hi' }, { type: 'reasoning', id: 'rs_1', summary: [] }] });
  assert.equal(refused.status, 404);
  assert.match(await refused.text(), /Item with id 'rs_1' not found\. Items are not persisted when `store` is set to false/);
  assert.equal((await post('/responses', { store: false, input: [{ type: 'item_reference', id: 'msg_1' }] })).status, 404);
  assert.equal((await post('/responses', { store: false, input: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAB00' }] })).status, 200);
  const unstored = await (await post('/responses', { store: false, input: 'hi' })).json() as { id: string };
  assert.equal((await post('/responses', { previous_response_id: unstored.id, input: 'next' })).status, 400);
  const stored = await (await post('/responses', { input: 'hi' })).json() as { id: string };
  assert.equal((await post('/responses', { previous_response_id: stored.id, input: 'next' })).status, 200);
});

test('the solver drives a framework\'s function tools over Responses: reproduce, patch, verify, done', async t => {
  const cases = await loadCases(['logic-tier-boundary']);
  const { post } = await fake(t, solver(await corpusSolutions(cases)));
  const tool = (name: string, field: string) => ({ type: 'function', name, parameters: { type: 'object', properties: { [field]: { type: 'string' } }, required: [field] } });
  const tools = [tool('run', 'command'), tool('done', 'summary')];
  const input: unknown[] = [{ role: 'user', content: [{ type: 'input_text', text: `Repository ${cases[0].meta.repository}, branch main. Attempt 1 of 4.` }] }];
  const names: string[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    // As a framework does with store=false: replay every output item, reasoning with its encrypted content included.
    const reply = await (await post('/responses', { instructions: 'Fix it.', input, tools, store: false, include: ['reasoning.encrypted_content'] })).json() as { output: Record<string, unknown>[] };
    const call = reply.output.find(item => item.type === 'function_call')!;
    names.push(String(call.name));
    input.push(...reply.output, { type: 'function_call_output', call_id: call.call_id, output: '{"ok":true}' });
  }
  assert.deepEqual(names, ['run', 'run', 'run', 'done']);
  assert.deepEqual(chatView({ instructions: 'Fix it.', input: 'hi', tools }).messages, [{ role: 'system', content: 'Fix it.' }, { role: 'user', content: 'hi' }]);
});
