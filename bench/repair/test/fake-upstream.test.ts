// The fake upstream and the dry-run solver, without network: the key it demands, OpenRouter's SSE shape, generation
// records, the model list, and a solver that drives any framework's shell tool through reproduce, patch, verify, done.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_KEY, SUBMIT, createFakeUpstream, corpusSolutions, solver, type FakeScript } from '../fake-upstream.ts';
import { loadCases } from '../corpus.ts';

async function upstream(t: TestContext, script: FakeScript) {
  const fake = await createFakeUpstream({ script });
  t.after(() => fake.stop());
  const post = (body: Record<string, unknown>, key = FAKE_KEY) => fetch(`${fake.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'fake/coder', messages: [], ...body }) });
  return { fake, post };
}

test('the fake demands the real key and serves models and generation costs', async t => {
  const { fake, post } = await upstream(t, () => ({ text: 'hi', cost: 0.25, upstreamCost: 0.5 }));
  assert.equal((await post({}, 'sk-or-v1-wrong')).status, 401);
  const body = await (await post({})).json() as { id: string; usage: { cost: number; is_byok: boolean; cost_details: { upstream_inference_cost: number } } };
  assert.deepEqual([body.usage.cost, body.usage.is_byok, body.usage.cost_details.upstream_inference_cost], [0.25, true, 0.5]);
  const generation = await (await fetch(`${fake.url}/generation?id=${body.id}`, { headers: { authorization: `Bearer ${FAKE_KEY}` } })).json() as { data: { total_cost: number } };
  assert.equal(generation.data.total_cost, 0.75);
  const models = await (await fetch(`${fake.url}/models`)).json() as { data: { id: string }[] };
  assert.ok(models.data.some(model => model.id === 'fake/coder'));
});

test('a stream is shaped as OpenRouter\'s: role, processing comment, split tool-call arguments, finish, usage without choices, [DONE]', async t => {
  const { post } = await upstream(t, () => ({ calls: [{ name: 'run', arguments: { command: 'npm ci && npm test -- --test-reporter spec' } }], cost: 0.01 }));
  const events = (await (await post({ stream: true })).text()).split('\n\n').filter(Boolean);
  assert.match(events[0], /"role":"assistant"/);
  assert.equal(events[1], ': OPENROUTER PROCESSING');
  const data = events.filter(event => event.startsWith('data: {')).map(event => JSON.parse(event.slice(6)) as { choices: { delta?: { tool_calls?: { id?: string; function: { arguments: string } }[] }; finish_reason: string | null }[]; usage?: { cost: number } });
  const deltas = data.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta?.tool_calls ?? []));
  assert.ok(deltas.length > 2, 'Arguments arrive in several deltas.');
  assert.equal(deltas.filter(delta => delta.id).length, 1, 'Only the first delta names the call.');
  assert.equal(JSON.parse(deltas.map(delta => delta.function.arguments).join('')).command, 'npm ci && npm test -- --test-reporter spec');
  assert.deepEqual([data.at(-2)?.choices[0].finish_reason, data.at(-1)?.choices, data.at(-1)?.usage?.cost], ['tool_calls', [], 0.01]);
  assert.equal(events.at(-1), 'data: [DONE]');
});

test('the solver reproduces, patches, verifies and finishes through whatever shell and done tools the framework offers', async () => {
  const cases = await loadCases(['logic-tier-boundary']), solutions = await corpusSolutions(cases), solve = solver(solutions);
  const prompt = { role: 'user', content: `Repository ${cases[0].meta.repository}, branch main, failing commit abc. Attempt 1 of 4.` };
  const tool = (name: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'function', function: { name, parameters: { type: 'object', properties, required } } });
  const product = [tool('run', { command: { type: 'string' }, timeoutSeconds: { type: 'integer' } }, ['command']), tool('done', { summary: { type: 'string' } }, ['summary'])];
  const history = (steps: number) => [prompt, ...Array.from({ length: steps }, () => [{ role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', content: '{}' }]).flat()];
  const at = async (steps: number, tools: unknown[] = product) => solve({ messages: history(steps), tools }, steps);
  assert.deepEqual((await at(0)).calls, [{ name: 'run', arguments: { command: 'npm ci && npm test' } }]);
  const patch = (await at(1)).calls?.[0].arguments as { command: string };
  assert.match(patch.command, /^git apply --whitespace=nowarn <<'BENCH_PATCH_[\da-f]+'\ndiff --git a\/src\/invoice\.js/);
  assert.deepEqual((await at(2)).calls?.[0].arguments, { command: 'npm ci && npm test' });
  assert.equal((await at(3)).calls?.[0].name, 'done');
  // OpenCode's bash wants a description too; without a done tool the answer is text.
  const opencode = [tool('bash', { command: { type: 'string' }, description: { type: 'string' } }, ['command', 'description'])];
  assert.deepEqual((await at(0, opencode)).calls?.[0].arguments, { command: 'npm ci && npm test', description: 'Bench step' });
  assert.match((await at(3, opencode)).text ?? '', /pass now/);
  // mini-swe-agent's text protocol: bash blocks, then the submit line.
  const mini = await solve({ messages: [{ role: 'system', content: `Finish with ${SUBMIT}.` }, prompt] }, 0);
  assert.match(mini.text ?? '', /^```bash\nnpm ci && npm test\n```$/);
  const submit = await solve({ messages: [{ role: 'system', content: `Finish with ${SUBMIT}.` }, prompt, ...history(3).slice(1)] }, 3);
  assert.match(submit.text ?? '', new RegExp(`echo ${SUBMIT}`));
  assert.equal((await solve({ messages: [{ role: 'user', content: 'Title this session' }] }, 0)).text, 'Build repair', 'A request without tools, such as a title, gets text.');
});
