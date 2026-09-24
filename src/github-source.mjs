import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { redact } from './providers.mjs';

const exec = promisify(execFile);
const PAGE_SIZE = 100;
const API_TIMEOUT = 25_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';

class GitHubSourceError extends Error {
  constructor(message, code = 'GITHUB_SOURCE_ERROR') {
    super(redact(message));
    this.name = 'GitHubSourceError';
    this.code = code;
  }
}

function commandEnvironment() {
  const env = { ...process.env };
  // Keep gh's existing account/keychain configuration, while ignoring inherited
  // Git commands, helpers, trace output, and repository-specific environment.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  delete env.SSH_ASKPASS;
  return {
    ...env,
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: NULL_FILE,
    GIT_CONFIG_GLOBAL: NULL_FILE, GIT_ATTR_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

function commandFailure(error, executable, operation) {
  if (error instanceof GitHubSourceError) return error;
  // Raw CLI messages may include credential-bearing URLs or HTTP debug output.
  // Inspect them locally for classification, but return only fixed messages.
  const detail = String(error.stderr || error.message || '').toLowerCase();
  if (error.code === 'ENOENT') return new GitHubSourceError(
    executable === 'gh' ? 'GitHub CLI is unavailable. Install gh, then run gh auth login --hostname github.com.' : 'Git is unavailable. Install Git before connecting a repository.',
    executable === 'gh' ? 'GH_NOT_FOUND' : 'GIT_NOT_FOUND',
  );
  if (error.killed || error.code === 'ETIMEDOUT') return new GitHubSourceError(`${operation} timed out. Check your connection and try again.`, 'GITHUB_TIMEOUT');
  if (/rate limit|secondary rate/.test(detail)) return new GitHubSourceError('GitHub has temporarily limited requests. Wait before trying again.', 'GITHUB_RATE_LIMIT');
  if (/http 401|bad credentials|authentication failed|gh auth login|not logged|could not read username|could not read password/.test(detail)) {
    return new GitHubSourceError('Sign in with gh auth login --hostname github.com, then reconnect GitHub.', 'GITHUB_AUTH_REQUIRED');
  }
  if (/http 404|repository not found|couldn.t find remote ref|remote branch.*not found/.test(detail)) {
    return new GitHubSourceError('The repository or branch is unavailable to your GitHub account. Check the selection and repository access.', 'GITHUB_NOT_FOUND');
  }
  if (/http 403|permission denied|access denied|saml|sso/.test(detail)) {
    return new GitHubSourceError('GitHub denied access. Check repository permissions and any organization SSO authorization for GitHub CLI.', 'GITHUB_FORBIDDEN');
  }
  return new GitHubSourceError(`${operation} failed. Check your network connection and GitHub CLI account, then try again.`);
}

async function command(executable, args, operation, timeout = API_TIMEOUT, cwd) {
  try {
    return await exec(executable, args, {
      timeout, maxBuffer: MAX_OUTPUT, encoding: 'utf8', windowsHide: true,
      env: commandEnvironment(), ...(cwd ? { cwd } : {}),
    });
  } catch (error) { throw commandFailure(error, executable, operation); }
}

function pageNumber(value) {
  const page = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new GitHubSourceError('Choose a page between 1 and 10,000.');
  }
  return page;
}

function repositoryName(value) {
  if (typeof value !== 'string') throw new GitHubSourceError('Choose a GitHub repository in owner/repository format.');
  const repository = value.trim();
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/i.test(repository) || ['.', '..'].includes(repository.split('/')[1])) {
    throw new GitHubSourceError('Choose a GitHub repository in owner/repository format.');
  }
  return repository;
}

function branchName(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('-') || value === '@'
    || /[\s\u0000-\u001f\u007f~^:?*\[\\]/u.test(value) || value.includes('..') || value.includes('@{')
    || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new GitHubSourceError('Choose a valid Git branch name from the repository.');
  }
  return value;
}

// client/src/lib/source-selection.js mirrors these rules for the Source sheet.
export function sourceRoot(value = '/') {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new GitHubSourceError('Use a repository root such as / or /apps/web.');
  }
  const parts = value.trim().split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.' || part.toLowerCase() === '.git')) {
    throw new GitHubSourceError('The root directory must stay inside the repository and cannot include .git, . or .. segments.');
  }
  return parts.length ? `/${parts.join('/')}` : '/';
}

