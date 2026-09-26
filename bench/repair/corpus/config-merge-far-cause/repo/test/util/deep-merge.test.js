import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../../src/util/deep-merge.js';

test('later layers win', () => {
  assert.deepEqual(deepMerge({ port: 3000 }, { port: 8080 }, { port: 0 }), { port: 0 });
});

test('objects merge key by key', () => {
  assert.deepEqual(deepMerge({ server: { host: 'localhost', port: 3000 } }, { server: { port: 0 } }), { server: { host: 'localhost', port: 0 } });
});

test('arrays replace', () => {
  assert.deepEqual(deepMerge({ hosts: ['a', 'b'] }, { hosts: ['c'] }), { hosts: ['c'] });
});
