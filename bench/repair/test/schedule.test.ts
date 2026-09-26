// The matrix and its scheduling: a deterministic interleaved order, resume by key, and a bounded worker pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, matrix, pool, prng, remaining } from '../schedule.ts';

const shape = { frameworks: ['aisdk', 'pi', 'opencode'], models: ['m/a', 'm/b'], cases: ['c1', 'c2', 'c3', 'c4'], seeds: 3 };

test('the matrix holds every cell once, seed by seed, each (case, model) block with every framework, in a fixed shuffled order', () => {
  const cells = matrix(shape);
  assert.equal(cells.length, 3 * 2 * 4 * 3);
  assert.equal(new Set(cells.map(cell => cell.key)).size, cells.length);
  assert.deepEqual(cells, matrix(shape), 'The order is the same on every run.');
  assert.deepEqual(cells.map(cell => cell.seed), [...Array(24).fill(1), ...Array(24).fill(2), ...Array(24).fill(3)]);
  for (let index = 0; index < cells.length; index += 3) {
    const block = cells.slice(index, index + 3);
    assert.equal(new Set(block.map(cell => `${cell.case}|${cell.model}`)).size, 1);
    assert.deepEqual(block.map(cell => cell.framework).sort(), ['aisdk', 'opencode', 'pi']);
  }
  const firsts = new Set(cells.filter((_, index) => index % 3 === 0).map(cell => cell.framework));
  assert.ok(firsts.size > 1, 'No framework always goes first.');
  assert.notDeepEqual(cells.slice(0, 24).map(cell => `${cell.case}|${cell.model}`), cells.slice(24, 48).map(cell => `${cell.case}|${cell.model}`), 'Each seed shuffles anew.');
  assert.equal(cellKey({ framework: 'pi', model: 'm/a', case: 'c1', seed: 2 }), 'pi|m/a|c1|2');
});

test('resume skips cells already recorded', () => {
  const cells = matrix({ ...shape, seeds: 1 });
  assert.deepEqual(remaining(cells, new Set([cells[0].key, cells[5].key])).length, cells.length - 2);
});

test('the PRNG is deterministic in [0, 1)', () => {
  const a = prng(42), b = prng(42), values = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(values.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(values.every(value => value >= 0 && value < 1));
});

test('the pool runs at most its concurrency and stops starting work once stopped', async () => {
  let active = 0, peak = 0;
  const seen: number[] = [];
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async item => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); seen.push(item); active -= 1; });
  assert.deepEqual([peak, seen.sort()], [3, [1, 2, 3, 4, 5, 6, 7]]);
  const stop = new AbortController(), started: number[] = [];
  await pool([1, 2, 3, 4], 1, async item => { started.push(item); if (item === 2) stop.abort(); }, stop.signal);
  assert.deepEqual(started, [1, 2]);
  const finished: number[] = [];
  await assert.rejects(pool([1, 2, 3, 4, 5], 2, async item => {
    if (item === 1) throw new Error('box failed');
    await new Promise(resolve => setTimeout(resolve, 10)); finished.push(item);
  }), /box failed/);
  assert.deepEqual(finished, [2], 'Work in flight finishes before the failure is thrown, and nothing more starts.');
});
