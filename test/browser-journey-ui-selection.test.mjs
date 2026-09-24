import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RUN_CASES, oneOffSelection, rememberOneOffRun, restoreSelection, settleOneOffRun } from '../client/src/lib/run-selection.js';

const reviewed = (id, selected = false) => ({ id, name:id, selected, needsReview:false });
const active = run => ['queued', 'running'].includes(run.status);

test('a one-off run selects only its own unselected case', () => {
  const cases = [reviewed('a', true), reviewed('b'), reviewed('c')];
  const { added, cases: next, error } = oneOffSelection(cases, ['b']);
  assert.equal(error, undefined);
  assert.deepEqual(added, ['b']);
  assert.deepEqual(next.map(item => item.selected), [true, true, false]);
  assert.deepEqual(oneOffSelection(cases, ['a']), { added:[], cases });
});
test('a one-off run never pushes the saved selection past the run limit', () => {
  const full = Array.from({ length:MAX_RUN_CASES }, (_, index) => reviewed(`s${index}`, true));
  const cases = [...full, reviewed('extra')];
  const result = oneOffSelection(cases, ['extra']);
  assert.equal(result.error, 'Deselect a test to run this one.');
  assert.equal(result.cases, cases);
  assert.equal(oneOffSelection(cases, ['s0']).error, undefined);
  assert.equal(oneOffSelection(cases.slice(1), ['extra']).cases.filter(item => item.selected).length, MAX_RUN_CASES);
});
test('restoring deselects only the cases the run added', () => {
  const cases = [reviewed('a', true), reviewed('b', true)];
  assert.deepEqual(restoreSelection(cases, ['b']).map(item => item.selected), [true, false]);
  assert.equal(restoreSelection([reviewed('a', true), reviewed('b')], ['b']), null);
});
test('the saved selection returns only after the one-off run leaves the queue', () => {
  const store = new Map();
  const cases = [reviewed('a', true), reviewed('b', true)];
  rememberOneOffRun('/repo', 'beta', 'run-1', ['b'], store);
  rememberOneOffRun('/repo', 'gamma', 'run-2', [], store);
  assert.equal(store.size, 1);
  assert.equal(settleOneOffRun('/repo', 'beta', { cases, runs:[{ id:'run-1', status:'running' }], active }, store), null);
  assert.equal(settleOneOffRun('/repo', 'gamma', { cases, runs:[], active }, store), null);
  const restored = settleOneOffRun('/repo', 'beta', { cases, runs:[{ id:'run-1', status:'failed' }], active }, store);
  assert.deepEqual(restored.map(item => item.selected), [true, false]);
  assert.equal(store.size, 0);
  assert.equal(settleOneOffRun('/repo', 'beta', { cases, runs:[], active }, store), null);
});
test('a one-off run the user already deselected is forgotten without a save', () => {
  const store = new Map();
  rememberOneOffRun('/repo', 'beta', 'run-1', ['b'], store);
  assert.equal(settleOneOffRun('/repo', 'beta', { cases:[reviewed('b')], runs:[], active }, store), null);
  assert.equal(store.size, 0);
});
