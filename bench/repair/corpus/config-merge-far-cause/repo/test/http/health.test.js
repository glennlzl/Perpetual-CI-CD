import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from '../helpers/app.js';

test('health lists the regions the service sells to', () => {
  const { request } = testApp();
  assert.deepEqual(request('GET', '/health'), { status: 200, body: { status: 'ok', regions: ['us', 'eu', 'hk'] } });
});

test('unknown paths are not found and other methods are not allowed', () => {
  const { request } = testApp();
  assert.equal(request('GET', '/invoices').status, 404);
  assert.equal(request('DELETE', '/orders').status, 405);
});
