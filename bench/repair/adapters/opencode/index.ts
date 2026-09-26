// opencode (opencode-ai at the product's OPENCODE_VERSION) running inside the bench box, headless: `opencode run
// --format json` with its own build agent and tuned system prompt, the product's INSTRUCTIONS appended through its
// `instructions` file, and the prompt alone on stdin, so it is the first user message byte for byte. Its bundled
// OpenRouter provider (@openrouter/ai-sdk-provider) points at the gateway's box URL with the attempt's token, which only
// the 0600 config file in the box holds, never an argv or the environment. Its tools act in /workspace as root, as the
// product's run tool does: reading, searching, editing and commands are allowed; other folders, web tools, subagents,
// skills, questions and LSP are denied, each by name. Its Linux binary, and the ripgrep it would otherwise download on
// first use, are fetched lazily on the first prepare, checked against the digests pinned below, cached in .cache/opencode
// and copied to /opt/bench, outside /workspace. With project config, snapshots, formatters, LSP and plan mode off it
// writes nothing under /workspace, so it has no harnessPaths.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OPENCODE_VERSION } from '../../../../src/agents/opencode.ts';
import { capture } from '../../../../src/repair/box.ts';
import { reproduces } from '../../../../src/repair/workflow.ts';
import { BENCH, gatewayEnvironment } from '../../box.ts';
import { appendedInstructions, type Adapter, type AttemptEvent, type AttemptLimits, type AttemptOutcome, type ModelInfo } from '../../harness.ts';

/** The opencode release the digests below were read for (npm registry, 2026-09-25); the product's OPENCODE_VERSION must match. */
export const PINNED = '1.18.32';
/** The ripgrep release opencode 1.18.32 downloads for itself (packages/core/src/ripgrep/binary.ts). */
export const RIPGREP = '15.1.0';
export type Variant = 'arm64' | 'x64' | 'x64-baseline';
/**
 * Each box machine's glibc platform package with its registry integrity, as opencode's installer picks one (the baseline
 * build for an x64 CPU without AVX2), and the ripgrep build opencode picks for that machine with its release sha256.
 */
export const PACKAGES: Record<Variant, { name: string; integrity: string; ripgrep: string; sha256: string }> = {
  arm64: { name: 'opencode-linux-arm64', integrity: 'sha512-SDMw716oYxxJ9CWDO5roCpziw98ANwPZSz6L8evUOHkFCq6OU31xZGQwv/T1ROJnoPNJKWODmm1vzS6s6uEgUA==',
    ripgrep: 'aarch64-unknown-linux-gnu', sha256: '2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e' },
  x64: { name: 'opencode-linux-x64', integrity: 'sha512-CIatvoyi8V5a56xyw6ZUnsKxB9wqYIZqfNeqUNWhBBY4aENAm907LP0xXAwL6tR0cYbqNl2+Dvx8mOqXIxbDeQ==',
    ripgrep: 'x86_64-unknown-linux-musl', sha256: '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599' },
  'x64-baseline': { name: 'opencode-linux-x64-baseline', integrity: 'sha512-XXO4htNdJEoj935NGMYNGjD1M8ZiJPo2u2cQzIyeBjinoClI7iXOHBPw+Twm/ZuzFHKtmI2594bt0GWIwTetkw==',
    ripgrep: 'x86_64-unknown-linux-musl', sha256: '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599' },
};

