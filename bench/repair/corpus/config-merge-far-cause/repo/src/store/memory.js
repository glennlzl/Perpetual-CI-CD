/** An in-memory store seeded with products and discount codes; orders last as long as the process. */
export function createMemoryStore({ products = [], codes = [] } = {}) {
  const bySku = new Map(products.map(product => [product.sku, product]));
  const byCode = new Map(codes.map(code => [code.code, code]));
  const orders = new Map();
  return {
    products: { all: () => [...bySku.values()], get: sku => bySku.get(sku) },
    codes: { get: code => byCode.get(code) },
    orders: { save: order => { orders.set(order.id, order); }, get: id => orders.get(id), all: () => [...orders.values()] },
  };
}
