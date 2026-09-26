// The codex adapter without Docker, a network or a model: the config.toml an attempt gets (parsed as TOML), the shell
// that hands Codex its token over stdin, the reading of Codex's JSONL events into the shared outcome, the pinned
// release's integrity check and cache, and one attempt against a box double that plays back Codex's events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { capture, type BoxExecOptions, type BoxResult } from '../../../src/repair/box.ts';
import { INSTRUCTIONS } from '../../../src/repair/context.ts';
import { egressEnvironment } from '../../../src/repair/egress.ts';
import { CODEX, LAUNCH, PROXY_VARIABLES, configToml, launchArgv, readEvents, readRun, shellScript, shellWords, tomlString } from '../adapters/codex/codex.ts';
import { adapter } from '../adapters/codex/index.ts';
import { RELEASE, codexRelease, platformOf, tarballUrl, type Pin } from '../adapters/codex/release.ts';
import { gatewayEnvironment, type BenchBox } from '../box.ts';
import { ADAPTERS, ADAPTER_KEYS, LIMITS, appendedInstructions, harnessNote, type AttemptEvent } from '../harness.ts';

const MODEL = { id: 'gpt-6-luna', contextWindow: 400_000, maxOutput: 128_000, reasoning: true };
const BOX_URL = 'http://gateway:8080/api/v1';
/** Parsed TOML as plain JSON values (smol-toml builds objects without a prototype). */
const toml = (text: string) => JSON.parse(JSON.stringify(parse(text))) as Record<string, unknown>;
const config = () => toml(configToml({ model: MODEL.id, contextWindow: MODEL.contextWindow, baseUrl: BOX_URL, instructions: appendedInstructions('codex', INSTRUCTIONS), proxy: egressEnvironment() }));