/** Where opencode lives in the box: its binary, config, instructions and its own XDG folders, all outside /workspace. */
export const BOX = { root: '/opt/bench', bin: '/opt/bench/bin/opencode', config: '/opt/bench/opencode.json', instructions: '/opt/bench/INSTRUCTIONS.md', home: '/opt/bench/opencode' } as const;
const XDG = { XDG_CONFIG_HOME: `${BOX.home}/config`, XDG_DATA_HOME: `${BOX.home}/data`, XDG_CACHE_HOME: `${BOX.home}/cache`, XDG_STATE_HOME: `${BOX.home}/state` };
// The tree copied to BOX.root. ripgrep goes where opencode would download it: $XDG_CACHE_HOME/opencode/bin/rg.
const TREE = { bin: 'bin/opencode', rg: 'opencode/cache/opencode/bin/rg' };
const CACHE = join(BENCH, '.cache', 'opencode', OPENCODE_VERSION);
const MAX_DOWNLOAD = 400 * 1024 ** 2;
/** Bytes of opencode's JSON event stream kept; a 100-step attempt stays far below it. */
const OUTPUT = 64 * 1024 ** 2;

/**
 * opencode 1.18.32's permission, every key that version has named and none left to ask: read, search and edit files and
 * run commands in /workspace; no other folder (opencode keeps its own truncated tool output readable); no web tools,
 * subagents, skills, questions or LSP. Named rather than "*", since a later rule wins and key order is not guaranteed.
 */
export const PERMISSION = {
  read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow', bash: 'allow', todowrite: 'allow', doom_loop: 'allow',
  external_directory: { '*': 'deny' }, task: 'deny', question: 'deny', webfetch: 'deny', websearch: 'deny', lsp: 'deny', skill: 'deny',
} as const;

/**
 * opencode.json for one attempt: the gateway as the OpenRouter provider with the attempt's token, the one model in every
 * model slot with its limits, INSTRUCTIONS as an instructions file, the build agent's step limit, and no updates,
 * sharing, snapshots, formatters or language servers. A denial is feedback to the model, never the end of the loop.
 */
export function opencodeConfig({ model, boxUrl, token, steps }: { model: ModelInfo; boxUrl: string; token: string; steps: number }) {
  const id = `openrouter/${model.id}`;
  return {
    autoupdate: false, share: 'disabled', snapshot: false, formatter: false, lsp: false, instructions: [BOX.instructions],
    model: id, small_model: id, enabled_providers: ['openrouter'],
    provider: { openrouter: { npm: '@openrouter/ai-sdk-provider', options: { baseURL: boxUrl, apiKey: token },
      models: { [model.id]: { tool_call: true, reasoning: model.reasoning, status: 'active', limit: { context: model.contextWindow, output: model.maxOutput } } } } },
    permission: PERMISSION, agent: { build: { steps } }, experimental: { continue_loop_on_deny: true },
  };
}

/**
 * What opencode's process adds to the box's environment: gateway in NO_PROXY, its own XDG folders, its config, and no
 * project config, updates, model catalog fetch, plugins, LSP downloads, Claude Code files or external skills. HOME stays
 * the box's, since opencode's bash tool passes its whole environment to the commands it runs.
 */
