// opencode's smoke test in real boxes, only with BENCH_DOCKER=1: on logic-tier-boundary the dry-run solver, behind the
// gateway, drives opencode running inside a bench box through the relay (fake upstream → gateway → relay → opencode),
// whose bash tool reproduces, patches and verifies in /workspace; the box's diff then passes the judge in a new box.
// It checks what the adapter could not check without Docker: that opencode reads the prompt from stdin, that Bun honours
// NO_PROXY for gateway, that only the attempt's model is asked for, and that opencode leaves nothing else in /workspace.
// The first run fetches and verifies the binaries into .cache/opencode. Its containers and networks are labelled
// perpetual.owner=repair-bench and removed by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX, adapter } from '../adapters/opencode/index.ts';
import { createBenchBox, removeBenchResources, useBenchDocker } from '../box.ts';
import { prepareCase } from '../context.ts';
import { loadCases } from '../corpus.ts';
import { FAKE_KEY, FAKE_MODELS, corpusSolutions, createFakeUpstream, solver } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { LIMITS, type AttemptEvent } from '../harness.ts';
import { judge } from '../judge.ts';

const skip = process.env.BENCH_DOCKER !== '1' && 'Set BENCH_DOCKER=1 to run bench boxes in Docker.';

test('opencode repairs logic-tier-boundary inside a bench box through the relay and the gateway, and the judge passes its diff', { skip, timeout: 20 * 60_000 }, async t => {
  await useBenchDocker();
  const directory = await mkdtemp(join(tmpdir(), 'bench-opencode-')), root = join(directory, 'boxes'), scopes: string[] = [];
  const onScope = (scope: string) => { scopes.push(scope); };
  const cases = await loadCases(['logic-tier-boundary']), [c] = cases;
  const upstream = await createFakeUpstream({ script: solver(await corpusSolutions(cases)) });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 1, upstream: upstream.url });
  t.after(async () => { await removeBenchResources(scopes).catch(() => {}); await gateway.stop(); await upstream.stop(); await rm(directory, { recursive: true, force: true }); });
  const context = await prepareCase(c, { directory: join(directory, c.name), root, onScope });
  const box = await createBenchBox({ image: context.image, source: context.snapshot, root, onScope });
  const model = { id: FAKE_MODELS[0].id, contextWindow: 200_000, maxOutput: 32_000, reasoning: true }, events: AttemptEvent[] = [];
  let diff: Buffer, status: string;
  try {
    await adapter.prepare!(box, new AbortController().signal);
    const boxUrl = `${await box.attachGateway(gateway.port)}/api/v1`;
    const opened = await gateway.open({ attempt: 'smoke', model: model.id, cap: LIMITS.cost, deadline: Date.now() + LIMITS.timeMs });
    const outcome = await adapter.runAttempt({ box, system: context.system, prompt: context.prompt, failing: context.failing, model, limits: LIMITS, signal: new AbortController().signal, scratch: directory,
      gateway: { baseUrl: gateway.url, boxUrl, token: opened!.token }, log: event => { events.push(event); } });
    const usage = await gateway.close(opened!.token);
    const trail = JSON.stringify(events.at(-1));
    assert.deepEqual([outcome.reason, outcome.reproduced, outcome.summary], ['done', true, 'Applied the fix; the failing CI commands pass now.'], trail);
    assert.ok(outcome.steps >= 4 && usage.requests >= 4 && usage.toolCalls >= 3, `The solver's reproduce, patch, verify and final message reached the gateway: ${trail}`);
    assert.deepEqual([usage.modelViolations, usage.refusals], [[], {}], 'No other model was asked for, and no request was refused.');
    assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.tool), ['bash', 'bash', 'bash'], 'opencode\'s bash tool ran the three commands.');
    status = (await box.exec(['git', 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 60_000 })).stdout;
    const config = await box.exec(['stat', '-c', '%a %U', BOX.config], { timeoutMs: 30_000 });
    assert.equal(config.stdout.trim(), '600 root', 'The config file with the token is root\'s alone.');
    diff = await box.diff(context.sha);
  } finally { await box.remove(); }
  assert.equal(status.trim(), 'M src/invoice.js', 'opencode left nothing of its own in /workspace.');
  assert.match(diff.toString('utf8'), /^\+  for \(const \[min, percent\] of TIERS\) if \(subtotal >= min\) return percent;$/m);
  const judged = await judge({ c, snapshot: context.snapshot, sha: context.sha, diff, image: context.image, steps: context.job.steps, root, onScope });
  assert.deepEqual([judged.reason, judged.passed, judged.steps.map(step => step.exit)], ['passed', true, [0, 0]]);
});
