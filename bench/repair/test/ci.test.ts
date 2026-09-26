// A case's CI without Docker: the workflow read as unknown, steps named as GitHub names them, the command a runner's
// bash runs, and a captured failure turned into the product's GitHubFailure through a fake gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFailure, failedLog, fakeGh, stepCommand, stepName, workflowJob, type StepRun } from '../ci.ts';

const WORKFLOW = `name: CI
on: [push, pull_request]
env:
  FORCE_COLOR: 0
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Build
        run: npm run build
      - run: |
          npm test
          echo done
        working-directory: app
        env:
          CI_SHARD: 1
`;

test('a workflow\'s one job yields its run steps, named as GitHub names them, with env and working directory', () => {
  const job = workflowJob(WORKFLOW);
  assert.deepEqual([job.id, job.name], ['test', 'test']);
  assert.deepEqual(job.steps.map(step => step.name), ['Run npm ci', 'Build', 'Run npm test']);
  assert.deepEqual(job.steps[2], { name: 'Run npm test', run: 'npm test\necho done\n', workingDirectory: 'app', env: { FORCE_COLOR: '0', CI_SHARD: '1' } });
  assert.equal(stepName(null, '  npm   test  \nmore'), 'Run npm   test');
  assert.deepEqual(stepCommand(job.steps[2]), ['env', 'FORCE_COLOR=0', 'CI_SHARD=1', 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', "exec 2>&1\ncd 'app'\nnpm test\necho done\n"]);
  assert.throws(() => workflowJob('jobs: { a: { steps: [] }, b: { steps: [] } }'), /exactly one job/);
  assert.throws(() => workflowJob('jobs: { a: { steps: [{ uses: x }] } }'), /runs nothing/);
});

test('a failed step becomes the product\'s GitHubFailure: jobs, --log-failed lines, redaction and diagnosis', async () => {
  const job = workflowJob(WORKFLOW);
  const runs: StepRun[] = [{ name: 'Run npm ci', exit: 0, ms: 1, timedOut: false, output: 'added 1 package\n' },
    { name: 'Build', exit: 2, ms: 1, timedOut: false, output: "> tsc -p tsconfig.json\nsrc/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nnpm error Lifecycle script `build` failed\nOPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef\n" }];
  assert.equal(failedLog('test', 'Build', 'a\nb\n'), 'test\tBuild\t2026-01-01T00:00:00.0000000Z a\ntest\tBuild\t2026-01-01T00:00:00.0000000Z b');
  const gh = fakeGh({ job, steps: job.steps, runs });
  const jobs = JSON.parse((await gh('gh', ['api', 'repos/acme/app/actions/runs/1/jobs'], {} as never)).stdout) as { jobs: { steps: { name: string; conclusion: string }[] }[] };
  assert.deepEqual(jobs.jobs[0].steps.map(step => step.conclusion), ['success', 'failure', 'skipped']);
  const failure = await captureFailure({ repository: 'acme/app', job, steps: job.steps, runs });
  assert.deepEqual(failure.jobs, [{ id: '1', name: 'test', conclusion: 'failure', failedSteps: ['Build'] }]);
  assert.match(failure.log, /^src\/a\.ts\(1,7\): error TS2322/m);
  assert.ok(!failure.tail.includes('sk-or-v1-0123'), 'The product\'s redaction applies.');
  assert.equal(failure.diagnosis.category, 'build');
});
