import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubRequest } from '../github-runs.mjs';
import { SHA } from './rules.mjs';

const exec = promisify(execFile);
const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/i;
const STATES = new Set(['pending', 'success', 'failure', 'error']);
const TEXT = /^[^\u0000-\u001f\u007f]{1,140}$/u;
const repository = value => {
  if (typeof value !== 'string' || !REPOSITORY.test(value) || ['.', '..'].includes(value.split('/')[1])) throw new Error('Connect a GitHub repository.');
  return value;
};

/** The branch head, read conditionally: an unchanged head costs a 304 and no rate limit. */
export async function readBranchHead({ repository: name, branch, etag = null }, { request = githubRequest } = {}) {
  const endpoint = `repos/${repository(name)}/branches/${encodeURIComponent(branch)}`;
  let response;
  try { response = await request(endpoint, etag); }
  catch { throw new Error(`Could not read ${branch} from GitHub.`); }
  if (response.status === 304) return { status: 304 };
  const sha = response.data?.commit?.sha;
  if (response.status !== 200 || typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`GitHub returned no commit for ${branch}.`);
  return { status: 200, sha: sha.toLowerCase(), etag: response.etag || null };
}

function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.GH_DEBUG; delete env.GH_FORCE_TTY;
  return { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' };
}

// Raw CLI output can contain credential material; return fixed messages only.
function statusFailure(error) {
  const detail = String(error.stderr || error.message || '').toLowerCase();
  if (error.code === 'ENOENT') return new Error('GitHub CLI is unavailable. Install gh, then run gh auth login --hostname github.com.');
  if (error.killed || error.code === 'ETIMEDOUT') return new Error('Reporting the commit status timed out.');
  if (/rate limit|secondary rate/.test(detail)) return new Error('GitHub has temporarily limited requests.');
  if (/http 401|bad credentials|gh auth login|not logged/.test(detail)) return new Error('Sign in with gh auth login --hostname github.com, then reconnect GitHub.');
  if (/http 403|http 404|saml|sso|resource not accessible/.test(detail)) return new Error('GitHub denied the commit status. Check write access to this repository.');
  return new Error('Reporting the commit status failed.');
}

/** Sets a commit status through the signed-in GitHub CLI session. */
export async function postCommitStatus({ repository: name, sha, state, context, description }, { run = exec } = {}) {
  if (typeof sha !== 'string' || !SHA.test(sha) || !STATES.has(state) || !TEXT.test(context || '') || !TEXT.test(description || '')) throw new Error('Invalid commit status.');
  const args = ['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'Accept: application/vnd.github+json',
    `repos/${repository(name)}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`];
  try { await run('gh', args, { timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true, env: environment() }); }
  catch (error) { throw statusFailure(error); }
}
