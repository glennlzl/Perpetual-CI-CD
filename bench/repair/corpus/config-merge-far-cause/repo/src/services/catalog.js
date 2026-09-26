import { notFound } from '../util/assert.js';

/** The product catalog. */
export function createCatalog(store) {
  return {
    list: () => store.products.all(),
    find: sku => store.products.get(sku),
    get: sku => store.products.get(sku) ?? notFound(`No product ${sku}.`),
  };
}
