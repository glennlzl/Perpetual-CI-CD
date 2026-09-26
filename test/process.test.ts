import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { gitReadOnly, gitReadOnlyEnvironment, localDockerEnvironment } from '../src/process.ts';

test('a read-only git query carries one argv prefix and one environment, read at call time', async () => {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const run = async (file: string, args: string[], options: Record<string, unknown>) => { calls.push({ file, args, options }); return { stdout: ' main\n', stderr: '' }; };
  const path = process.env.PATH;
  try {
    process.env.PATH = '/fixture/bin';
    const { stdout } = await gitReadOnly('/repo', ['rev-parse', 'HEAD'], { timeout: 2000, maxBuffer: 4096, run });
    assert.equal(stdout, ' main\n');
  } finally { process.env.PATH = path; }
  assert.deepEqual(calls, [{ file: 'git', args: ['-c', 'core.fsmonitor=false', '-C', '/repo', 'rev-parse', 'HEAD'], options: { timeout: 2000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true, env: { PATH: '/fixture/bin', HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } } }]);
  assert.deepEqual(Object.keys(gitReadOnlyEnvironment()), ['PATH', 'HOME', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'], 'No GIT_DIR, trace or helper variable reaches a read-only git.');
  await gitReadOnly('/repo', ['status'], { run });
  assert.equal(calls[1].options.timeout, 10_000);
  assert.equal(calls[1].options.maxBuffer, 4 * 1024 * 1024);
});

test('a docker CLI pinned to a local engine loses the ambient endpoint and keeps the rest', () => {
  const env = localDockerEnvironment({ PATH: '/bin', HOME: '/home/u', DOCKER_HOST: 'tcp://remote:2376', DOCKER_CONTEXT: 'remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/certs', DOCKER_CONFIG: '/home/u/.docker' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', DOCKER_CONFIG: '/home/u/.docker' });
  assert.equal('DOCKER_HOST' in localDockerEnvironment(), false);
});

test('the read-only git environment and the local docker scrub are written once', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.ts') && file !== 'process.ts');
  for (const file of files) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    // The Git graph's reader is stricter on purpose and names its own environment.
    if (file !== 'git-history.ts') assert.doesNotMatch(text, /GIT_OPTIONAL_LOCKS/, `${file} builds a git environment of its own`);
    assert.doesNotMatch(text, /'DOCKER_TLS_VERIFY'/, `${file} scrubs the docker endpoint by hand`);
  }
});
