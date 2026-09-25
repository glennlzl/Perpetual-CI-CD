// GitHub Actions status for the current commit, read through /api/github/runs.
// A run for another commit never verifies the current source.
import type { Controller } from './api.ts';
import type { PageVisibility, Timers } from './utils.ts';

export interface GitHubStep { number?: number; name: string; status: string; conclusion?: string | null }
export interface GitHubJob { id?: string | number; name: string; status: string; conclusion?: string | null; steps?: GitHubStep[] | null }
export interface GitHubRun { id: string | number; name?: string; path?: string | null; event?: string; status: string; conclusion?: string | null; attempt?: number; sha?: string; jobs?: GitHubJob[] | null }
/** GET /api/github/runs: the repository's workflow runs for one commit. */
export interface GitHubRuns { repository?: string; sha?: string; runs?: GitHubRun[] }
export type GitHubMark = 'running' | 'queued' | 'waiting' | 'failed' | 'cancelled' | 'passed' | 'skipped';
/** The Build & Deploy status for the current commit. */
export interface BuildSummary { status: GitHubMark; sha: string }

const STATUS_MARKS: Record<string, GitHubMark> = { requested: 'queued', pending: 'queued', queued: 'queued', waiting: 'waiting', in_progress: 'running' };
const CONCLUSION_MARKS: Record<string, GitHubMark> = { success: 'passed', neutral: 'passed', failure: 'failed', timed_out: 'failed', startup_failure: 'failed', cancelled: 'cancelled', stale: 'cancelled', skipped: 'skipped', action_required: 'waiting' };
const PRIORITY: GitHubMark[] = ['running', 'queued', 'waiting', 'failed', 'cancelled', 'passed', 'skipped'];
export const GITHUB_MARK_LABELS: Record<GitHubMark, string> = { running: 'Running', queued: 'Queued', waiting: 'Waiting', failed: 'Failed', cancelled: 'Cancelled', passed: 'Passed', skipped: 'Skipped' };

export const githubMark = (item: { status: string; conclusion?: string | null } | null | undefined): GitHubMark | null => !item ? null : item.status === 'completed' ? CONCLUSION_MARKS[String(item.conclusion)] || null : STATUS_MARKS[item.status] || null;
export function combinedMark(marks: (GitHubMark | null)[]) {
  const present = new Set(marks);
  return PRIORITY.find(mark => present.has(mark)) || null;
}

const workflowPath = (value: unknown) => String(value || '').replace(/@.*$/, '');
// The rail lists the scanned .github/workflows files only. Dynamic runs such as
// Pages, CodeQL default setup or Dependabot have no row, so they never set the
// Build & Deploy status, its inbound flow, or the GitHub pulse.
function railRuns(result: GitHubRuns | null | undefined, workflows: string[] | undefined) {
  const listed = new Set(workflows || []);
  return (result?.runs || []).filter(run => { const path = workflowPath(run.path); return Boolean(path) && listed.has(path); });
}

export function githubBuildSummary(result: GitHubRuns | null | undefined, sha: string | null | undefined, workflows?: string[]): BuildSummary | null {
  if (!result || !sha || result.sha !== sha) return null;
  const status = combinedMark(railRuns(result, workflows).map(githubMark));
  return status ? { status, sha: sha.slice(0, 7) } : null;
}
export const githubRunsActive = (result: GitHubRuns | null | undefined, workflows?: string[]) => railRuns(result, workflows).some(run => ['queued', 'running'].includes(String(githubMark(run))));

