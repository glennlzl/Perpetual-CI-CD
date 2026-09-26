import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/load.js';
import { deepMerge } from '../../src/util/deep-merge.js';

test('holdout: nested objects merge at every depth and keep their siblings', () => {
  assert.deepEqual(deepMerge({ a: { b: { c: 1, d: 2 }, e: 3 } }, { a: { b: { c: 4 } } }), { a: { b: { c: 4, d: 2 }, e: 3 } });
  assert.deepEqual(deepMerge({ w: { x: { y: { z: 1, k: 'keep' } } } }, { w: { x: { y: { z: 2 }, v: true } } }), { w: { x: { y: { z: 2, k: 'keep' }, v: true } } });
});

test('holdout: later layers win, arrays replace and null overrides at any depth', () => {
  assert.deepEqual(deepMerge({ a: { b: { list: [1, 2, 3], n: 1 } } }, { a: { b: { list: [9] } } }, { a: { b: { n: null } } }), { a: { b: { list: [9], n: null } } });
  assert.deepEqual(deepMerge({ a: { b: { c: { d: 1 } } } }, { a: { b: { c: 'flat' } } }), { a: { b: { c: 'flat' } } });
  assert.deepEqual(deepMerge({ a: { b: 'flat' } }, { a: { b: { c: 1 } } }), { a: { b: { c: 1 } } });
});

test('holdout: merging changes no layer and gives the same result every time', () => {
  const base = { r: { s: { t: 1, u: [1] } } }, over = { r: { s: { t: 2 } } };
  const copies = structuredClone([base, over]);
  const first = deepMerge(base, over), second = deepMerge(base, over);
  assert.deepEqual([base, over], copies);
  assert.deepEqual(first, { r: { s: { t: 2, u: [1] } } });
  assert.deepEqual(second, first);
});

test('holdout: the test layer changes only the US flat shipping charge', () => {
  const { regions } = loadConfig({ env: 'test', variables: {} });
  assert.deepEqual(regions.us, { currency: 'USD', tax: { rate: 0.08, shipping: false }, shipping: { flat: 0, freeFrom: 5000 } });
  assert.deepEqual(regions.eu, { currency: 'EUR', tax: { rate: 0.2, shipping: true }, shipping: { flat: 900, freeFrom: 10000 } });
});

test('holdout: an APP_ variable changes one nested setting', () => {
  const { regions, server } = loadConfig({ env: 'test', variables: { APP_REGIONS__US__TAX__RATE: '0.1', APP_REGIONS__HK__SHIPPING__FREE_FROM: '30000' } });
  assert.deepEqual(regions.us, { currency: 'USD', tax: { rate: 0.1, shipping: false }, shipping: { flat: 0, freeFrom: 5000 } });
  assert.deepEqual(regions.hk, { currency: 'HKD', shipping: { flat: 1500, freeFrom: 30000 } });
  assert.equal(server.port, 0);
});