async function githubApi(endpoint) {
  const { stdout } = await command('gh', [
    'api', '--hostname', 'github.com', '--method', 'GET', '--include',
    '-H', 'Accept: application/vnd.github+json', endpoint,
  ], 'Reading GitHub');
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) throw new GitHubSourceError('GitHub CLI returned an unreadable response. Update gh and try again.');
  let data;
  try { data = JSON.parse(stdout.slice(separator.index + separator[0].length)); }
  catch { throw new GitHubSourceError('GitHub returned an unreadable response. Try again.'); }
  const headers = stdout.slice(0, separator.index);
  const link = headers.split(/\r?\n/).find(line => /^link:/i.test(line)) || '';
  return { data, hasNext: /;\s*rel="?next"?(?:\s*,|\s*$)/i.test(link) };
}

export async function getGitHubSession() {
  try {
    const { data } = await githubApi('user');
    if (!data || typeof data.login !== 'string') throw new GitHubSourceError('GitHub did not return an account. Sign in again with gh auth login --hostname github.com.');
    return { available: true, authenticated: true, account: { login: data.login, name: typeof data.name === 'string' ? data.name : null } };
  } catch (error) {
    return { available: error.code !== 'GH_NOT_FOUND', authenticated: false, account: null, message: redact(error.message).slice(0, 500) };
  }
}

export async function listGitHubRepositories({ page = 1 } = {}) {
  const currentPage = pageNumber(page);
  const { data, hasNext } = await githubApi(`user/repos?per_page=${PAGE_SIZE}&page=${currentPage}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`);
  if (!Array.isArray(data)) throw new GitHubSourceError('GitHub did not return a repository list. Try again.');
  const repositories = data.map(item => ({
    fullName: repositoryName(item.full_name), name: item.name,
    private: Boolean(item.private), defaultBranch: item.default_branch || null,
  }));
  return { repositories, nextPage: hasNext && currentPage < 10_000 ? currentPage + 1 : null };
}

export async function listGitHubBranches({ repository, page = 1, preferredBranch } = {}) {
  const selected = repositoryName(repository), currentPage = pageNumber(page);
  const preferred = preferredBranch == null ? null : branchName(preferredBranch);
  const [metadata, response] = await Promise.all([
    githubApi(`repos/${selected}`),
    githubApi(`repos/${selected}/branches?per_page=${PAGE_SIZE}&page=${currentPage}`),
  ]);
  if (!Array.isArray(response.data)) throw new GitHubSourceError('GitHub did not return a branch list. Try again.');
  const defaultBranch = metadata.data?.default_branch ? branchName(metadata.data.default_branch) : null;
  const names = new Set(response.data.map(item => branchName(item.name)));
  if (currentPage === 1) {
    const missing = [...new Set([defaultBranch, preferred].filter(Boolean))].filter(name => !names.has(name));
    const additional = await Promise.all(missing.map(async name => {
      try {
        const { data } = await githubApi(`repos/${selected}/branches/${encodeURIComponent(name)}`);
        return branchName(data?.name);
      } catch (error) {
        if (error.code === 'GITHUB_NOT_FOUND') return null;
        throw error;
      }
    }));
    for (const name of additional) if (name) names.add(name);
  }
  return {
    branches: [...names].map(name => ({ name })),
    nextPage: response.hasNext && currentPage < 10_000 ? currentPage + 1 : null,
    defaultBranch,
  };
}

async function managedSourcesDirectory(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) throw new GitHubSourceError('A local data directory is required to connect a repository.');
  const directory = resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new GitHubSourceError('The local data directory must not be a symbolic link.');
  const sources = join(await realpath(directory), 'sources');
  await mkdir(sources, { recursive: true, mode: 0o700 });
  const stat = await lstat(sources);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new GitHubSourceError('The managed sources directory must be a regular directory.');
  await chmod(sources, 0o700);
  return sources;
}

