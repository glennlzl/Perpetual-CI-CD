import { HttpError } from '../util/assert.js';
import { refused } from './respond.js';

const segments = path => String(path).split('?')[0].split('/').filter(Boolean);

/**
 * The router over routes such as 'GET /orders/:id': handle({ method, path, body }) runs the route's handler with its
 * params and body and returns its { status, body }. A handler's HttpError becomes that status with { error }.
 */
export function createRouter(routes) {
  const table = Object.entries(routes).map(([route, handler]) => {
    const [method, pattern] = route.split(' ');
    return { method, parts: segments(pattern), handler };
  });
  return function handle({ method, path, body = null }) {
    const parts = segments(path);
    const matching = table.filter(route => route.parts.length === parts.length && route.parts.every((part, index) => part.startsWith(':') || part === parts[index]));
    const route = matching.find(item => item.method === method);
    if (!route) return matching.length ? refused(405, `${method} is not allowed on ${path}.`) : refused(404, `No route for ${path}.`);
    const params = Object.fromEntries(route.parts.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1), decodeURIComponent(parts[index])]] : []));
    try {
      return route.handler({ params, body });
    } catch (error) {
      if (error instanceof HttpError) return refused(error.status, error.message);
      throw error;
    }
  };
}
