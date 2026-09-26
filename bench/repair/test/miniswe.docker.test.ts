// mini-swe-agent's smoke test in real boxes, only with BENCH_DOCKER=1 and a synced adapters/miniswe/.venv: on
// logic-tier-boundary the dry-run solver, behind the gateway, drives mini on the host, whose bash commands run in a
// bench box through the adapter's bridge; the box's diff then passes the judge in a new box. mini never starts a
// container of its own. The test's containers and networks are labelled perpetual.owner=repair-bench and removed by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapter } from '../adapters/miniswe/index.ts';
import { createBenchBox, docker, removeBenchResources, useBenchDocker } from '../box.ts';
import { prepareCase } from '../context.ts';
import { loadCases } from '../corpus.ts';
import { FAKE_KEY, FAKE_MODELS, corpusSolutions, createFakeUpstream, solver } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { LIMITS } from '../harness.ts';
import { judge } from '../judge.ts';

const skip = process.env.BENCH_DOCKER !== '1' && 'Set BENCH_DOCKER=1 to run bench boxes in Docker.';

test('mini-swe-agent repairs logic-tier-boundary in a bench box through the gateway, and the judge passes its diff', { skip, timeout: 15 * 60_000 }, async t => {
  const unavailable = await adapter.available();
  if (unavailable) return t.skip(unavailable);
  await useBenchDocker();
  const directory = await mkdtemp(join(tmpdir(), 'bench-miniswe-')), root = join(directory, 'boxes'), scratch = await mkdtemp(join(directory, 'scratch-')), scopes: string[] = [];
  const onScope = (scope: string) => { scopes.push(scope); };
  const cases = await loadCases(['logic-tier-boundary']), [c] = cases;
  const upstream = await createFakeUpstream({ script: solver(await corpusSolutions(cases)) });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 1, upstream: upstream.url });
  t.after(async () => { await removeBenchResources(scopes).catch(() => {}); await gateway.stop(); await upstream.stop(); await rm(directory, { recursive: true, force: true }); });
  const context = await prepareCase(c, { directory: join(directory, c.name), root, onScope });
  const box = await createBenchBox({ image: context.image, source: context.snapshot, root, onScope });
  const opened = await gateway.open({ attempt: 'smoke', model: FAKE_MODELS[0].id, cap: LIMITS.cost, deadline: Date.now() + LIMITS.timeMs });
  let diff: Buffer;
  try {
    const outcome = await adapter.runAttempt({ box, system: context.system, prompt: context.prompt, failing: context.failing, model: { id: FAKE_MODELS[0].id, contextWindow: 200_000, maxOutput: 32_000, reasoning: true },
      gateway: { baseUrl: gateway.url, token: opened!.token }, limits: LIMITS, signal: new AbortController().signal, scratch, log: () => {} });
    assert.deepEqual([outcome.reason, outcome.reproduced, outcome.summary], ['done', true, 'Applied the fix; the failing CI commands pass now.'], 'The failing CI commands ran in the box and failed before the patch.');
    diff = await box.diff(context.sha);
  } finally { await box.remove(); }
  const usage = await gateway.close(opened!.token);
  assert.deepEqual([usage.requests, usage.toolCalls], [4, 4]);
  assert.match(diff.toString('utf8'), /^\+  for \(const \[min, percent\] of TIERS\) if \(subtotal >= min\) return percent;$/m);
  const own = await docker(['ps', '-aq', '--filter', 'name=minisweagent-'], 20_000);
  assert.equal(own.stdout.trim(), '', 'mini started no container of its own.');
  const judged = await judge({ c, snapshot: context.snapshot, sha: context.sha, diff, image: context.image, steps: context.job.steps, root, onScope });
  assert.deepEqual([judged.reason, judged.passed, judged.steps.map(step => step.exit)], ['passed', true, [0, 0]]);
});
