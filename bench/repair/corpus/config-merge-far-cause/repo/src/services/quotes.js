import { createLine } from '../domain/line.js';
import { priceLines } from '../pricing/index.js';
import { check, notFound } from '../util/assert.js';

/** Quotes: an order's lines and totals in a region, priced from the catalog and the region's settings, not placed. */
export function createQuotes({ config, catalog, store }) {
  return {
    quote({ region, lines, code = null }) {
      check(typeof region === 'string', 'region must name a region');
      const settings = Object.hasOwn(config.regions, region) ? config.regions[region] : notFound(`No region ${region}.`);
      check(Array.isArray(lines) && lines.length > 0, 'lines must list at least one product');
      check(lines.length <= config.orders.maxLines, `an order has at most ${config.orders.maxLines} lines`);
      const discount = code === null ? null : store.codes.get(code) ?? notFound(`No discount code ${code}.`);
      const priced = lines.map(line => {
        const product = catalog.find(line?.sku);
        check(product, `unknown product ${line?.sku}`);
        return createLine(product, line.qty);
      });
      return { region, code, lines: priced, totals: priceLines(priced, settings, discount) };
    },
  };
}
