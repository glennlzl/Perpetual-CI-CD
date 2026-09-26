import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { GITHUB_MESSAGES, githubEnvironment, githubFailureKind, githubGetArgs, isRepository, notModified, parseGitHubResponse, runGitHub } from '../src/github-cli.ts';

test('gh runs with its own configuration and none of the inherited git or debug settings', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: '/elsewhere/.git', GIT_SSH_COMMAND: 'ssh -v', GH_DEBUG: 'api', GH_FORCE_TTY: '1', GH_TOKEN: 'keep', HOME: '/home/u', SSH_ASKPASS: '/bin/ask', DEBUG: '*' });
    const env = githubEnvironment();
    assert.equal(Object.keys(env).some(key => key.startsWith('GIT_')), false);
    assert.equal(env.GH_DEBUG, undefined);
    assert.equal(env.GH_FORCE_TTY, undefined);
    assert.deepEqual([env.GH_HOST, env.GH_PROMPT_DISABLED, env.GH_PAGER, env.GH_TOKEN, env.HOME, env.SSH_ASKPASS], ['github.com', '1', 'cat', 'keep', '/home/u', '/bin/ask'], 'The token, home and keychain settings stay.');
    const login = githubEnvironment({ strip: ['DEBUG', 'SSH_ASKPASS'], set: { NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' } });
    assert.deepEqual([login.DEBUG, login.SSH_ASKPASS, login.NO_COLOR, login.GIT_TERMINAL_PROMPT], [undefined, undefined, '1', '0'], 'A caller strips more and sets its own.');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('a repository is owner/name, never a path', () => {
  assert.deepEqual(['acme/app', 'acme/app.js', 'a-b/c_d.e'].map(isRepository), [true, true, true]);
  assert.deepEqual(['acme', 'acme/', '/app', 'acme/.', 'acme/..', 'owner/repo/../../user', 'acme/app/x', 42, null].map(isRepository), [false, false, false, false, false, false, false, false, false]);
});

test('a gh api reply parses to its status, tag, headers and body, and a 304 comes back bare', () => {
  const reply = 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\nX-Custom: value\r\n\r\n{"ok":true}';
  assert.deepEqual(parseGitHubResponse(reply), { status: 200, etag: 'W/"abc"', headers: { etag: 'W/"abc"', link: '<https://api.github.com/x?page=2>; rel="next"', 'x-custom': 'value' }, data: { ok: true } });
  assert.equal(parseGitHubResponse('HTTP/2.0 200 OK\nEtag: bad\n\n[]').etag, null, 'An invalid entity tag is null.');
  assert.deepEqual(parseGitHubResponse('HTTP/2.0 304 Not Modified\n\n'), { status: 304 });
  assert.throws(() => parseGitHubResponse('not a response'), /unreadable response. Update gh/);
  assert.throws(() => parseGitHubResponse('HTTP/2.0 200 OK\n\n{oops'), /unreadable response. Try again/);
  class Own extends Error {}
  assert.throws(() => parseGitHubResponse('garbage', message => new Own(message)), Own, 'The caller keeps its own error type.');
  assert.deepEqual(githubGetArgs('repos/acme/app/x', 'W/"1"'), ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'If-None-Match: W/"1"', 'repos/acme/app/x']);
  assert.equal(githubGetArgs('repos/acme/app/x').includes('-H'), true);
  assert.equal(githubGetArgs('repos/acme/app/x').some(arg => arg.startsWith('If-None-Match')), false);
  assert.equal(notModified({ stdout: 'HTTP/2.0 304 Not Modified\n' }, 'W/"1"'), true);
  assert.equal(notModified({ stdout: 'HTTP/2.0 304 Not Modified\n' }, null), false, 'Without a tag, a 304 was not asked for.');
});

test('a failure is classified from its exit and output, which never leave', () => {
  const cases: [unknown, string][] = [
    [{ code: 'ENOENT' }, 'missing'], [{ killed: true }, 'timeout'], [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ stderr: 'API rate limit exceeded' }, 'rate-limit'], [{ stderr: 'gh: Bad credentials (HTTP 401) token gho_secret' }, 'unauthenticated'],
    [{ stderr: 'fatal: could not read Username for https://github.com' }, 'unauthenticated'],
    [{ stderr: 'HTTP 404: Not Found' }, 'not-found'], [{ stderr: "fatal: couldn't find remote ref main" }, 'not-found'],
    [{ stderr: 'HTTP 403: Resource not accessible by integration' }, 'denied'], [{ message: 'remote: Permission denied' }, 'denied'],
    [{ stderr: 'something else' }, 'other'], [null, 'other'],
  ];
  for (const [error, kind] of cases) assert.equal(githubFailureKind(error), kind, JSON.stringify(error));
  assert.match(GITHUB_MESSAGES.unauthenticated, /gh auth login --hostname github\.com/);
});

test('runGitHub passes gh, the arguments, the environment and the limits to the runner it is given', async () => {
  const calls: unknown[] = [];
  const run = async (file: string, args: string[], options: Record<string, unknown>) => { calls.push([file, args, options.timeout, options.maxBuffer, options.encoding, options.windowsHide, (options.env as NodeJS.ProcessEnv).GH_HOST]); return { stdout: 'ok' }; };
  assert.deepEqual(await runGitHub(['api', 'x'], { run }), { stdout: 'ok' });
  assert.deepEqual(calls, [['gh', ['api', 'x'], 20_000, 4 * 1024 * 1024, 'utf8', true, 'github.com']]);
  await runGitHub(['x'], { run, timeout: 5, maxBuffer: 6 });
  assert.deepEqual((calls[1] as unknown[]).slice(2, 4), [5, 6]);
});

test('the repository pattern, the gh environment and the failure families are written once', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && file !== 'github-cli.ts');
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\[a-z\\d\]\[a-z\\d-\]\{0,38\}/, `${file} spells the repository pattern`);
    assert.doesNotMatch(text, /GH_PROMPT_DISABLED/, `${file} builds a gh environment of its own`);
    assert.doesNotMatch(text, /\/\^\[a-f\\d\]\{40\}\$\/i/, `${file} spells the commit id pattern`);
    assert.doesNotMatch(text, /rate limit\|secondary rate/, `${file} classifies gh failures itself`);
  }
});
