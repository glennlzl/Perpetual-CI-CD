// Which runs a repair opens for, and what triage does with their failures, without a model.
import type { WorkflowRun } from '../github-runs.ts';
import type { GitHubFailure } from './github.ts';

type Run = Pick<WorkflowRun, 'status' | 'conclusion'>;
type BranchRun = Run & Pick<WorkflowRun, 'path' | 'branch' | 'event'>;
// The conclusions the Build rail marks failed, and those of a run that ran and passed. A skipped run ran
// nothing, and cancelled, action_required and stale runs never finished: none of them is a pass or a failure.
export const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSED = new Set(['success', 'neutral']);
// A push to the branch or a manual dispatch on it builds the branch head itself. A tag, a pull request or a schedule
// at the same commit is another ref's build, never repaired or rerun as the branch's.
const EVENTS = new Set(['push', 'workflow_dispatch']);
export const failedRun = (run: Run) => run.status === 'completed' && FAILED.has(String(run.conclusion));
export const passedRun = (run: Run) => run.status === 'completed' && PASSED.has(String(run.conclusion));
/** The branch's own workflow runs of a commit; dynamic runs such as Pages or CodeQL have no workflow file. */
export const branchRuns = <R extends BranchRun>(runs: readonly R[], branch: string) => runs.filter(run => run.path?.startsWith('.github/workflows/') && run.branch === branch && EVENTS.has(String(run.event)));
/**
 * A commit's branch runs once every one completed: the failed ones, and whether the commit passed, meaning every run
 * passed or skipped and at least one passed. Null while any is still running.
 */
export function completedRuns<R extends BranchRun>(runs: readonly R[], branch: string): { failed: R[]; passed: boolean } | null {
  const own = branchRuns(runs, branch);
  if (!own.length || own.some(run => run.status !== 'completed')) return null;
  return { failed: own.filter(failedRun), passed: own.some(passedRun) && own.every(run => passedRun(run) || run.conclusion === 'skipped') };
}

export type Triage = { next: 'needs-person'; category: string; reason: string } | { next: 'rerun' | 'repair'; category: string };
/**
 * configuration: a patch cannot grant access, so a person acts. availability: rerun the failed jobs once;
 * after that rerun failed, it goes to repair like everything else.
 */
export function triage(failures: readonly Pick<GitHubFailure, 'diagnosis'>[], rerun: boolean): Triage {
  const configuration = failures.find(item => item.diagnosis.category === 'configuration');
  if (configuration) return { next: 'needs-person', category: 'configuration', reason: configuration.diagnosis.summary };
  const categories = [...new Set(failures.map(item => item.diagnosis.category))];
  if (categories.length === 1 && categories[0] === 'availability') return { next: rerun ? 'repair' : 'rerun', category: 'availability' };
  return { next: 'repair', category: categories.find(category => category !== 'availability') ?? 'unknown' };
}
