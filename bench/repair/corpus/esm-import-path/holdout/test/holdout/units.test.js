import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatSize, summarize } from '../../src/index.js';

test('holdout: formatBytes stays exported as the decimal formatter', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2000000), '2 MB');
});

test('holdout: formatSize is exported, with binary units', () => {
  assert.equal(formatSize(1536, { binary: true }), '1.5 KiB');
  assert.equal(formatSize(1536), '1.5 KB');
});

test('holdout: summaries of larger files', () => {
  assert.equal(summarize([{ name: 'a', bytes: 1000000 }, { name: 'b', bytes: 1000000 }, { name: 'c', bytes: 1000000 }]), '3 files, 3 MB');
});
