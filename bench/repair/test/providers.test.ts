// Providers and wire APIs without Docker or network: an adapter's declaration (OpenRouter over chat completions unless
// it says otherwise), the runner's refusal of a framework and provider pair it does not support, and model metadata for
// bare OpenAI ids from the price table beside OpenRouter's listing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDERS, modelInfo, wireOf } from '../harness.ts';
import { loadPrices } from '../prices.ts';
import { unsupported } from '../run.ts';

test('an adapter runs against OpenRouter over chat completions unless it declares otherwise', () => {
  assert.deepEqual(DEFAULT_PROVIDERS, { openrouter: 'chat' });
  assert.deepEqual([wireOf({}, 'openrouter'), wireOf({}, 'openai')], ['chat', null]);
  const declared = { providers: { openai: 'responses' as const } };
  assert.deepEqual([wireOf(declared, 'openai'), wireOf(declared, 'openrouter')], ['responses', null]);
});

test('the runner refuses a framework and provider pair the adapter does not declare or the gateway does not serve', () => {
  assert.equal(unsupported({}, 'openrouter'), null);
  assert.equal(unsupported({}, 'openai'), 'it does not support openai');
  assert.equal(unsupported({ providers: { openrouter: 'responses' } }, 'openrouter'), 'the gateway serves no responses API for openrouter');
  assert.equal(unsupported({ providers: { openrouter: 'chat', openai: 'responses' } }, 'openai'), null);
  assert.equal(unsupported({ providers: { openai: 'chat' } }, 'openai'), null);
});

test('bare OpenAI ids take their limits from the price table, an unpriced id is refused, and OpenRouter ids still come from its listing', async () => {
  const table = await loadPrices(), models = await modelInfo(['gpt-6-luna', 'gpt-5.3-codex'], table);
  assert.deepEqual([...models.values()], [
    { id: 'gpt-6-luna', contextWindow: 1_050_000, maxOutput: 128_000, reasoning: true }, { id: 'gpt-5.3-codex', contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
  ]);
  await assert.rejects(modelInfo(['gpt-6'], table), /lists no model gpt-6;/);
  const listing = { data: [{ id: 'vendor/model', context_length: 100_000, top_provider: { max_completion_tokens: 8_000 }, supported_parameters: ['tools', 'reasoning'] }] };
  const fetcher = (async (input: string | URL | Request) => {
    assert.equal(String(input), 'http://127.0.0.1:9/api/v1/models');
    return new Response(JSON.stringify(listing));
  }) as typeof fetch;
  assert.deepEqual((await modelInfo(['vendor/model'], 'http://127.0.0.1:9/api/v1/', fetcher)).get('vendor/model'), { id: 'vendor/model', contextWindow: 100_000, maxOutput: 8_000, reasoning: true });
});