export const opencodeEnvironment = (): Record<string, string> => ({
  ...gatewayEnvironment(), ...XDG, OPENCODE_CONFIG: BOX.config, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
});
const env = (values: Record<string, string>) => ['env', ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
/** One headless run of the build agent, its warnings on stderr; the prompt goes on stdin, with no message argument. */
export const opencodeCommand = (model: string) => [...env(opencodeEnvironment()), BOX.bin, '--print-logs', '--log-level', 'WARN', 'run', '--agent', 'build', '--model', `openrouter/${model}`, '--title', 'bench', '--format', 'json'];

// ── The run's events ────────────────────────────────────────────────────────────────────────────────────────────────
/** What a run's JSON events say: steps, the last step's finish and text, reproduced, errors and opencode's own cost. */
export interface RunEvents { steps: number; finish: string | null; summary: string; reproduced: boolean; errors: string[]; failure: 'context' | 'provider' | 'error' | null; cost: number; events: AttemptEvent[] }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clip = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** The tools that change files; a failing command reproduces only before the first of them completes, as in the product. */
const EDITS = new Set(['edit', 'write', 'apply_patch']);
const PROVIDER = new Set(['APIError', 'ProviderAuthError', 'ContentFilterError']);
// The product's reading of a conversation that outgrew the model's context window (src/repair/agent.ts).
const CONTEXT = /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;

/**
 * opencode 1.18.32's `--format json` stream, each line read as unknown: step_start, text (a finished text part),
 * tool_use (a completed or failed tool part), step_finish and error. The summary is the last step's text; a bash
 * command reproduced the failure when the product's rule matches it, it exited non-zero (or was killed) and no edit,
 * write or apply_patch had completed yet.
 */
export function readEvents(output: string, failing: readonly string[]): RunEvents {
  const run: RunEvents = { steps: 0, finish: null, summary: '', reproduced: false, errors: [], failure: null, cost: 0, events: [] };
  let texts = new Map<string, string>(), changed = false, first: number | undefined;
  const failed = (kind: 'context' | 'provider' | 'error') => { if (run.failure !== 'context' && (kind !== 'error' || !run.failure)) run.failure = kind; };
  for (const line of output.split('\n')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event) || typeof event.type !== 'string') continue;
    const part = isRecord(event.part) ? event.part : {}, at = finite(event.timestamp);
    first ??= at;
    const ms = at !== undefined && first !== undefined ? { ms: at - first } : {};
    if (event.type === 'step_start') texts = new Map();
    else if (event.type === 'text' && typeof part.text === 'string') texts.set(typeof part.id === 'string' ? part.id : String(texts.size), part.text);
    else if (event.type === 'step_finish') {
      const tokens = isRecord(part.tokens) ? part.tokens : {}, cache = isRecord(tokens.cache) ? tokens.cache : {};
      run.steps += 1;
      run.finish = clip(part.reason, 50) || null;
      run.cost += Math.max(0, finite(part.cost) ?? 0);
      run.events.push({ type: 'step', step: run.steps, finish: run.finish, tokens: { input: finite(tokens.input), output: finite(tokens.output), reasoning: finite(tokens.reasoning), cached: finite(cache.read) }, ...ms });
    } else if (event.type === 'tool_use') {
      const state = isRecord(part.state) ? part.state : {}, input = isRecord(state.input) ? state.input : {}, metadata = isRecord(state.metadata) ? state.metadata : {};
      const tool = clip(part.tool, 100), done = state.status === 'completed', command = tool === 'bash' && typeof input.command === 'string' ? input.command : null;
      const exit = command !== null && done ? finite(metadata.exit) ?? null : undefined;
      if (command !== null && exit !== undefined && exit !== 0 && !changed && reproduces(command, failing)) run.reproduced = true;
      if (done && EDITS.has(tool)) changed = true;
      run.events.push({ type: 'tool', tool, status: clip(state.status, 20), ...(command === null ? {} : { command: command.slice(0, 500) }), ...(exit === undefined ? {} : { exit }),
        ...(typeof input.filePath === 'string' ? { path: input.filePath.slice(0, 300) } : {}), ...(done ? {} : { error: clip(state.error, 500) }), ...ms });
    } else if (event.type === 'error') {
      const error = isRecord(event.error) ? event.error : {}, data = isRecord(error.data) ? error.data : {};
      const name = clip(error.name, 100) || 'Error', message = clip(data.message, 1000) || name, status = finite(data.statusCode);
      failed(name === 'ContextOverflowError' || CONTEXT.test(message) ? 'context' : PROVIDER.has(name) ? 'provider' : 'error');
      run.errors.push(`${name}${status === undefined ? '' : ` ${status}`}: ${message}`);
      run.events.push({ type: 'error', name, message, ...(status === undefined ? {} : { status }), ...ms });
    }
  }
  run.summary = [...texts.values()].join('\n').trim().slice(0, 4000);
  return run;
}

/**
 * How the attempt ended in opencode's terms: its own time limit, then an error the session reported (a gateway refusal
 * included), then its step limit (whose last step is opencode's forced text-only reply), then a crash; otherwise done
 * when its last step stopped with a final message, and idle when it stopped without one.
 */
