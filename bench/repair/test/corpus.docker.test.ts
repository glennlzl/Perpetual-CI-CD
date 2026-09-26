// The corpus self-check in real boxes, only with BENCH_DOCKER=1 (BENCH_CASES narrows it): each case fails at its step
// with its log and diagnosis, triage repairs it, its reference patch passes the judge and each decoy fails as stated.
// Its containers and networks are labelled perpetual.owner=repair-bench and removed by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeBenchResources, useBenchDocker } from '../box.ts';
import { loadCases } from '../corpus.ts';
import { checkCorpus } from '../selfcheck.ts';

const skip = process.env.BENCH_DOCKER !== '1' && 'Set BENCH_DOCKER=1 to self-check the corpus in Docker.';

test('every case fails as stated, its reference patch passes and its decoys fail', { skip, timeout: 60 * 60_000 }, async t => {
  await useBenchDocker();
  const directory = await mkdtemp(join(tmpdir(), 'bench-corpus-')), scopes: string[] = [];
  t.after(async () => { await removeBenchResources(scopes).catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const cases = await loadCases(process.env.BENCH_CASES && process.env.BENCH_CASES !== 'all' ? process.env.BENCH_CASES.split(',') : 'all');
  const checks = await checkCorpus(cases, { directory, root: join(directory, 'boxes'), concurrency: 3, onScope: scope => { scopes.push(scope); },
    log: check => t.diagnostic(`${check.case}: ${check.ok ? 'ok' : check.problems.join(' | ')} (failed at ${check.failedAt}, ${check.diagnosis}; reference ${check.reference.reason} in ${Math.round(check.reference.ms / 1000)}s; decoys ${check.decoys.map(decoy => `${decoy.patch}=${decoy.reason}`).join(', ') || 'none'})`) });
  assert.deepEqual(checks.filter(check => !check.ok).map(check => ({ case: check.case, problems: check.problems })), []);
  assert.equal(checks.length, cases.length);
});
