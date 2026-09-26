// The OpenAI track's prices without network: the shipped table (the GPT-6 family, gpt-5.3-codex and gpt-5-nano at the
// Standard tier, with their long-context rates, limits, source and date), a table read as unknown, and a request's
// dollars from its usage: ordinary input, cached reads, cache writes and output, the long-context switch and the tier
// factors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPrices, parsePrices, priceFor, priceOf, tierFactor, type ModelPrice } from '../prices.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
const rates = (price: ModelPrice | null) => price && [price.input, price.cachedInput, price.cacheWrite, price.output,
  price.longContext?.above, price.longContext?.input, price.longContext?.cachedInput, price.longContext?.cacheWrite, price.longContext?.output];

test('the shipped table prices the GPT-6 family, gpt-5.3-codex and gpt-5-nano at the Standard tier, with its source, date and limits', async () => {
  const table = await loadPrices();
  assert.deepEqual([table.source, table.checked], ['https://developers.openai.com/api/docs/pricing', '2026-09-25']);
  assert.deepEqual(Object.keys(table.models), ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.3-codex', 'gpt-5-nano']);
  assert.deepEqual(rates(priceFor(table, 'gpt-6-luna')), [0.1, 0.01, 0.125, 0.5, 272_000, 0.2, 0.02, 0.25, 0.75]);
  assert.deepEqual(rates(priceFor(table, 'gpt-6-sol')), [2, 0.2, 2.5, 10, 272_000, 4, 0.4, 5, 15]);
  assert.deepEqual(rates(priceFor(table, 'gpt-6-astra')), [10, 1, 12.5, 50, 272_000, 20, 2, 25, 75]);
  assert.deepEqual(rates(priceFor(table, 'gpt-5.3-codex')), [1.75, 0.175, undefined, 14, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(rates(priceFor(table, 'gpt-5-nano')), [0.05, 0.005, undefined, 0.4, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual([priceFor(table, 'gpt-5-nano')?.contextWindow, priceFor(table, 'gpt-5-nano')?.maxOutput, priceFor(table, 'gpt-5-nano')?.reasoning], [400_000, 128_000, true]);
  for (const id of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']) {
    const price = priceFor(table, id);
    assert.deepEqual([price?.contextWindow, price?.maxOutput, price?.reasoning], [1_050_000, 128_000, true], id);
  }
  assert.deepEqual(table.tiers, { flex: 0.5, priority: 2, fast: 2 });
  assert.equal(priceFor(table, 'gpt-6'), null, 'No model is named gpt-6.');
  assert.equal(priceFor(table, 'constructor'), null, 'An inherited key is no model.');
});

test('a request is priced from its usage: ordinary input, cached reads, cache writes and output', () => {
  const price: ModelPrice = { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 10, contextWindow: 200_000, maxOutput: 32_000, reasoning: true };
  close(priceOf({ prompt: 1000, cached: 200, cacheWrite: 100, completion: 50 }, price), (700 * 1 + 200 * 0.1 + 100 * 1.25 + 50 * 10) / 1e6);
  close(priceOf({ prompt: 0, cached: 0, cacheWrite: 0, completion: 0 }, price), 0);
  // Without a cache-write price a write costs ordinary input, and counts that disagree never price input below zero.
  const { cacheWrite: _cacheWrite, ...plain } = price;
  close(priceOf({ prompt: 1000, cached: 0, cacheWrite: 400, completion: 0 }, plain), 1000 / 1e6);
  close(priceOf({ prompt: 100, cached: 300, cacheWrite: 0, completion: 0 }, price), 300 * 0.1 / 1e6);
});

test('a prompt over the long-context threshold is priced at the long-context rates for the whole request, and a tier multiplies', async () => {
  const table = await loadPrices(), sol = priceFor(table, 'gpt-6-sol')!;
  close(priceOf({ prompt: 272_000, cached: 0, cacheWrite: 0, completion: 1000 }, sol), (272_000 * 2 + 1000 * 10) / 1e6);
  close(priceOf({ prompt: 272_001, cached: 0, cacheWrite: 0, completion: 1000 }, sol), (272_001 * 4 + 1000 * 15) / 1e6);
  close(priceOf({ prompt: 300_000, cached: 100_000, cacheWrite: 10_000, completion: 1000 }, sol), (190_000 * 4 + 100_000 * 0.4 + 10_000 * 5 + 1000 * 15) / 1e6);
  // A model without long-context rates keeps its one rate.
  close(priceOf({ prompt: 300_000, cached: 0, cacheWrite: 0, completion: 0 }, priceFor(table, 'gpt-5.3-codex')!), 300_000 * 1.75 / 1e6);
  // Standard is 1; Flex and Fast mode (reported as priority) are the table's; a tier it does not list is its highest.
  assert.deepEqual([undefined, 'default', 'auto', 'flex', 'priority', 'fast', 'ultrafast'].map(tier => tierFactor(table, tier)), [1, 1, 1, 0.5, 2, 2, 2]);
  close(priceOf({ prompt: 1000, cached: 0, cacheWrite: 0, completion: 100 }, sol, tierFactor(table, 'priority')), 2 * (1000 * 2 + 100 * 10) / 1e6);
});

test('a table read as unknown needs a source, a date and complete rates for every model', () => {
  const model = { input: 1, cachedInput: 0.1, output: 2, contextWindow: 10, maxOutput: 5, reasoning: false };
  const table = { source: 'https://example.com/pricing', checked: '2026-09-25', models: { m: model } };
  assert.deepEqual(parsePrices(table), { source: table.source, checked: table.checked, tiers: {}, models: { m: model } });
  assert.throws(() => parsePrices({ ...table, source: 'http://example.com/pricing' }), /source, checked and models/);
  assert.throws(() => parsePrices({ ...table, checked: 'today' }), /source, checked and models/);
  assert.throws(() => parsePrices({ ...table, models: {} }), /lists no model/);
  assert.throws(() => parsePrices({ ...table, models: { m: { ...model, output: -1 } } }), /m\.output is not a price/);
  assert.throws(() => parsePrices({ ...table, models: { m: { ...model, input: '1' } } }), /m\.input is not a price/);
  assert.throws(() => parsePrices({ ...table, models: { m: { ...model, reasoning: 'yes' } } }), /model m is invalid/);
  assert.throws(() => parsePrices({ ...table, models: { 'bad id!': model } }), /model bad id! is invalid/);
  assert.throws(() => parsePrices({ ...table, models: { m: { ...model, contextWindow: 0 } } }), /m\.contextWindow is not a positive whole number/);
  assert.throws(() => parsePrices({ ...table, models: { m: { ...model, longContext: { above: 0, input: 1, cachedInput: 1, output: 1 } } } }), /m\.longContext\.above/);
  assert.throws(() => parsePrices({ ...table, tiers: { fast: 0 } }), /tier fast has no factor/);
});
