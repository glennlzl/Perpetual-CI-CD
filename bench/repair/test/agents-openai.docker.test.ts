// The agents-openai smoke test in real boxes, only with BENCH_DOCKER=1 and the adapter's packages installed: on
// logic-tier-boundary the dry-run solver, behind a fake Responses endpoint in the gateway's place, drives the Agents
// SDK's loop, whose product tools run in a bench box; the box's diff then passes the judge in a new box. Its containers
// and networks are labelled perpetual.owner=repair-bench and removed by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResponses, solverReplies } from '../adapters/agents-openai/fake-responses.ts';
import { adapter } from '../adapters/agents-openai/index.ts';
import { createBenchBox, removeBenchResources, useBenchDocker } from '../box.ts';
import { prepareCase } from '../context.ts';
import { loadCases } from '../corpus.ts';
import { corpusSolutions, solver } from '../fake-upstream.ts';
import { LIMITS } from '../harness.ts';
import { judge } from '../judge.ts';

const TOKEN = 'bench-smoke-token';
const skip = process.env.BENCH_DOCKER !== '1' ? 'Set BENCH_DOCKER=1 to run bench boxes in Docker.' : await adapter.available() ?? false;

test('agents-openai repairs logic-tier-boundary in a bench box over the Responses API, and the judge passes its diff', { skip, timeout: 15 * 60_000 }, async t => {
  await useBenchDocker();
  const directory = await mkdtemp(join(tmpdir(), 'bench-agents-openai-')), root = join(directory, 'boxes'), scopes: string[] = [];
  const onScope = (scope: string) => { scopes.push(scope); };
  const cases = await loadCases(['logic-tier-boundary']), [c] = cases;
  const fake = await createFakeResponses({ token: TOKEN, script: solverReplies(solver(await corpusSolutions(cases))) });
  t.after(async () => { await removeBenchResources(scopes).catch(() => {}); await fake.stop(); await rm(directory, { recursive: true, force: true }); });
  const context = await prepareCase(c, { directory: join(directory, c.name), root, onScope });
  const box = await createBenchBox({ image: context.image, source: context.snapshot, root, onScope });
  let diff: Buffer;
  try {
    const outcome = await adapter.runAttempt({ box, system: context.system, prompt: context.prompt, failing: context.failing, model: { id: 'gpt-6-luna', contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
      gateway: { baseUrl: fake.url, token: TOKEN }, limits: LIMITS, signal: new AbortController().signal, scratch: directory, log: () => {} });
    assert.deepEqual([outcome.reason, outcome.steps, outcome.reproduced], ['done', 4, true], 'The failing npm test ran in the box and failed before the patch.');
    diff = await box.diff(context.sha);
  } finally { await box.remove(); }
  assert.ok(fake.received.length === 4 && fake.received.every(request => request.path === '/v1/responses' && request.authorization === `Bearer ${TOKEN}`));
  assert.match(diff.toString('utf8'), /^\+  for \(const \[min, percent\] of TIERS\) if \(subtotal >= min\) return percent;$/m);
  const judged = await judge({ c, snapshot: context.snapshot, sha: context.sha, diff, image: context.image, steps: context.job.steps, root, onScope });
  assert.deepEqual([judged.reason, judged.passed, judged.steps.map(step => step.exit)], ['passed', true, [0, 0]]);
});
