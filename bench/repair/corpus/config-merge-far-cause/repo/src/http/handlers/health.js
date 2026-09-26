import { ok } from '../respond.js';

/** GET /health: the service is up, and the regions it sells to. */
export const healthRoutes = ({ config }) => ({
  'GET /health': () => ok({ status: 'ok', regions: Object.keys(config.regions) }),
});
