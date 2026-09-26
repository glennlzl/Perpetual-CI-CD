import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/index.js';

test('the defaults load without overrides', () => {
  assert.deepEqual(loadConfig({ env: {} }), { server: { host: '127.0.0.1', port: 8080 }, log: { level: 'info', json: false }, features: { beta: false } });
});

test('an environment variable overrides a nested value', () => {
  assert.equal(loadConfig({ env: { APP__SERVER__PORT: '9000' } }).server.port, 9000);
});
