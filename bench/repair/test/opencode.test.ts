// The opencode adapter without Docker, a network or a model: the config, environment and command it gives opencode in
// the box, the package it picks per machine, how it reads opencode 1.18.32's `--format json` events into the shared
// outcome, and one attempt against a box double that records what reaches the box, so the token is seen only in the
// config file's stdin and the prompt goes on stdin byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BoxExecOptions, BoxResult } from '../../../src/repair/box.ts';
import { INSTRUCTIONS } from '../../../src/repair/context.ts';
import { BOX, PACKAGES, adapter, opencodeCommand, opencodeConfig, opencodeEnvironment, outcome, readEvents, variantOf } from '../adapters/opencode/index.ts';
import type { BenchBox } from '../box.ts';
import { LIMITS, appendedInstructions, harnessNote, type AttemptEvent, type GatewayAccess } from '../harness.ts';

const MODEL = { id: 'fake/coder', contextWindow: 200_000, maxOutput: 32_000, reasoning: true };
const TOKEN = 'tok-0123456789abcdefghijklmnopqrstuvwxyzABCDEFG', BOX_URL = 'http://gateway:8080/api/v1';
const PROMPT = 'Repository acme/invoice, branch main, failing commit 0123456789abcdef0123456789abcdef01234567. Attempt 1 of 4.\n\n```sh\nnpm test\n```';

// opencode 1.18.32's JSON events as `opencode run --format json` prints them, one per line.
const at = (n: number) => 1_767_225_600_000 + n * 1000;
const line = (type: string, n: number, data: Record<string, unknown>) => JSON.stringify({ type, timestamp: at(n), sessionID: 'ses_bench', ...data });
const start = (n: number) => line('step_start', n, { part: { id: `prt_s${n}`, sessionID: 'ses_bench', messageID: `msg_${n}`, type: 'step-start' } });
const finish = (n: number, reason: string, cost = 0) => line('step_finish', n, { part: { id: `prt_f${n}`, type: 'step-finish', reason, cost, tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 200, write: 0 } } } });
const tool = (n: number, name: string, input: Record<string, unknown>, state: Record<string, unknown>) =>
  line('tool_use', n, { part: { id: `prt_t${n}`, type: 'tool', callID: `call_${n}`, tool: name, state: { input, time: { start: at(n), end: at(n) }, ...state } } });
const bash = (n: number, command: string, exit: number | null) => tool(n, 'bash', { command }, { status: 'completed', output: '…', title: command, metadata: { output: '…', exit, truncated: false } });
const edit = (n: number, filePath: string) => tool(n, 'edit', { filePath, oldString: 'subtotal > min', newString: 'subtotal >= min' }, { status: 'completed', output: 'Edit applied successfully.', title: filePath, metadata: {} });
const say = (n: number, text: string, id = `prt_x${n}`) => line('text', n, { part: { id, type: 'text', text, time: { start: at(n), end: at(n) } } });
const failure = (n: number, name: string, message: string, statusCode?: number) => line('error', n, { error: { name, data: { message, ...(statusCode === undefined ? {} : { statusCode, isRetryable: false }) } } });
const SOLVED = [
  start(0), say(1, 'Reproducing the failure first.'), bash(2, 'npm ci && npm test', 1), finish(3, 'tool-calls'),
  start(4), edit(5, '/workspace/src/invoice.js'), finish(6, 'tool-calls'),
  start(7), bash(8, 'npm test', 0), finish(9, 'tool-calls'),
  start(10), say(11, 'The tier check used > instead of >=; npm test passes now.'), finish(12, 'stop', 0.0125),
].join('\n');
const ran = (extra: Partial<{ exitCode: number; timedOut: boolean; stderr: string }> = {}) => ({ exitCode: 0, timedOut: false, stderr: '', ...extra });

