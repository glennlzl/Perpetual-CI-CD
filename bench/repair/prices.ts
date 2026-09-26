// The OpenAI track's price table. OpenAI reports a request's usage but no dollars, so the gateway prices every request
// from its reported usage with prices/openai.json: USD per 1M tokens at the Standard tier, with the page each price was
// read from and the date it was checked. Input tokens include cached reads and cache writes, which have their own
// rates; a prompt over a model's long-context threshold is priced at its long-context rates for the whole request; and
// a response served at a tier other than the Standard one the gateway asks for is multiplied by that tier's factor.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface Rates { input: number; cachedInput: number; cacheWrite?: number; output: number }
export interface ModelPrice extends Rates { longContext?: Rates & { above: number }; contextWindow: number; maxOutput: number; reasoning: boolean }
export interface PriceTable { source: string; checked: string; tiers: Record<string, number>; models: Record<string, ModelPrice> }
/** What a request is priced by: its input tokens (cached reads and cache writes included) and its output tokens (reasoning included). */
export interface PricedUsage { prompt: number; cached: number; cacheWrite: number; completion: number }
export const PRICES = fileURLToPath(new URL('./prices/openai.json', import.meta.url));

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function rate(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) throw new Error(`The price table's ${name} is not a price.`);
  return value;
}
function whole(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`The price table's ${name} is not a positive whole number.`);
  return value;
}
const rates = (value: Record<string, unknown>, name: string): Rates => ({
  input: rate(value.input, `${name}.input`), cachedInput: rate(value.cachedInput, `${name}.cachedInput`),
  ...(value.cacheWrite === undefined ? {} : { cacheWrite: rate(value.cacheWrite, `${name}.cacheWrite`) }), output: rate(value.output, `${name}.output`),
});

/** A price table read as unknown: each model's rates, long-context rates, limits and reasoning flag, and the tiers' factors. */
export function parsePrices(value: unknown): PriceTable {
  if (!isRecord(value) || typeof value.source !== 'string' || !value.source.startsWith('https://') || typeof value.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.checked) || !isRecord(value.models)) {
    throw new Error('The price table needs source, checked and models.');
  }
  const models: Record<string, ModelPrice> = {};
  for (const [id, entry] of Object.entries(value.models)) {
    if (!/^[\w.:-]{1,100}$/.test(id) || !isRecord(entry) || typeof entry.reasoning !== 'boolean' || entry.longContext !== undefined && !isRecord(entry.longContext)) throw new Error(`The price table's model ${id.slice(0, 100)} is invalid.`);
    const long = isRecord(entry.longContext) ? entry.longContext : null;
    models[id] = {
      ...rates(entry, id), ...(long ? { longContext: { above: whole(long.above, `${id}.longContext.above`), ...rates(long, `${id}.longContext`) } } : {}),
      contextWindow: whole(entry.contextWindow, `${id}.contextWindow`), maxOutput: whole(entry.maxOutput, `${id}.maxOutput`), reasoning: entry.reasoning,
    };
  }
  if (!Object.keys(models).length) throw new Error('The price table lists no model.');
  const tiers: Record<string, number> = {};
  for (const [tier, factor] of Object.entries(isRecord(value.tiers) ? value.tiers : {})) {
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 || factor > 100) throw new Error(`The price table's tier ${tier.slice(0, 40)} has no factor.`);
    tiers[tier] = factor;
  }
  return { source: value.source, checked: value.checked, tiers, models };
}

export const loadPrices = async (path = PRICES) => parsePrices(JSON.parse(await readFile(path, 'utf8')));
/** A model's prices, or null for one the table does not list (an inherited key such as constructor included). */
export const priceFor = (table: PriceTable, model: string): ModelPrice | null => Object.hasOwn(table.models, model) ? table.models[model] : null;
/** The factor of the tier that served a request: 1 at the Standard tier, the table's for another, and its highest for one it does not list. */
export const tierFactor = (table: PriceTable, tier?: string) => !tier || tier === 'default' || tier === 'auto' ? 1
  : Object.hasOwn(table.tiers, tier) ? table.tiers[tier] : Math.max(1, ...Object.values(table.tiers));

/**
 * A request's dollars: its ordinary input, cached reads, cache writes (at the input rate for a model without a
 * cache-write price) and output, at the long-context rates once the prompt exceeds their threshold, times the factor of
 * the tier that served it.
 */
export function priceOf(usage: PricedUsage, price: ModelPrice, factor = 1) {
  const at: Rates = price.longContext && usage.prompt > price.longContext.above ? price.longContext : price;
  const ordinary = Math.max(0, usage.prompt - usage.cached - usage.cacheWrite);
  return (ordinary * at.input + usage.cached * at.cachedInput + usage.cacheWrite * (at.cacheWrite ?? at.input) + usage.completion * at.output) / 1e6 * factor;
}
