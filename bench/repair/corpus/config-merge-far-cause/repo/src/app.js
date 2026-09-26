import { loadConfig } from './config/load.js';
import { catalogRoutes } from './http/handlers/catalog.js';
import { healthRoutes } from './http/handlers/health.js';
import { orderRoutes } from './http/handlers/orders.js';
import { quoteRoutes } from './http/handlers/quotes.js';
import { createRouter } from './http/router.js';
import { createCatalog } from './services/catalog.js';
import { createOrders } from './services/orders.js';
import { createQuotes } from './services/quotes.js';
import { createMemoryStore } from './store/memory.js';
import { SEED } from './store/seed.js';
import { createClock } from './util/clock.js';
import { createIds } from './util/ids.js';

/**
 * The order service: its configuration (loadConfig's env and variables), a store seeded with the catalog, and
 * handle(request), the router src/server.js serves over HTTP. now fixes the clock.
 */
export function createApp({ env, variables, now } = {}) {
  const config = loadConfig({ env, variables });
  const store = createMemoryStore(SEED);
  const catalog = createCatalog(store);
  const quotes = createQuotes({ config, catalog, store });
  const orders = createOrders({ quotes, store, clock: createClock(now), ids: createIds() });
  const services = { config, catalog, quotes, orders };
  const handle = createRouter({ ...healthRoutes(services), ...catalogRoutes(services), ...quoteRoutes(services), ...orderRoutes(services) });
  return { config, handle };
}