test('the config makes the gateway opencode\'s OpenRouter provider with the token, puts the one model in every slot, and names every permission', () => {
  const config = opencodeConfig({ model: MODEL, boxUrl: BOX_URL, token: TOKEN, steps: 100 }), provider = config.provider.openrouter;
  assert.deepEqual([provider.npm, provider.options], ['@openrouter/ai-sdk-provider', { baseURL: BOX_URL, apiKey: TOKEN }]);
  assert.deepEqual(provider.models, { 'fake/coder': { tool_call: true, reasoning: true, status: 'active', limit: { context: 200_000, output: 32_000 } } });
  assert.deepEqual([config.model, config.small_model, config.enabled_providers], ['openrouter/fake/coder', 'openrouter/fake/coder', ['openrouter']]);
  assert.deepEqual([config.autoupdate, config.share, config.snapshot, config.formatter, config.lsp], [false, 'disabled', false, false, false]);
  assert.deepEqual([config.instructions, config.agent, config.experimental], [[BOX.instructions], { build: { steps: 100 } }, { continue_loop_on_deny: true }]);
  // Every permission opencode 1.18.32 has, by name, and none left to ask: an unexpected question could only be refused.
  const permission: Record<string, unknown> = config.permission;
  assert.deepEqual(Object.keys(permission).sort(), ['bash', 'doom_loop', 'edit', 'external_directory', 'glob', 'grep', 'list', 'lsp', 'question', 'read', 'skill', 'task', 'todowrite', 'webfetch', 'websearch']);
  const actions = Object.values(permission).flatMap(value => typeof value === 'string' ? [value] : Object.values(value as Record<string, string>));
  assert.ok(actions.every(action => action === 'allow' || action === 'deny'));
  assert.deepEqual(['read', 'glob', 'grep', 'edit', 'bash'].map(key => permission[key]), ['allow', 'allow', 'allow', 'allow', 'allow']);
  assert.deepEqual(['webfetch', 'websearch', 'task', 'question', 'skill', 'lsp'].map(key => permission[key]), Array(6).fill('deny'));
  assert.deepEqual(permission.external_directory, { '*': 'deny' });
});

test('opencode starts with gateway in NO_PROXY, its own folders under /opt/bench, the box\'s HOME, and no credential in its argv or environment', () => {
  const environment = opencodeEnvironment();
  assert.match(environment.NO_PROXY, /(^|,)gateway(,|$)/);
  assert.equal(environment.no_proxy, environment.NO_PROXY);
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) assert.ok(environment[key].startsWith(`${BOX.home}/`), key);
  assert.equal(environment.OPENCODE_CONFIG, BOX.config);
  for (const flag of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_PURE',
    'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS']) assert.equal(environment[flag], '1', flag);
  assert.ok(!('HOME' in environment) && !('HTTP_PROXY' in environment) && !Object.keys(environment).some(key => /KEY|TOKEN|SECRET/.test(key)));
  const argv = opencodeCommand('fake/coder');
  assert.equal(argv[0], 'env');
  assert.deepEqual(argv.slice(argv.indexOf(BOX.bin)), [BOX.bin, '--print-logs', '--log-level', 'WARN', 'run', '--agent', 'build', '--model', 'openrouter/fake/coder', '--title', 'bench', '--format', 'json']);
});

test('the package follows the box\'s machine as opencode\'s installer picks it, and every download has a pinned digest', () => {
  assert.equal(variantOf('aarch64\n'), 'arm64');
  assert.equal(variantOf('x86_64\navx2\n'), 'x64');
  assert.equal(variantOf('x86_64\n'), 'x64-baseline');
  assert.throws(() => variantOf('riscv64\n'), /no Linux build for riscv64/);
  for (const pack of Object.values(PACKAGES)) {
    assert.match(pack.integrity, /^sha512-[A-Za-z\d+/]{86}==$/);
    assert.match(pack.sha256, /^[\da-f]{64}$/);
  }
  assert.deepEqual(Object.values(PACKAGES).map(pack => pack.name), ['opencode-linux-arm64', 'opencode-linux-x64', 'opencode-linux-x64-baseline']);
});

test('a solved run reads as four steps ending with a final message, reproduced before the edit, with opencode\'s own cost', () => {
  const run = readEvents(SOLVED, ['npm test']);
  assert.deepEqual([run.steps, run.finish, run.reproduced, run.failure, run.errors], [4, 'stop', true, null, []]);
  assert.equal(run.summary, 'The tier check used > instead of >=; npm test passes now.', 'Only the last step\'s text is the summary.');
  assert.ok(Math.abs(run.cost - 0.0125) < 1e-12);
  assert.deepEqual(run.events.filter(event => event.type === 'tool').map(event => [event.tool, event.command ?? event.path, event.exit]),
    [['bash', 'npm ci && npm test', 1], ['edit', '/workspace/src/invoice.js', undefined], ['bash', 'npm test', 0]]);
  assert.deepEqual(run.events.at(-1), { type: 'step', step: 4, finish: 'stop', tokens: { input: 1000, output: 50, reasoning: 10, cached: 200 }, ms: 12_000 });
  assert.deepEqual(outcome(run, ran(), LIMITS), { reason: 'done', steps: 4, summary: run.summary, reproduced: true, frameworkCost: run.cost });
});

