import { ok } from '../respond.js';

/** GET /products lists the catalog; GET /products/:sku reads one product. */
export const catalogRoutes = ({ catalog }) => ({
  'GET /products': () => ok({ products: catalog.list() }),
  'GET /products/:sku': ({ params }) => ok({ product: catalog.get(params.sku) }),
});
