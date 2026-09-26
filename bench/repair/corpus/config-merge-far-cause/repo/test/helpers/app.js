import { createApp } from '../../src/app.js';

/** A fresh app on the test configuration, and request(method, path, body) through its router. */
export function testApp() {
  const app = createApp({ env: 'test', variables: {}, now: '2026-01-05T09:30:00.000Z' });
  return { app, request: (method, path, body) => app.handle({ method, path, body }) };
}