test('a failure counts as reproduced only when a failing step\'s command fails before any file change', () => {
  const after = [start(0), edit(1, '/workspace/src/invoice.js'), bash(2, 'npm test', 1), finish(3, 'stop')].join('\n');
  assert.equal(readEvents(after, ['npm test']).reproduced, false, 'After the edit.');
  assert.equal(readEvents([start(0), bash(1, 'npm ci', 1), finish(2, 'stop')].join('\n'), ['npm test']).reproduced, false, 'Another command.');
  assert.equal(readEvents([start(0), bash(1, 'cd app && CI=1 npm test', null), finish(2, 'stop')].join('\n'), ['npm test']).reproduced, true, 'A killed run failed too.');
  const refused = tool(1, 'bash', { command: 'npm test' }, { status: 'error', error: 'The user rejected permission to use this specific tool call.' });
  assert.equal(readEvents([start(0), refused, finish(2, 'stop')].join('\n'), ['npm test']).reproduced, false, 'A refused call never ran.');
  const failed = tool(1, 'write', { filePath: '/workspace/src/invoice.js', content: 'x' }, { status: 'error', error: 'refused' });
  assert.equal(readEvents([start(0), failed, bash(2, 'npm test', 1), finish(3, 'stop')].join('\n'), ['npm test']).reproduced, true, 'A failed write changed nothing.');
});

test('the outcome is opencode\'s time limit, then a reported error, then its step limit, then a crash, else done or idle', () => {
  const run = readEvents(SOLVED, ['npm test']);
  assert.equal(outcome(run, ran({ timedOut: true, exitCode: 124 }), LIMITS).reason, 'time');
  const refused = readEvents([start(0), bash(1, 'npm test', 1), finish(2, 'tool-calls'), start(3), failure(4, 'APIError', 'Bench limit: the attempt reached its cost cap.', 402)].join('\n'), ['npm test']);
  assert.deepEqual([outcome(refused, ran({ exitCode: 1 }), LIMITS).reason, outcome(refused, ran({ exitCode: 1 }), LIMITS).error], ['provider', 'APIError 402: Bench limit: the attempt reached its cost cap.']);
  const overflow = readEvents([start(0), failure(1, 'ContextOverflowError', 'prompt is too long'), failure(2, 'APIError', 'Bad request', 400)].join('\n'), []);
  assert.equal(outcome(overflow, ran({ exitCode: 1 }), LIMITS).reason, 'context');
  assert.equal(outcome(readEvents(failure(0, 'UnknownError', 'Agent not found: "build".'), []), ran({ exitCode: 1 }), LIMITS).reason, 'error');
  assert.equal(outcome(run, ran(), { steps: 4 }).reason, 'steps', 'Its last step was opencode\'s forced text-only reply.');
  const crashed = outcome(readEvents('', []), ran({ exitCode: 1, stderr: 'Error: Unexpected error\nboom' }), LIMITS);
  assert.deepEqual([crashed.reason, crashed.steps, crashed.error], ['error', 0, 'opencode exited with 1: Error: Unexpected error boom']);
  assert.equal(outcome(readEvents([start(0), say(1, ''), finish(2, 'stop')].join('\n'), []), ran(), LIMITS).reason, 'idle', 'No final message.');
  assert.equal(outcome(readEvents([start(0), say(1, 'Half a thou'), finish(2, 'length')].join('\n'), []), ran(), LIMITS).reason, 'idle', 'Cut off.');
});

test('events are read as unknown: other lines, repeated text parts and missing fields do not break them', () => {
  const noisy = ['WARN  2026-09-25 service=config background dependency install failed', '{"type":"step_start"}', '[]', 'null', '{"type":42}',
    say(1, 'draft', 'prt_same'), say(2, 'final', 'prt_same'), '{"type":"tool_use","part":{"tool":"bash","state":"odd"}}', '{"type":"step_finish","part":{"reason":7,"cost":"1"}}', '{"type":"error"}'].join('\n');
  const run = readEvents(noisy, ['npm test']);
  assert.deepEqual([run.steps, run.finish, run.summary, run.cost, run.reproduced, run.failure, run.errors], [1, null, 'final', 0, false, 'error', ['Error: Error']]);
});