export const workflowRuns = (result: GitHubRuns | null | undefined, file: string) => (result?.runs || []).filter(run => workflowPath(run.path) === file);
export const workflowMark = (result: GitHubRuns | null | undefined, file: string) => combinedMark(workflowRuns(result, file).map(githubMark));
// Matrix jobs append their values, and reusable workflow jobs prefix their caller.
export const jobRuns = (runs: Pick<GitHubRun, 'jobs'>[] | null | undefined, job: { id: string; name: string }) => (runs || []).flatMap(run => run.jobs || []).filter(item => [job.name, job.id].includes(item.name) || item.name.startsWith(`${job.name} (`) || item.name.startsWith(`${job.name} / `));
export const jobMark = (runs: Pick<GitHubRun, 'jobs'>[] | null | undefined, job: { id: string; name: string }) => combinedMark(jobRuns(runs, job).map(githubMark));
export const stepMark = (jobs: Pick<GitHubJob, 'steps'>[] | null | undefined, step: { name: string }) => combinedMark((jobs || []).flatMap(job => job.steps || []).filter(item => item.name === step.name || item.name === `Run ${step.name}`).map(githubMark));

// Rail labels for scanned names. An unnamed `uses:` step keeps its action and a
// short ref; an unevaluated expression leaves its base name and context. Matching
// above still uses the original name.
const ACTION_REF = /^([\w.-]+\/[\w./-]+|docker:\/\/[\w./:-]+)@([\w./:-]+)$/;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;
const CONTEXT = /(?<![\w.])(matrix|inputs|github|env|vars|needs|steps|jobs|job|runner|strategy|secrets)\s*[.[]/g;
export function actionLabel(value: unknown, fallback = ''): { text: string; ref: string | null; contexts: string[] } {
  const name = String(value ?? '');
  const action = name.match(ACTION_REF);
  if (action) return { text: action[1], ref: action[2].match(/^(?:sha256:)?([0-9a-f]{40}|[0-9a-f]{64})$/i)?.[1].slice(0, 7) || action[2], contexts: [] };
  const expressions = name.match(EXPRESSION);
  if (!expressions) return { text: name || fallback, ref: null, contexts: [] };
  const contexts = [...new Set(expressions.flatMap(expression => [...expression.matchAll(CONTEXT)].map(match => match[1])))];
  const text = name.replace(EXPRESSION, '\0')
    .replace(/\s*[([][^()[\]]*\0[^()[\]]*[)\]]/g, '')
    .replace(/\s+(?:on|for|with|to|using|via)\s*(?=\0)/gi, ' ')
    .replaceAll('\0', ' ').replace(/\s+/g, ' ')
    .replace(/^[\s:/|,·–—-]+|[\s:/|,·–—-]+$/g, '');
  return { text: text || fallback, ref: null, contexts: contexts.length ? contexts : ['expression'] };
}
export const actionText = (value: unknown, fallback?: string) => { const { text, ref, contexts } = actionLabel(value, fallback); return [text, ref, contexts.length ? `(${contexts.join(', ')})` : ''].filter(Boolean).join(' '); };

export function createGitHubRunsPoller({ controller, repoPath, workflows = [], onChange, document = globalThis.document, timers = globalThis, activeDelay = 5000, idleDelay = 60000 }: { controller: Controller; repoPath: string; workflows?: string[]; onChange: (result: GitHubRuns | null) => void; document?: PageVisibility | null; timers?: Timers; activeDelay?: number; idleDelay?: number }) {
  let timer: unknown, stopped = false, loading = false, current: GitHubRuns | null = null, key: string | undefined;
  const schedule = () => {
    timers.clearTimeout(timer);
    if (!stopped && !document?.hidden) timer = timers.setTimeout(poll, githubRunsActive(current, workflows) ? activeDelay : idleDelay);
  };
  async function poll() {
    if (stopped || loading || document?.hidden) return;
    loading = true;
    let next: GitHubRuns | null = null;
    try { next = await controller(`/api/github/runs?${new URLSearchParams({ repoPath })}`) as GitHubRuns; } catch { next = null; }
    loading = false;
    if (stopped) return;
    const nextKey = JSON.stringify(next);
    if (nextKey !== key) { key = nextKey; current = next; onChange(next); }
    schedule();
  }
  const visibility = () => { if (!document?.hidden && !stopped) { timers.clearTimeout(timer); void poll(); } };
  document?.addEventListener?.('visibilitychange', visibility);
  if (!document?.hidden) void poll();
  return { stop() { stopped = true; timers.clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); } };
}
