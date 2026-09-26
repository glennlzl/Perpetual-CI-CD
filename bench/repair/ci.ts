// A case's CI as the bench runs it: the workflow's single job, read as unknown, with its `run` steps named as GitHub
// names them (a step's name, or `Run <first line>`), run in a box as GitHub runs them (bash --noprofile --norc -eo
// pipefail, stopping at the first failure), and a failed step's output turned into the product's GitHubFailure by
// getGitHubFailure itself, through a fake gh that prints the jobs and the `--log-failed` lines GitHub would. `uses:`
// steps are skipped: the snapshot and the box image the setup action picks provide what checkout and setup-node,
// setup-python or setup-go would.
import { parse } from 'yaml';
import type { RepairBox } from '../../src/repair/box.ts';
import { getGitHubFailure, type CommandRunner, type GitHubFailure } from '../../src/repair/github.ts';

export interface CiStep { name: string; run: string; workingDirectory: string | null; env: Record<string, string> }
export interface CiJob { id: string; name: string; steps: CiStep[] }
export interface StepRun { name: string; exit: number; ms: number; timedOut: boolean; output: string }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
/** The step timeout, output bytes kept per step, and the log timestamp every line carries. */
export const STEP = { timeoutMs: 10 * 60_000, limit: 1024 * 1024 };
const STAMP = '2026-01-01T00:00:00.0000000Z';

/** A run step's name as GitHub shows it. */
export const stepName = (name: string | null, run: string) => name ?? `Run ${run.trim().split('\n')[0].trim()}`;

/** The workflow's one job and its run steps; anything else is refused. */
export function workflowJob(yaml: string): CiJob {
  const workflow: unknown = parse(yaml, { maxAliasCount: 50 });
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new Error('The workflow has no jobs.');
  const jobs = Object.entries(workflow.jobs);
  if (jobs.length !== 1 || !isRecord(jobs[0][1])) throw new Error('A corpus workflow has exactly one job.');
  const [id, job] = jobs[0] as [string, Record<string, unknown>];
  const env = (value: unknown) => Object.fromEntries(Object.entries(isRecord(value) ? value : {}).flatMap(([key, item]) => /^[A-Z_][A-Z\d_]*$/i.test(key) && scalar(item) !== null ? [[key, scalar(item)!]] : []));
  const shared = { ...env(workflow.env), ...env(job.env) };
  const steps = (Array.isArray(job.steps) ? job.steps : []).filter(isRecord).flatMap((step): CiStep[] => {
    const run = scalar(step.run);
    if (run === null) return [];
    return [{ name: stepName(scalar(step.name), run), run, workingDirectory: scalar(step['working-directory']), env: { ...shared, ...env(step.env) } }];
  });
  if (!steps.length) throw new Error('The workflow runs nothing.');
  return { id, name: scalar(job.name) ?? id, steps };
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** A step's command in the box, as a runner's bash runs it, its stderr interleaved with stdout. */
export const stepCommand = (step: CiStep) => ['env', ...Object.entries(step.env).map(([key, value]) => `${key}=${value}`), 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c',
  `exec 2>&1\n${step.workingDirectory ? `cd ${quote(step.workingDirectory)}\n` : ''}${step.run}`];

/** Runs steps in order in the box and stops at the first that fails. */
export async function runSteps(box: Pick<RepairBox, 'exec'>, steps: readonly CiStep[], { signal, timeoutMs = STEP.timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<StepRun[]> {
  const runs: StepRun[] = [];
  for (const step of steps) {
    const started = Date.now();
    const result = await box.exec(stepCommand(step), { timeoutMs, limit: STEP.limit, keep: 'tail', signal });
    runs.push({ name: step.name, exit: result.exitCode, ms: Date.now() - started, timedOut: result.timedOut, output: result.stdout + result.stderr });
    if (result.exitCode !== 0) break;
  }
  return runs;
}

/** The failed step's output as `gh run view --log-failed` prints it: job, step and timestamp before every line. */
export const failedLog = (job: string, step: string, output: string) => output.replace(/\n$/, '').split('\n').map(line => `${job}\t${step}\t${STAMP} ${line}`).join('\n');

/** A gh that answers the two reads getGitHubFailure makes: the run's jobs, and the failed log. */
export function fakeGh({ job, steps, runs }: { job: CiJob; steps: readonly CiStep[]; runs: readonly StepRun[] }): CommandRunner {
  const failed = runs.find(run => run.exit !== 0);
  const conclusions = steps.map((step, index) => ({ name: step.name, conclusion: runs[index] ? runs[index].exit === 0 ? 'success' : 'failure' : 'skipped' }));
  const jobs = JSON.stringify({ total_count: 1, jobs: [{ id: 1, name: job.name, status: 'completed', conclusion: failed ? 'failure' : 'success', steps: conclusions }] });
  const log = failed ? failedLog(job.name, failed.name, failed.output) : '';
  return async (file, args) => {
    if (file !== 'gh') throw new Error(`Unexpected command ${file}.`);
    if (args[0] === 'api') return { stdout: jobs };
    if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) return { stdout: log };
    throw new Error(`Unexpected gh ${args[0]}.`);
  };
}

/** The product's GitHubFailure for a captured CI run: its redaction, error lines, tail and rule-based diagnosis. */
export function captureFailure({ repository, job, steps, runs }: { repository: string; job: CiJob; steps: readonly CiStep[]; runs: readonly StepRun[] }): Promise<GitHubFailure> {
  return getGitHubFailure({ repository, runId: '1' }, { run: fakeGh({ job, steps, runs }), now: () => STAMP.replace('.0000000', '') });
}
