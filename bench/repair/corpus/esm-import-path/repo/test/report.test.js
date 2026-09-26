import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/index.js';

test('a summary counts files and adds their sizes', () => {
  assert.equal(summarize([{ name: 'a.txt', bytes: 1000 }, { name: 'b.txt', bytes: 500 }]), '2 files, 1.5 KB');
});

test('a single small file', () => {
  assert.equal(summarize([{ name: 'a.txt', bytes: 999 }]), '1 file, 999 B');
});