function boxDouble(result: Partial<BoxResult>) {
  const calls: { argv: readonly string[]; options: BoxExecOptions }[] = [], files = new Map<string, string>();
  const quiet: BoxResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
  const box: BenchBox = {
    id: 'double', name: 'perpetual-repair-bench-double', network: 'double', scope: 'double', root: '/workspace', image: 'node:22-bookworm',
    async exec(argv, options = {}) {
      calls.push({ argv, options });
      if (argv[0] === 'sh' && argv[3] === 'sh' && argv[4]) { files.set(argv[4], options.stdin ?? ''); return quiet; }
      return { ...quiet, ...result };
    },
    async diff() { return Buffer.alloc(0); }, async remove() {}, async copyIn() {}, async attachGateway() { return 'http://gateway:8080'; },
  };
  return { box, calls, files };
}

test('an attempt writes INSTRUCTIONS and the config into the box, runs opencode on the prompt, and keeps the token out of every argv and log', async () => {
  const events: AttemptEvent[] = [], access: GatewayAccess = { baseUrl: 'http://127.0.0.1:9/api/v1', boxUrl: BOX_URL, token: TOKEN };
  const attempt = (box: BenchBox, gateway = access) => adapter.runAttempt({ box, system: INSTRUCTIONS, prompt: PROMPT, failing: ['npm test'], model: MODEL, gateway, limits: LIMITS,
    signal: new AbortController().signal, scratch: '/nonexistent', log: event => { events.push(event); } });
  const { box, calls, files } = boxDouble({ stdout: SOLVED, stderr: `WARN  service=provider token=${TOKEN}` });
  const result = await attempt(box);
  assert.deepEqual([result.reason, result.steps, result.reproduced, result.summary], ['done', 4, true, 'The tier check used > instead of >=; npm test passes now.']);
  assert.equal(files.get(BOX.instructions), appendedInstructions('opencode', INSTRUCTIONS));
  assert.ok(files.get(BOX.instructions)!.startsWith(INSTRUCTIONS) && files.get(BOX.instructions)!.endsWith(harnessNote('opencode')));
  assert.deepEqual(JSON.parse(files.get(BOX.config)!), opencodeConfig({ model: MODEL, boxUrl: BOX_URL, token: TOKEN, steps: LIMITS.steps }));
  const run = calls.at(-1)!;
  assert.deepEqual([run.argv, run.options.stdin], [opencodeCommand(MODEL.id), PROMPT], 'The prompt goes on stdin alone, byte for byte.');
  assert.ok(run.options.timeoutMs! > LIMITS.timeMs && run.options.timeoutMs! < LIMITS.timeMs + 30_000, 'It stops by itself between the gateway\'s deadline and the runner\'s abort.');
  assert.ok(calls.every(call => call.argv.every(arg => !arg.includes(TOKEN))), 'No argv holds the token.');
  assert.deepEqual(calls.filter(call => call.options.stdin?.includes(TOKEN)).map(call => call.argv.at(-1)), [BOX.config], 'Only the config file gets it.');
  assert.deepEqual(events.at(-1), { type: 'attempt', exitCode: 0, timedOut: false, truncated: false, reason: 'done', steps: 4, reproduced: true, stderr: 'WARN  service=provider token=[token]' });
  // An error that echoes the token is kept with the token replaced.
  const failed = await attempt(boxDouble({ stdout: `${SOLVED}\n${failure(13, 'ProviderAuthError', `rejected key ${TOKEN}`)}`, exitCode: 1 }).box);
  assert.deepEqual([failed.reason, failed.error], ['provider', 'ProviderAuthError: rejected key [token]']);
  assert.ok(!JSON.stringify(events).includes(TOKEN), 'No logged event holds the token.');
  await assert.rejects(attempt(box, { baseUrl: access.baseUrl, token: TOKEN }), /needs the gateway relay/);
});

test('the adapter runs in the box at the product\'s pinned opencode version, and is ready wherever tar is', async () => {
  assert.deepEqual([adapter.key, adapter.version, adapter.inBox, adapter.harnessPaths], ['opencode', 'opencode-ai@1.18.32', true, undefined]);
  assert.equal(await adapter.available(), null);
});
