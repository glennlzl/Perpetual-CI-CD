import test from 'node:test';
import assert from 'node:assert/strict';
import { fromEnvironment } from '../../src/config/env.js';

test('APP_ variables set settings two levels deep', () => {
  assert.deepEqual(fromEnvironment({ APP_SERVER__PORT: '8080', APP_ORDERS__MAX_LINES: '5', HOME: '/root' }), { server: { port: 8080 }, orders: { maxLines: 5 } });
});

test('values are parsed as booleans and numbers, or kept as text', () => {
  assert.deepEqual(fromEnvironment({ APP_SERVER__HOST: 'localhost', APP_SERVER__PORT: '0', APP_FEATURES__QUOTES: 'false' }), { server: { host: 'localhost', port: 0 }, features: { quotes: false } });
});