export function outcome(run: RunEvents, ran: { exitCode: number; timedOut: boolean; stderr: string }, limits: Pick<AttemptLimits, 'steps'>): AttemptOutcome {
  const base = { steps: run.steps, summary: run.summary, reproduced: run.reproduced, ...(run.cost > 0 ? { frameworkCost: run.cost } : {}) }, error = run.errors.join('\n').slice(0, 1000);
  if (ran.timedOut) return { ...base, reason: 'time', ...(error ? { error } : {}) };
  if (run.failure) return { ...base, reason: run.failure, error };
  if (run.steps >= limits.steps) return { ...base, reason: 'steps' };
  if (ran.exitCode !== 0) return { ...base, reason: 'error', error: `opencode exited with ${ran.exitCode}: ${ran.stderr.trim().split('\n').slice(-3).join(' ').slice(-600) || 'no output'}` };
  return { ...base, reason: run.finish === 'stop' && run.summary ? 'done' : 'idle' };
}

// ── The binaries ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The package for a box, from `uname -m` and whether its CPU lists avx2, as opencode's own installer chooses. */
export function variantOf(probe: string): Variant {
  const [machine = '', ...flags] = probe.trim().split(/\s+/);
  if (/^(?:aarch64|arm64)$/.test(machine)) return 'arm64';
  if (/^(?:x86_64|amd64)$/.test(machine)) return flags.includes('avx2') ? 'x64' : 'x64-baseline';
  throw new Error(`opencode ${OPENCODE_VERSION} has no Linux build for ${machine || 'this machine'}.`);
}

/** Streams url to file, refusing it unless its digest is the pinned one. */
async function download(url: string, file: string, check: { algorithm: 'sha256' | 'sha512'; encoding: 'hex' | 'base64'; digest: string }, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  const hash = createHash(check.algorithm), handle = await open(file, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) throw new Error(`${url} is larger than ${MAX_DOWNLOAD / 1024 ** 2} MB.`);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally { await handle.close(); }
  if (hash.digest(check.encoding) !== check.digest) throw new Error(`${url} does not match its pinned ${check.algorithm}.`);
}

/** One member of a verified archive, unpacked by the host's tar to destination, executable. */
async function unpack(archive: string, member: string, destination: string, signal: AbortSignal) {
  const into = await mkdtemp(join(dirname(archive), 'unpacked-'));
  const result = await capture('tar', ['-xzf', archive, '-C', into, member], { timeoutMs: 5 * 60_000, signal });
  if (result.exitCode !== 0) throw new Error(`Could not unpack ${member}: ${result.stderr.trim().split('\n')[0] || 'tar failed'}`);
  await mkdir(dirname(destination), { recursive: true });
  await rename(join(into, member), destination);
  await chmod(destination, 0o755);
}

const complete = async (dir: string) => (await Promise.all(Object.values(TREE).map(path => stat(join(dir, path)).then(info => info.isFile(), () => false)))).every(Boolean);
/** The verified tree for a variant, fetched once into .cache/opencode/<version>/<variant> and moved there only when whole. */
async function fetchTree(variant: Variant, signal: AbortSignal) {
  const target = join(CACHE, variant), pack = PACKAGES[variant];
  if (await complete(target)) return target;
  await rm(target, { recursive: true, force: true });
  await mkdir(CACHE, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(CACHE, `.${variant}-`)), tree = join(work, 'tree'), stop = AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]);
  try {
    const npm = join(work, 'opencode.tgz'), rg = join(work, 'ripgrep.tar.gz'), folder = `ripgrep-${RIPGREP}-${pack.ripgrep}`;
    await download(`https://registry.npmjs.org/${pack.name}/-/${pack.name}-${OPENCODE_VERSION}.tgz`, npm, { algorithm: 'sha512', encoding: 'base64', digest: pack.integrity.replace(/^sha512-/, '') }, stop);
    await download(`https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP}/${folder}.tar.gz`, rg, { algorithm: 'sha256', encoding: 'hex', digest: pack.sha256 }, stop);
    await unpack(npm, 'package/bin/opencode', join(tree, TREE.bin), stop);
    await unpack(rg, `${folder}/rg`, join(tree, TREE.rg), stop);
    // Another process may have finished first; its tree is as good as this one.
    await rename(tree, target).catch(async error => { if (!await complete(target)) throw error; });
    return target;
  } finally { await rm(work, { recursive: true, force: true }); }
}
const trees = new Map<Variant, Promise<string>>();
/** The tree for a variant, shared by concurrent attempts; a failed fetch is tried again by the next attempt. */
function binaries(variant: Variant, signal: AbortSignal) {
  let pending = trees.get(variant);
  if (!pending) {
    pending = fetchTree(variant, signal);
    trees.set(variant, pending);
    pending.catch(() => trees.delete(variant));
  }
  return pending;
}