const stream = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');
const command = (line: string, exit: number | null, output = '') => ({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: line, aggregated_output: output, exit_code: exit, status: exit === 0 ? 'completed' : 'failed' } });
const change = (status = 'completed') => ({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/workspace/src/tiers.js', kind: 'update' }], status } });
const message = (text: string) => ({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text } });
const completed = { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 120 } };
const exited = (extra: Partial<{ exitCode: number; timedOut: boolean; truncated: boolean; stderr: string }> = {}) => ({ exitCode: 0, timedOut: false, truncated: false, stderr: '', ...extra });
const SOLVED = [
  { type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' },
  command('/bin/bash -lc \'npm ci && npm test\'', 1, 'not ok 1 - tier boundary'), change(), command('/bin/bash -lc \'npm test\'', 0, 'ok 1'),
  message('The tier check used > where the rule is >=; npm test passes.'), completed,
];

test('config.toml makes the gateway Codex\'s only provider for the attempt\'s model, keeps the key in BENCH_TOKEN and adds INSTRUCTIONS beside Codex\'s own', () => {
  const parsed = config(), proxy = egressEnvironment();
  assert.deepEqual(Object.fromEntries(['model', 'model_provider', 'model_context_window', 'service_tier', 'approval_policy', 'sandbox_mode', 'web_search', 'project_doc_max_bytes', 'check_for_update_on_startup'].map(key => [key, parsed[key]])), {
    model: 'gpt-6-luna', model_provider: 'bench', model_context_window: 400_000, service_tier: 'default', approval_policy: 'never', sandbox_mode: 'danger-full-access',
    web_search: 'disabled', project_doc_max_bytes: 0, check_for_update_on_startup: false,
  });
  assert.equal(parsed.developer_instructions, `${INSTRUCTIONS}\n\n${harnessNote('codex')}`, 'INSTRUCTIONS verbatim, then the harness note.');
  assert.equal('instructions' in parsed || 'model_instructions_file' in parsed, false, 'Codex keeps its own base instructions.');
  assert.deepEqual(parsed.model_providers, { bench: { name: 'bench', base_url: BOX_URL, env_key: 'BENCH_TOKEN', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } });
  assert.deepEqual(parsed.shell_environment_policy, { inherit: 'all', ignore_default_excludes: false, exclude: ['BENCH_TOKEN'], set: Object.fromEntries(PROXY_VARIABLES.map(name => [name, proxy[name]])) });
  assert.deepEqual(parsed.features, { apps: false, plugins: false, image_generation: false });
  assert.deepEqual([parsed.agents, parsed.skills, parsed.analytics, parsed.feedback, parsed.otel, parsed.history], [
    { enabled: false }, { include_instructions: false, bundled: { enabled: false } }, { enabled: false }, { enabled: false },
    { exporter: 'none', trace_exporter: 'none', metrics_exporter: 'none' }, { persistence: 'none' },
  ]);
  assert.equal(['mcp_servers', 'profiles', 'experimental_bearer_token', 'openai_base_url'].some(key => key in parsed), false);
});

test('TOML strings survive quotes, backslashes, newlines, tabs, DEL and lone surrogates', () => {
  const tricky = 'a "quoted" \\ path\nnext\tline \u007f del \ud800 lone, ünïcödé';
  assert.equal(toml(`value = ${tomlString(tricky)}`).value, tricky.toWellFormed());
  assert.equal(toml(configToml({ model: 'odd"model\\', contextWindow: Number.NaN, baseUrl: BOX_URL, instructions: '', proxy: {} })).model, 'odd"model\\');
  assert.equal('model_context_window' in toml(configToml({ model: 'm', contextWindow: Number.NaN, baseUrl: BOX_URL, instructions: '', proxy: {} })), false);
});

test('Codex starts headless in /workspace from its release, with gateway in NO_PROXY and no token, key or prompt in its argv', () => {
  const argv = launchArgv('/workspace', gatewayEnvironment());
  assert.deepEqual(argv.slice(0, 4), ['env', 'CODEX_HOME=/opt/bench/codex-home', 'NO_PROXY=localhost,127.0.0.1,::1,gateway', 'no_proxy=localhost,127.0.0.1,::1,gateway']);
  assert.deepEqual(argv.slice(argv.indexOf(CODEX.bin)), [CODEX.bin, 'exec', '--json', '--color', 'never', '--strict-config', '--skip-git-repo-check', '--cd', '/workspace', '-']);
  assert.deepEqual(argv.slice(4, 8), ['sh', '-c', LAUNCH, 'sh']);
  assert.ok(!argv.some(arg => /BENCH_TOKEN=|OPENAI_API_KEY|OPENROUTER_API_KEY/.test(arg)));
});

test('the launch shell gives Codex the token from stdin\'s first line and the rest, byte for byte, as its task, without the proxy', async () => {
  const token = 'tok_ABC-123', prompt = 'Repository acme/app, branch main.\n\n````sh\nnpm test\n````\nünïcödé "quotes" $HOME `ticks`\n';
  const script = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({ token: process.env.BENCH_TOKEN, proxies: ${JSON.stringify(PROXY_VARIABLES)}.map(name => process.env[name] ?? null), noProxy: process.env.NO_PROXY, input })));`;
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...egressEnvironment(), ...gatewayEnvironment() };
  const result = await capture('sh', ['-c', LAUNCH, 'sh', process.execPath, '-e', script], { env, stdin: `${token}\n${prompt}`, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { token, proxies: [null, null, null, null], noProxy: 'localhost,127.0.0.1,::1,gateway', input: prompt });
  assert.equal((await capture('sh', ['-c', LAUNCH, 'sh', 'true'], { env, stdin: '', timeoutMs: 30_000 })).exitCode, 2, 'Without a token line Codex never starts.');
});

test('the failing command is found inside Codex\'s bash -lc wrapper, however it was quoted', () => {
  assert.deepEqual(shellWords('/bin/bash -lc \'npm ci && npm test\''), ['/bin/bash', '-lc', 'npm ci && npm test']);
  assert.equal(shellScript('/bin/bash -lc \'echo \'"\'"\'it\'"\'"\' && npm test\''), 'echo \'it\' && npm test');
  assert.equal(shellScript('bash -c "FOO=\\"a b\\" npm test"'), 'FOO="a b" npm test');
  assert.equal(shellScript('/usr/bin/zsh -lc make'), 'make');
  assert.equal(shellScript('npm test'), 'npm test');
  assert.equal(shellScript('python -c \'print(1)\''), 'python -c \'print(1)\'');
  assert.equal(shellWords('bash -lc \'unterminated'), null);
});

test('a completed turn that ends with a message is done: steps are tool items, the summary is the last message, and the failure was reproduced', () => {
  const stdout = ['Reading additional input from stdin...', stream(...SOLVED), '{"partial":', '[1,2]', '{"no":"type"}'].join('\n');
  const run = readRun(readEvents(stdout), ['npm test'], exited());
  assert.deepEqual([run.end, run.steps, run.reproduced, run.summary, run.error, run.turn], ['done', 3, true, 'The tier check used > where the rule is >=; npm test passes.', '', 'completed']);
  assert.deepEqual(run.usage, { input: 5000, cached: 4000, cacheWrite: 0, output: 300, reasoning: 120 });
  assert.deepEqual(run.events.map(event => event.type), ['codex.thread', 'codex.command', 'codex.file_change', 'codex.command', 'codex.message', 'codex.turn']);
  assert.deepEqual(run.events[1], { type: 'codex.command', command: '/bin/bash -lc \'npm ci && npm test\'', exitCode: 1, status: 'failed', output: 'not ok 1 - tier boundary' });
});

test('reproduced follows the product\'s rule: the failing command itself, failing, before the first applied change', () => {
  const reproduced = (...events: unknown[]) => readRun(readEvents(stream(...events, message('done'), completed)), ['npm test'], exited()).reproduced;
  assert.equal(reproduced(change(), command('bash -lc \'npm test\'', 1)), false, 'After a change it no longer reproduces the failure.');
  assert.equal(reproduced(change('failed'), command('bash -lc \'npm test\'', 1)), true, 'A patch that failed changed nothing.');
  assert.equal(reproduced(command('bash -lc \'npm run lint\'', 1)), false);
  assert.equal(reproduced(command('bash -lc \'pnpm test\'', 1)), false);
  assert.equal(reproduced(command('bash -lc \'npm test\'', 0)), false);
  assert.equal(reproduced(command('bash -lc \'npm test\'', null)), false, 'A command without an exit code did not fail.');
});

test('how an attempt ends: time, provider (a gateway refusal included), context, idle and error', () => {
  const end = (events: unknown[], exit = exited()) => { const run = readRun(readEvents(stream(...events)), ['npm test'], exit); return [run.end, run.error, run.steps]; };
  const refused = { type: 'turn.failed', error: { message: 'unexpected status 402 Payment Required: Bench limit: the attempt reached its request limit., url: http://gateway:8080/api/v1/responses' } };
  assert.deepEqual(end([command('bash -lc true', 0), { type: 'error', message: 'unexpected status 402 Payment Required' }, refused], exited({ exitCode: 1 })), ['provider', refused.error.message, 1]);
  assert.deepEqual(end([{ type: 'turn.failed', error: { message: 'Codex ran out of room in the model\'s context window. Start a new thread or clear earlier history before retrying.' } }], exited({ exitCode: 1 }))[0], 'context');
  assert.deepEqual(end([command('bash -lc \'npm ci\'', 0)], exited({ exitCode: 124, timedOut: true }))[0], 'time');
  assert.deepEqual(end([completed]), ['idle', '', 0]);
  assert.deepEqual(end([{ type: 'error', message: 'stream disconnected before completion; retrying 1/5' }, message('Fixed.'), completed]), ['done', '', 0]);
  const failed = end([], exited({ exitCode: 1, stderr: 'Error loading config.toml:\nunknown field `foo`\n' }));
  assert.deepEqual([failed[0], failed[1]], ['error', 'Error loading config.toml: unknown field `foo`']);
  assert.match(String(end([command('bash -lc true', 0)], exited({ exitCode: 1, truncated: true }))[1]), /outgrew/);
});

test('each supported box machine maps to its pinned Linux build', () => {
  assert.deepEqual(['aarch64', 'arm64', 'x86_64', 'amd64\n', 's390x', ''].map(platformOf), ['linux-arm64', 'linux-arm64', 'linux-x64', 'linux-x64', null, null]);
  assert.equal(tarballUrl(RELEASE, 'linux-arm64'), 'https://registry.npmjs.org/@openai/codex/-/codex-0.157.0-linux-arm64.tgz');
  assert.deepEqual([RELEASE.version, RELEASE.license, RELEASE.platforms['linux-arm64'].triple, RELEASE.platforms['linux-x64'].triple], ['0.157.0', 'Apache-2.0', 'aarch64-unknown-linux-musl', 'x86_64-unknown-linux-musl']);
  assert.ok(Object.values(RELEASE.platforms).every(build => /^sha512-[A-Za-z0-9+/]{86}==$/.test(build.integrity)));
});

/** A release tarball shaped like the registry's platform package, and a pin of its real integrity. */
async function fakeRelease(root: string) {
  const triple = 'aarch64-unknown-linux-musl', source = join(root, 'source'), vendor = join(source, 'package', 'vendor', triple);
  await mkdir(join(vendor, 'bin'), { recursive: true });
  await mkdir(join(vendor, 'codex-path'), { recursive: true });
  await writeFile(join(vendor, 'bin', 'codex'), '#!/bin/sh\necho codex-cli 9.9.9\n', { mode: 0o755 });
  await writeFile(join(vendor, 'codex-path', 'rg'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(vendor, 'codex-package.json'), '{"version":"9.9.9"}\n');
  await writeFile(join(source, 'package', 'package.json'), '{"name":"@openai/codex","version":"9.9.9-linux-arm64"}\n');
  // COPYFILE_DISABLE keeps macOS's tar from adding AppleDouble entries.
  const archive = join(root, 'release.tgz'), packed = await capture('tar', ['-czf', archive, '-C', source, 'package'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', COPYFILE_DISABLE: '1' }, timeoutMs: 60_000 });
  assert.equal(packed.exitCode, 0, packed.stderr);
  const bytes = await readFile(archive), integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const pin = (value: string): Pin => ({ name: '@openai/codex', version: '9.9.9', license: 'Apache-2.0', platforms: { 'linux-arm64': { triple, integrity: value }, 'linux-x64': { triple: 'x86_64-unknown-linux-musl', integrity: 'sha512-unused' } } });
  const fetched: string[] = [];
  const fetcher = (status = 200) => (async (input: string | URL | Request) => { fetched.push(String(input)); return new Response(status === 200 ? bytes : 'Not found', { status }); }) as typeof fetch;
  return { triple, integrity, pin, fetched, fetcher };
}

test('the release is downloaded once, unpacked only when its bytes match the pinned sha512, and reused from the cache', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bench-codex-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await fakeRelease(root), cache = join(root, 'cache');
  const tampered = join(root, 'tampered');
  await assert.rejects(codexRelease('linux-arm64', { cache: tampered, fetcher: release.fetcher(), pin: release.pin(`sha512-${'A'.repeat(86)}==`) }), /does not match its pinned integrity/);
  assert.deepEqual(await readdir(join(tampered, '9.9.9')), [], 'Nothing was unpacked, and the download was removed.');
  await assert.rejects(codexRelease('linux-arm64', { cache: join(root, 'missing'), fetcher: release.fetcher(404), pin: release.pin(release.integrity) }), /HTTP 404/);
  release.fetched.length = 0;
  const [first, second] = await Promise.all([1, 2].map(() => codexRelease('linux-arm64', { cache, fetcher: release.fetcher(), pin: release.pin(release.integrity) })));
  assert.equal(first, join(cache, '9.9.9', 'linux-arm64', 'package', 'vendor', release.triple));
  assert.equal(second, first);
  assert.deepEqual(release.fetched, ['https://registry.npmjs.org/@openai/codex/-/codex-9.9.9-linux-arm64.tgz'], 'Attempts that ask together share one download.');
  assert.ok(((await stat(join(first, 'bin', 'codex'))).mode & 0o111) !== 0, 'The binary stays executable.');
  assert.equal(await readFile(join(cache, '9.9.9', 'linux-arm64', '.verified'), 'utf8'), release.integrity);
  assert.deepEqual((await readdir(join(cache, '9.9.9'))).sort(), ['linux-arm64'], 'No download or unpacking folder is left.');
  // The same cache under another path is a new key in memory, so this reads the verified release from disk.
  await symlink(cache, join(root, 'cache-link'));
  assert.equal(await codexRelease('linux-arm64', { cache: join(root, 'cache-link'), fetcher: release.fetcher(), pin: release.pin(release.integrity) }), join(root, 'cache-link', '9.9.9', 'linux-arm64', 'package', 'vendor', release.triple));
  assert.equal(release.fetched.length, 1);
});

/** A bench box double: the config write succeeds, and `env … codex exec` plays back Codex's stdout. */
function boxDouble(stdout: string, played: Partial<BoxResult> = {}) {
  const calls: { argv: readonly string[]; options: BoxExecOptions }[] = [];
  const box = {
    root: '/workspace', image: 'node:22-bookworm',
    async exec(argv: readonly string[], options: BoxExecOptions = {}): Promise<BoxResult> {
      calls.push({ argv, options });
      return argv[0] === 'env' ? { exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false, ...played } : { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
    },
  };
  return { box: box as unknown as BenchBox, calls };
}

test('an attempt writes config.toml, starts codex exec with the token and the prompt on stdin, and reports Codex\'s events', async () => {
  const { box, calls } = boxDouble(stream(...SOLVED)), events: AttemptEvent[] = [];
  const token = 'attempt-token-7f3a', prompt = 'Repository acme/invoice, branch main, failing commit 0123. Attempt 1 of 4.\n\n## Failed run: CI';
  const outcome = await adapter.runAttempt({ box, system: INSTRUCTIONS, prompt, failing: ['npm test'], model: MODEL, limits: LIMITS, signal: new AbortController().signal, scratch: tmpdir(),
    gateway: { baseUrl: 'http://127.0.0.1:9/api/v1', boxUrl: BOX_URL, token }, log: event => { events.push(event); } });
  assert.deepEqual(outcome, { reason: 'done', steps: 3, summary: 'The tier check used > where the rule is >=; npm test passes.', reproduced: true });
  const [write, launch] = calls;
  assert.deepEqual([calls.length, write.argv], [2, ['sh', '-c', 'cat > "$1"', 'sh', '/opt/bench/codex-home/config.toml']]);
  const written = toml(write.options.stdin ?? '');
  assert.deepEqual([written.model, (written.model_providers as Record<string, Record<string, unknown>>).bench.base_url], [MODEL.id, BOX_URL]);
  assert.deepEqual(launch.argv, launchArgv('/workspace', gatewayEnvironment()));
  assert.deepEqual([launch.options.stdin, launch.options.timeoutMs, launch.options.limit], [`${token}\n${prompt}`, LIMITS.timeMs, 64 * 1024 * 1024]);
  assert.ok(!JSON.stringify(calls.map(call => call.argv)).includes(token) && !(write.options.stdin ?? '').includes(token), 'The token is only on Codex\'s stdin.');
  assert.deepEqual(events.map(event => event.type), ['codex.thread', 'codex.command', 'codex.file_change', 'codex.command', 'codex.message', 'codex.turn', 'attempt']);
  const stopped = await adapter.runAttempt({ box: boxDouble(stream(command('bash -lc \'npm ci\'', 0)), { exitCode: 124, timedOut: true, stderr: 'killed' }).box, system: INSTRUCTIONS, prompt, failing: ['npm test'], model: MODEL,
    limits: LIMITS, signal: new AbortController().signal, scratch: tmpdir(), gateway: { baseUrl: 'http://127.0.0.1:9/api/v1', boxUrl: BOX_URL, token }, log: () => {} });
  assert.deepEqual([stopped.reason, stopped.steps], ['time', 1]);
});

test('an attempt without the gateway relay is refused before anything runs in the box', async () => {
  const { box, calls } = boxDouble('');
  await assert.rejects(adapter.runAttempt({ box, system: INSTRUCTIONS, prompt: 'p', failing: [], model: MODEL, limits: LIMITS, signal: new AbortController().signal, scratch: tmpdir(),
    gateway: { baseUrl: 'http://127.0.0.1:9/api/v1', token: 't' }, log: () => {} }), /gateway relay/);
  assert.equal(calls.length, 0);
});

test('codex is registered for the OpenAI track\'s Responses API, runs in the box and loads lazily', async () => {
  assert.ok(ADAPTER_KEYS.includes('codex'));
  assert.equal(await ADAPTERS.codex(), adapter);
  assert.deepEqual([adapter.key, adapter.version, adapter.inBox, adapter.providers, adapter.harnessPaths ?? []], ['codex', '@openai/codex@0.157.0', true, { openai: 'responses' }, []]);
  assert.match(harnessNote('codex'), /final message/);
  assert.equal(appendedInstructions('codex', 'SYSTEM'), `SYSTEM\n\n${harnessNote('codex')}`);
});