async function scanDirectory(checkoutPath, rootDirectory) {
  let target = checkoutPath;
  for (const part of rootDirectory.split('/').filter(Boolean)) {
    target = join(target, part);
    let stat;
    try { stat = await lstat(target); }
    catch { throw new GitHubSourceError('The selected root directory does not exist in this branch. Choose / or an existing subdirectory.'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new GitHubSourceError('The root directory must contain only regular directories, without symbolic links.');
  }
  const canonical = await realpath(target);
  const within = relative(checkoutPath, canonical);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || resolve(checkoutPath, within) !== canonical) {
    throw new GitHubSourceError('The root directory must remain inside the managed checkout.');
  }
  return canonical;
}

function gitArgs(args) {
  return [
    '-c', `core.hooksPath=${NULL_FILE}`, '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'credential.interactive=never', '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', ...args,
  ];
}

const historySyncs = new Map();
const pendingHistorySyncs = new Map();
// Git work on one managed clone runs one operation at a time, so a history sync and an in-place
// move never race for its locks or its shallow boundary.
const checkoutTurns = new Map();
function inCheckoutTurn(path, work) {
  const turn = (checkoutTurns.get(path) ?? Promise.resolve()).then(work);
  const settled = turn.catch(() => {});
  checkoutTurns.set(path, settled);
  void settled.then(() => { if (checkoutTurns.get(path) === settled) checkoutTurns.delete(path); });
  return turn;
}

async function managedHistoryCheckout(source, dataDir) {
  if (!source || typeof source !== 'object') throw new GitHubSourceError('Connect a GitHub repository before loading its history.');
  const repository = repositoryName(source.repository), branch = branchName(source.branch), root = sourceRoot(source.rootDirectory);
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')
    || typeof source.checkoutPath !== 'string' || !isAbsolute(source.checkoutPath) || source.checkoutPath.includes('\0')) {
    throw new GitHubSourceError('The managed GitHub checkout is unavailable. Reconnect the repository.');
  }
  const invalidCheckout = () => new GitHubSourceError('History can only be synced in a managed GitHub checkout. Reconnect the repository.');
  const requireDirectory = async path => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidCheckout();
  };
  try {
    // Validate without creating directories or touching the original repository.
    const directory = resolve(dataDir);
    await requireDirectory(directory);
    const sources = join(await realpath(directory), 'sources');
    await requireDirectory(sources);
    const checkoutPath = resolve(source.checkoutPath), parts = relative(sources, checkoutPath).split(sep);
    if (parts.length !== 2 || !/^github-[a-z\d]+$/i.test(parts[0]) || parts[1] !== repository.split('/')[1]) throw invalidCheckout();
    await requireDirectory(join(sources, parts[0]));
    await requireDirectory(checkoutPath);
    if (await realpath(checkoutPath) !== checkoutPath) throw invalidCheckout();
    const gitDirectory = join(checkoutPath, '.git');
    await requireDirectory(gitDirectory);
    // Managed clones are standalone repositories, never linked worktrees.
    const config = await lstat(join(gitDirectory, 'config'));
    if (config.isSymbolicLink() || !config.isFile()) throw invalidCheckout();
    for (const name of ['objects', 'refs']) await requireDirectory(join(gitDirectory, name));
    const scanPath = await scanDirectory(checkoutPath, root);
    if (source.scanPath !== scanPath) throw invalidCheckout();
    const [layout, origin, head, shallow] = await Promise.all([
      command('git', gitArgs(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']), 'Reading the managed checkout', API_TIMEOUT, checkoutPath),
      command('git', gitArgs(['remote', 'get-url', '--all', 'origin']), 'Reading the GitHub remote', API_TIMEOUT, checkoutPath),
      command('git', gitArgs(['symbolic-ref', '--short', 'HEAD']), 'Reading the checkout branch', API_TIMEOUT, checkoutPath),
      command('git', gitArgs(['rev-parse', '--is-shallow-repository']), 'Reading GitHub history', API_TIMEOUT, checkoutPath),
    ]);
    const paths = layout.stdout.trim().split(/\r?\n/);
    if (paths.length !== 3 || resolve(checkoutPath, paths[0]) !== checkoutPath
      || resolve(checkoutPath, paths[1]) !== gitDirectory || resolve(checkoutPath, paths[2]) !== gitDirectory
      || origin.stdout.trim().toLowerCase() !== `https://github.com/${repository}.git`.toLowerCase()
      || head.stdout.trim() !== branch || !['true', 'false'].includes(shallow.stdout.trim())) throw invalidCheckout();
    return { checkoutPath, repository, shallow: shallow.stdout.trim() === 'true' };
  } catch (error) {
    if (error instanceof GitHubSourceError) throw error;
    throw invalidCheckout();
  }
}

/** Fetch history only into an owned clone; never checks out files or moves HEAD. */
export async function ensureGitHubHistory({ source, dataDir, refresh = false } = {}) {
  const checkout = await managedHistoryCheckout(source, dataDir);
  const key = checkout.checkoutPath;
  if (pendingHistorySyncs.has(key)) return pendingHistorySyncs.get(key);
  if (!refresh && historySyncs.has(key)) return historySyncs.get(key);
  const sync = inCheckoutTurn(key, async () => {
    // Read the boundary in turn: a move that ran first may have changed it.
    const shallow = (await command('git', gitArgs(['rev-parse', '--is-shallow-repository']), 'Reading GitHub history', API_TIMEOUT, key)).stdout.trim() === 'true';
    await command('git', gitArgs([
      '-c', 'fetch.writeCommitGraph=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'fetch', '--atomic', '--no-tags', '--prune', '--no-recurse-submodules',
      '--no-auto-maintenance', '--no-write-fetch-head', '--filter=blob:none',
      ...(shallow ? ['--unshallow'] : []), '--',
      `https://github.com/${checkout.repository}.git`, '+refs/heads/*:refs/remotes/origin/*',
    ]), 'Syncing GitHub history', 120_000, key);
    const result = { syncedAt: new Date().toISOString(), source: 'github' };
    historySyncs.set(key, result);
    return result;
  });
  pendingHistorySyncs.set(key, sync);
  try { return await sync; }
  finally { if (pendingHistorySyncs.get(key) === sync) pendingHistorySyncs.delete(key); }
}

/**
 * Moves an owned clone to one commit of its branch, in place, so environments built from its path
 * stay attached to the source. Only a managed checkout is accepted; a user's own checkout never is.
 */
export async function updateGitHubSource({ source, dataDir, sha } = {}) {
  if (typeof sha !== 'string' || !/^[a-f\d]{40}$/i.test(sha)) throw new GitHubSourceError('Choose a commit of the selected branch.');
  const { checkoutPath } = await managedHistoryCheckout(source, dataDir);
  return inCheckoutTurn(checkoutPath, async () => {
    // Validated again in turn, so the shallow boundary is read after any history sync before it.
    const checkout = await managedHistoryCheckout(source, dataDir);
    await command('git', gitArgs([
      '-c', 'fetch.writeCommitGraph=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head',
      // A full history stays full; a depth-one copy fetches only this commit.
      ...(checkout.shallow ? ['--depth', '1'] : []), '--', `https://github.com/${checkout.repository}.git`, sha,
    ]), 'Fetching the commit', 120_000, checkoutPath);
    // No checkout hook; global filters and templates are disabled for this operation.
    await command('git', gitArgs(['reset', '--hard', sha]), 'Updating the source files', 60_000, checkoutPath);
    const { stdout } = await command('git', gitArgs(['rev-parse', '--verify', 'HEAD']), 'Reading the checkout commit', API_TIMEOUT, checkoutPath);
    if (stdout.trim().toLowerCase() !== sha.toLowerCase()) throw new GitHubSourceError('The managed source did not move to this commit. Try again.');
    return { sha: stdout.trim() };
  });
}

/** Clone/read only: never changes an existing checkout, runs hooks, or starts a project. */
export async function prepareGitHubSource({ repository, branch, rootDirectory = '/', dataDir } = {}) {
  const selected = repositoryName(repository), selectedBranch = branchName(branch), root = sourceRoot(rootDirectory);
  // Check the branch, so git clone --branch cannot silently select a same-named tag.
  const { data: remoteBranch } = await githubApi(`repos/${selected}/branches/${encodeURIComponent(selectedBranch)}`);
  if (remoteBranch?.name !== selectedBranch) throw new GitHubSourceError('The selected branch is no longer available. Refresh the branch list.');
  let ownedDirectory;
  try {
    const sources = await managedSourcesDirectory(dataDir);
    ownedDirectory = await mkdtemp(join(sources, 'github-'));
    await chmod(ownedDirectory, 0o700);
    const checkoutPath = join(ownedDirectory, selected.split('/')[1]);
    await command('git', gitArgs([
      'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-checkout',
      '--template=', '--branch', selectedBranch, '--', `https://github.com/${selected}.git`, checkoutPath,
    ]), 'Cloning the selected GitHub branch', 120_000);
    await chmod(checkoutPath, 0o700);
    const { stdout: checkedOutBranch } = await command('git', gitArgs(['symbolic-ref', '--short', 'HEAD']), 'Reading the checkout branch', API_TIMEOUT, checkoutPath);
    if (checkedOutBranch.trim() !== selectedBranch) throw new GitHubSourceError('The selected branch changed while connecting. Refresh the branch list and reconnect.');
    // No checkout hook; global filters and templates are disabled for this operation.
    await command('git', gitArgs(['reset', '--hard', 'HEAD']), 'Reading the selected source files', 30_000, checkoutPath);
    const { stdout } = await command('git', gitArgs(['rev-parse', '--verify', 'HEAD']), 'Reading the checkout commit', API_TIMEOUT, checkoutPath);
    const sha = stdout.trim();
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) throw new GitHubSourceError('Git did not return a valid checkout commit. Reconnect the repository.');
    const scanPath = await scanDirectory(checkoutPath, root);
    return { scanPath, checkoutPath, repository: selected, branch: selectedBranch, rootDirectory: root, sha };
  } catch (error) {
    let cleanupFailed = false;
    if (ownedDirectory) try { await rm(ownedDirectory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    const safe = error instanceof GitHubSourceError ? error : new GitHubSourceError('Could not create the private source checkout. Check the local data directory permissions and available disk space.');
    if (cleanupFailed) safe.message += ' An incomplete private checkout could not be removed from the managed sources directory.';
    throw safe;
  }
}