export const adapter: Adapter = {
  key: 'opencode', version: `opencode-ai@${OPENCODE_VERSION}`, inBox: true,
  async available() {
    if (OPENCODE_VERSION !== PINNED) return `The product runs opencode ${OPENCODE_VERSION}, but adapters/opencode pins the digests of ${PINNED}.`;
    const tar = await capture('tar', ['--version'], { timeoutMs: 10_000 }).catch(() => null);
    return tar?.exitCode === 0 ? null : 'Install tar, which unpacks the opencode binary on first use.';
  },
  async prepare(box, signal) {
    const probe = await box.exec(['sh', '-c', 'uname -m; grep -qw avx2 /proc/cpuinfo && echo avx2; true'], { signal, timeoutMs: 30_000 });
    const variant = variantOf(probe.stdout);
    await box.copyIn(await binaries(variant, signal), BOX.root);
    const started = await box.exec([...env(XDG), BOX.bin, '--version'], { signal, timeoutMs: 120_000 });
    if (started.exitCode !== 0 || !started.stdout.trim().split(/\s+/).includes(OPENCODE_VERSION)) {
      throw new Error(`${PACKAGES[variant].name} ${OPENCODE_VERSION} did not start in the box: ${(started.stderr || started.stdout).trim().split('\n').at(-1) ?? ''}`.slice(0, 500));
    }
  },
  async runAttempt({ box, system, prompt, failing, model, gateway, limits, signal, log }): Promise<AttemptOutcome> {
    if (!gateway.boxUrl) throw new Error('opencode runs in the box and needs the gateway relay.');
    const write = async (path: string, content: string) => {
      const written = await box.exec(['sh', '-c', 'umask 077 && cat > "$1"', 'sh', path], { stdin: content, signal, timeoutMs: 30_000 });
      if (written.exitCode !== 0) throw new Error(`Could not write ${path} in the box.`);
    };
    await write(BOX.instructions, appendedInstructions('opencode', system));
    await write(BOX.config, `${JSON.stringify(opencodeConfig({ model, boxUrl: gateway.boxUrl, token: gateway.token, steps: limits.steps }), null, 2)}\n`);
    // Its own limit falls between the gateway's deadline and the runner's abort, so a command still running then ends as time.
    const ran = await box.exec(opencodeCommand(model.id), { stdin: prompt, signal, timeoutMs: limits.timeMs + 10_000, limit: OUTPUT });
    const hide = (text: string) => gateway.token ? text.split(gateway.token).join('[token]') : text, stderr = hide(ran.stderr);
    const run = readEvents(hide(ran.stdout), failing), ended = outcome(run, { exitCode: ran.exitCode, timedOut: ran.timedOut, stderr }, limits);
    for (const event of run.events) log(event);
    log({ type: 'attempt', exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, reason: ended.reason, steps: run.steps, reproduced: run.reproduced, ...(stderr.trim() ? { stderr: stderr.trim().slice(-2000) } : {}) });
    return ended;
  },
};
