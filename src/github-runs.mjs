import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitHubSession } from './github-source.mjs';

const exec = promisify(execFile);
const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/i;
const SHA = /^[a-f\d]{40}$/i;
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const STATUSES = new Set(['requested', 'waiting', 'pending', 'queued', 'in_progress', 'completed']);
const CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const text = (value, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : null;
const time = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
const link = value => typeof value === 'string' && value.startsWith('https://github.com/') ? value.slice(0, 500) : null;
const state = item => ({ status: STATUSES.has(item?.status) ? item.status : null, conclusion: CONCLUSIONS.has(item?.conclusion) ? item.conclusion : null });
const failure = message => Object.assign(new Error(message), { statusCode: 502 });

function remember(map, key, value, limit = 200) {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

// Read-only Actions status for one commit. A run for another commit never
// verifies the current source, so non-matching head SHAs are dropped.
export function normalizeWorkflowRuns(data, sha) {
  return (Array.isArray(data?.workflow_runs) ? data.workflow_runs : []).filter(run => Number.isSafeInteger(run?.id) && run.head_sha === sha).map(run => ({
    id: String(run.id), name: text(run.name), path: text(run.path)?.replace(/@.*$/, '') || null, event: text(run.event, 60), ...state(run),
    attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : 1, sha: run.head_sha, branch: text(run.head_branch, 255), url: link(run.html_url),
    createdAt: time(run.created_at), startedAt: time(run.run_started_at), updatedAt: time(run.updated_at), jobs: null,
  }));
}

export function normalizeWorkflowJobs(data) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).filter(job => Number.isSafeInteger(job?.id)).slice(0, 100).map(job => ({
    id: String(job.id), name: text(job.name) || '', ...state(job), startedAt: time(job.started_at), completedAt: time(job.completed_at), url: link(job.html_url),
    steps: (Array.isArray(job.steps) ? job.steps : []).slice(0, 200).map(step => ({ number: Number.isSafeInteger(step?.number) ? step.number : null, name: text(step?.name) || '', ...state(step) })),
  }));
}

export function parseGitHubResponse(stdout) {
  const separator = /\r?\n\r?\n/.exec(stdout), status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(stdout);
  if (status?.[1] === '304') return { status: 304 };
  if (!separator || !status) throw failure('GitHub CLI returned an unreadable response. Update gh and try again.');
  let data;
  try { data = JSON.parse(stdout.slice(separator.index + separator[0].length)); }
  catch { throw failure('GitHub returned an unreadable response. Try again.'); }
  const etag = stdout.slice(0, separator.index).split(/\r?\n/).find(line => /^etag:/i.test(line))?.slice(5).trim();
  return { status: Number(status[1]), etag: ENTITY_TAG.test(etag || '') ? etag : null, data };
}

function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.GH_DEBUG; delete env.GH_FORCE_TTY;
  return { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' };
}

// Raw CLI output can contain credential material; return fixed messages only.
function requestFailure(error) {
  const detail = String(error.stderr || error.message || '').toLowerCase();
  if (error.code === 'ENOENT') return failure('GitHub CLI is unavailable. Install gh, then run gh auth login --hostname github.com.');
  if (error.killed || error.code === 'ETIMEDOUT') return failure('Reading GitHub workflow runs timed out. Try again.');
  if (/rate limit|secondary rate/.test(detail)) return failure('GitHub has temporarily limited requests. Wait before trying again.');
  if (/http 401|bad credentials|gh auth login|not logged/.test(detail)) return failure('Sign in with gh auth login --hostname github.com, then reconnect GitHub.');
  if (/http 403|http 404|saml|sso/.test(detail)) return failure('GitHub denied access to workflow runs. Check repository access and Actions permissions.');
  return failure('Reading GitHub workflow runs failed. Check your network connection and try again.');
}

export async function githubRequest(endpoint, etag, { run = exec } = {}) {
  const args = ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), endpoint];
  try {
    const { stdout } = await run('gh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: environment() });
    return parseGitHubResponse(stdout);
  } catch (error) {
    // gh exits non-zero on 304; its included status line still identifies it.
    if (etag && /^HTTP\/[\d.]+ 304\b/.test(error.stdout || '')) return { status: 304 };
    throw error.statusCode ? error : requestFailure(error);
  }
}

// Every read is keyed by the connected login, so data read for one account is
// never served to another. The session is re-read on every call because gh
// always uses its active account: a cached verification would keep reading
// after gh auth switch or logout.
export function createGitHubRunsReader({ request = githubRequest, session = getGitHubSession, ttl = 4000, now = Date.now } = {}) {
  const tags = new Map(), finished = new Map(), reads = new Map();
  async function conditional(login, endpoint) {
    const tag = `${login}:${endpoint}`, cached = tags.get(tag), response = await request(endpoint, cached?.etag || null);
    if (response.status === 304 && cached) return cached.data;
    if (response.status !== 200) throw failure('GitHub returned an unexpected response. Try again.');
    if (response.etag) remember(tags, tag, { etag: response.etag, data: response.data });
    return response.data;
  }
  async function load(login, repository, sha) {
    const runs = normalizeWorkflowRuns(await conditional(login, `repos/${repository}/actions/runs?head_sha=${sha}&per_page=50`), sha);
    // Jobs of queued or running runs are re-read; a completed attempt is read once.
    await Promise.all(runs.map(async run => {
      const key = `${login}:${repository}:${run.id}:${run.attempt}:${run.updatedAt}`;
      if (run.status === 'completed' && finished.has(key)) { run.jobs = finished.get(key); return; }
      try { run.jobs = normalizeWorkflowJobs(await conditional(login, `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`)); }
      catch { run.jobs = null; return; }
      if (run.status === 'completed') remember(finished, key, run.jobs);
    }));
    return { repository, sha, runs };
  }
  return {
    session() { return session(); },
    read({ repository, sha, login }) {
      if (typeof repository !== 'string' || !REPOSITORY.test(repository) || ['.', '..'].includes(repository.split('/')[1])) return Promise.reject(new Error('Connect a GitHub repository to read workflow runs.'));
      if (typeof login !== 'string' || !login) return Promise.reject(new Error('Connect your GitHub account to read workflow runs.'));
      if (typeof sha !== 'string' || !SHA.test(sha)) return Promise.resolve({ repository, sha: null, runs: [] });
      const account = login.toLowerCase(), key = `${account}:${repository.toLowerCase()}@${sha}`, cached = reads.get(key);
      if (cached && now() - cached.at < ttl) return cached.promise.then(structuredClone);
      const promise = load(account, repository, sha);
      remember(reads, key, { at: now(), promise }, 20);
      promise.catch(() => { if (reads.get(key)?.promise === promise) reads.delete(key); });
      return promise.then(structuredClone);
    },
  };
}
