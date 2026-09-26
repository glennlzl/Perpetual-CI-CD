// The whole pipeline at $0, only with BENCH_DOCKER=1: `run --dry-run` for the baseline on one case prepares the case,
// runs the attempt through the forked gateway, judges it, records it without any key, and a second run resumes with
// nothing left to do. BENCH_CASES widens it (all for the whole corpus). Its boxes are removed by the run and the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeBenchResources } from '../box.ts';
import { FAKE_KEY } from '../fake-upstream.ts';
import { LIMITS } from '../harness.ts';
import { resultPaths } from '../results.ts';
import { runBench } from '../run.ts';

const skip = process.env.BENCH_DOCKER !== '1' && 'Set BENCH_DOCKER=1 to run bench boxes in Docker.';

async function allText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files = entries.filter(entry => entry.isFile() && !entry.parentPath.includes('/cases/') && !entry.parentPath.includes('/snapshot'));
  return (await Promise.all(files.map(entry => readFile(join(entry.parentPath, entry.name), 'utf8')))).join('\n');
}

test('a dry run solves the case at $0, records no key, and resumes with nothing left', { skip, timeout: 30 * 60_000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'bench-run-')), lines: string[] = [];
  t.after(async () => {
    const scopes = JSON.parse(await readFile(resultPaths(out).boxes, 'utf8').catch(() => '[]')) as string[];
    await removeBenchResources(scopes).catch(() => {});
    await rm(out, { recursive: true, force: true });
  });
  const cases = process.env.BENCH_CASES === 'all' ? 'all' as const : (process.env.BENCH_CASES ?? 'logic-tier-boundary').split(',');
  const options = { frameworks: ['aisdk' as const], models: ['fake/coder'], cases, seeds: 1, concurrency: 3, budget: 1, limits: LIMITS, reasoning: 'default' as const, out, dryRun: true, log: (line: string) => { lines.push(line); } };
  const first = await runBench(options);
  const judged = first.records.filter(record => record.status === 'judged');
  assert.ok(judged.length >= 1);
  assert.deepEqual(judged.filter(record => !record.success).map(record => `${record.case}: ${record.reason} ${record.judge?.reason} ${record.judge?.detail}`), []);
  assert.ok(judged.every(record => record.gateway!.requests === 4 && record.gateway!.cost > 0 && record.frameworkVersion.startsWith('ai@')));
  assert.match(first.report, /\| aisdk · fake\/coder \| (\d+)\/\1 \(100%\)/);
  assert.ok(!(await allText(out)).includes(FAKE_KEY), 'No file of the run holds the key.');
  const second = await runBench({ ...options, log: (line: string) => { lines.push(line); } });
  assert.equal(second.records.length, first.records.length);
  assert.ok(lines.some(line => /^0 of \d+ attempts to run/.test(line)), 'The second run resumes with nothing to do.');
});

test('once spending leaves no room for another cap, the rest of the run is recorded as skipped for the budget', { skip, timeout: 30 * 60_000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'bench-run-'));
  t.after(async () => {
    await removeBenchResources(JSON.parse(await readFile(resultPaths(out).boxes, 'utf8').catch(() => '[]')) as string[]).catch(() => {});
    await rm(out, { recursive: true, force: true });
  });
  // Each dry-run attempt costs $0.008: after the first, $0.008 + a $0.5 cap no longer fits a $0.5 budget.
  const { records, report } = await runBench({ frameworks: ['aisdk'], models: ['fake/coder'], cases: ['logic-tier-boundary', 'test-trap'], seeds: 1, concurrency: 1, budget: 0.5,
    limits: LIMITS, reasoning: 'default', out, dryRun: true, log: () => {} });
  assert.deepEqual(records.map(record => [record.status, record.skipped ?? null]), [['judged', null], ['skipped', 'budget']]);
  assert.match(report, /1 attempts over 1 cases, \$0\.0080 spent; 1 skipped \(budget 1\)\./);
});
