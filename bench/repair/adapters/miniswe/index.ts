// The mini-swe-agent adapter. mini-swe-agent 2.4.6 from PyPI, pinned in pyproject.toml with every transitive
// dependency locked in uv.lock, is synced into .venv by available() (`uv sync --frozen`, once per process, before any
// attempt) and runs on the host: one `.venv/bin/python driver.py` per attempt, in the attempt's scratch folder, with an
// environment of its own (a fixed PATH, LANG, HOME in scratch, and mini's switches for its banner, its global config
// folder and its retries), never the host's. The job, the attempt's token included, goes over stdin only. driver.py
// runs mini as it ships: DefaultAgent with mini.yaml's templates, INSTRUCTIONS and the harness note appended to its
// system template, the product's prompt as its task, its OpenRouterModel on the gateway (bench_model.py) and its
// DockerEnvironment bridged to the bench box (bench_env.py). Each bash action comes back over fd 3 as a JSON line and
// runs through box.exec in /workspace as DockerEnvironment runs one (mini.yaml's variables, `bash -lc`, stderr merged
// into stdout), and its reply goes back over fd 4; Python never runs docker or anything else on the host.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { capture, type BoxResult } from '../../../../src/repair/box.ts';
import { reproduces } from '../../../../src/repair/workflow.ts';
import { BENCH } from '../../box.ts';
import { appendedInstructions, type Adapter, type AttemptInput, type AttemptLimits, type AttemptOutcome } from '../../harness.ts';

export const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PYTHON = join(HERE, '.venv', 'bin', 'python');
const DRIVER = join(HERE, 'driver.py');
/** Where Python caches the bytecode of the driver and mini: outside the repository, shared by attempts. */
const PYCACHE = join(BENCH, '.cache', 'miniswe-pycache');
/** mini's command timeout, the product's run tool default (mini.yaml sets none, so DockerEnvironment's 30 s would apply), and the most the box allows. */
export const COMMAND = { seconds: 300, most: 900 };
/** A model request's time limit, instead of mini's hard-coded 60 s, and its tries, as the product's AI SDK loop makes them (2 retries) instead of mini's 10. */
export const REQUEST = { seconds: 600, tries: 3 };
/** The end of a command's merged output that mini gets back; mini itself elides long output to its first and last 5,000 characters. */
const OUTPUT = 256 * 1024;
/** Characters of a command, of a line from the driver, and of the driver's own output kept for the log, at most. */
const LIMIT = { command: 1024 * 1024, line: 8 * 1024 * 1024, tail: 16 * 1024 };
// The box's uname fields for mini's templates, then its commit, the base of the reproduced rule.
const PROBE = 'uname -s; uname -n; uname -r; uname -v; uname -m; git rev-parse --verify -q "HEAD^{commit}" 2>/dev/null || true';
// A conversation that outgrew the model's context window, as the product's runAttempt reads one.
const CONTEXT = /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;
// What uv needs to sync the locked environment from PyPI; the attempt's process gets none of it.
const UV_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const firstLine = (text: string) => (text.trim().split('\n')[0] ?? '').slice(0, 300);
const lastLine = (text: string) => (text.trim().split('\n').at(-1) ?? '').slice(0, 300);
const argument = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0');

/** The version uv.lock pins for a package, or null. */
export function lockedVersion(lock: string, name: string) {
  for (const block of lock.split(/^\[\[package\]\]$/m)) if (/^name = "([^"]+)"$/m.exec(block)?.[1] === name) return /^version = "([^"]+)"$/m.exec(block)?.[1] ?? null;
  return null;
}
export const LOCKED = lockedVersion(await readFile(join(HERE, 'uv.lock'), 'utf8').catch(() => ''), 'mini-swe-agent');

/** The driver's whole environment: a fixed PATH, and mini's own switches (no banner, its global config and .env in scratch, the product's tries). */
export const driverEnvironment = (scratch: string): Record<string, string> => ({
  PATH: '/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8',
  MSWEA_SILENT_STARTUP: '1', MSWEA_GLOBAL_CONFIG_DIR: join(scratch, 'mini-swe-agent'), MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT: String(REQUEST.tries),
});

export interface Uname { system: string; node: string; release: string; version: string; machine: string; processor: string }
/** The job driver.py reads from stdin, the only place the token goes. */
export function driverJob({ system, prompt, model, gateway, limits, image, root, uname, trajectory }: Pick<AttemptInput, 'system' | 'prompt' | 'model' | 'gateway' | 'limits'> & {
  image: string; root: string; uname: Uname; trajectory: string;
}) {
  return {
    baseUrl: gateway.baseUrl, token: gateway.token, model: model.id, instructions: appendedInstructions('miniswe', system), prompt, image, root, uname, trajectory,
    stepLimit: limits.steps, costLimit: limits.cost, wallSeconds: Math.max(1, Math.ceil(limits.timeMs / 1000)), commandSeconds: COMMAND.seconds, requestSeconds: REQUEST.seconds,
  };
}

/** A mini command as DockerEnvironment runs one: `env` with mini.yaml's variables, then its interpreter (bash -lc) and the command, stderr merged into stdout in order. */
export const boxCommand = (command: string, env: Readonly<Record<string, string>>, interpreter: readonly string[]) =>
  ['env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'sh', '-c', 'exec 2>&1; exec "$@"', 'sh', ...interpreter, command];

export interface ExecRequest { id: number; command: string; timeout: number; env: Record<string, string>; interpreter: string[] }
export interface DriverResult { exitStatus: string; submission: string; steps: number; cost: number; version: string; errorKind: 'provider' | 'bridge' | 'error' | null; error: string }
export type DriverMessage = { type: 'exec'; request: ExecRequest } | { type: 'result'; result: DriverResult };
type Reply = { output: string; returncode: number; timedOut: boolean } | { error: string };

/** One line from the driver, validated as unknown; null for anything else, which ends the attempt. */
export function readMessage(raw: string): DriverMessage | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value)) return null;
  if (value.type === 'exec') {
    const { id, command, timeout, env, interpreter } = value;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof command !== 'string' || typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1) return null;
    if (!isRecord(env) || Object.keys(env).length > 64 || !Object.entries(env).every(([key, item]) => ENV_KEY.test(key) && argument(item, 4096))) return null;
    if (!Array.isArray(interpreter) || !interpreter.length || interpreter.length > 8 || !interpreter.every(item => argument(item, 256) && item !== '')) return null;
    return { type: 'exec', request: { id, command, timeout, env: env as Record<string, string>, interpreter: interpreter as string[] } };
  }
  if (value.type !== 'result') return null;
  const text = (item: unknown, limit: number) => typeof item === 'string' ? item.slice(0, limit) : '';
  const { steps, cost, errorKind } = value;
  return { type: 'result', result: {
    exitStatus: text(value.exitStatus, 100), submission: text(value.submission, 64 * 1024), version: text(value.version, 50), error: text(value.error, 4000),
    steps: typeof steps === 'number' && Number.isSafeInteger(steps) && steps >= 0 ? steps : 0, cost: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : 0,
    errorKind: errorKind === 'provider' || errorKind === 'bridge' || errorKind === 'error' ? errorKind : null,
  } };
}

/** How mini ended, in the shared terms: its submission is done, LimitsExceeded is its step or cost limit, three replies without a command in a row are idle. */
export function outcomeOf(result: DriverResult, limits: Pick<AttemptLimits, 'steps'>): AttemptOutcome {
  const common = { steps: result.steps, frameworkCost: result.cost };
  if (result.exitStatus === 'Submitted') return { ...common, reason: 'done', summary: result.submission.trim() };
  if (result.exitStatus === 'LimitsExceeded') return { ...common, reason: result.steps >= limits.steps ? 'steps' : 'cost' };
  if (result.exitStatus === 'TimeExceeded') return { ...common, reason: 'time' };
  if (result.exitStatus === 'RepeatedFormatError') return { ...common, reason: 'idle' };
  const error = result.error || `mini-swe-agent ended with ${result.exitStatus || 'no exit status'}.`;
  return { ...common, reason: result.errorKind !== 'provider' ? 'error' : CONTEXT.test(error) ? 'context' : 'provider', error };
}

/**
 * Runs driver.py with the job on stdin, answering its commands with execute one at a time, until it exits. A malformed
 * message or a failing execute kills it and rejects; an abort kills it and rejects with the signal's reason.
 */
async function drive({ job, scratch, signal, execute }: { job: object; scratch: string; signal: AbortSignal; execute(request: ExecRequest, signal: AbortSignal): Promise<Reply> }) {
  signal.throwIfAborted();
  const child = spawn(PYTHON, ['-E', '-s', '-X', 'utf8', '-X', `pycache_prefix=${PYCACHE}`, DRIVER], { cwd: scratch, env: driverEnvironment(scratch), stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  const kill = () => { try { if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  signal.addEventListener('abort', kill, { once: true });
  // Commands in flight stop once the driver is gone.
  const exited = new AbortController(), running = AbortSignal.any([signal, exited.signal]);
  const state: { result: DriverResult | null; failure: unknown; stdout: string; stderr: string } = { result: null, failure: null, stdout: '', stderr: '' };
  child.stdout!.on('data', (chunk: Buffer) => { state.stdout = (state.stdout + chunk.toString('utf8')).slice(-LIMIT.tail); });
  child.stderr!.on('data', (chunk: Buffer) => { state.stderr = (state.stderr + chunk.toString('utf8')).slice(-LIMIT.tail); });
  const requests = child.stdio[3] as Readable, replies = child.stdio[4] as Writable;
  child.stdin!.on('error', () => {});
  replies.on('error', () => {});
  let queue = Promise.resolve();
  createInterface({ input: requests, crlfDelay: Infinity }).on('line', text => {
    queue = queue.then(async () => {
      if (state.failure !== null || state.result) return;
      const message = text.length > LIMIT.line ? null : readMessage(text);
      if (!message) { state.failure = new Error('mini-swe-agent\'s driver sent a malformed message.'); return kill(); }
      if (message.type === 'result') { state.result = message.result; return; }
      try { const reply = await execute(message.request, running); replies.write(`${JSON.stringify({ id: message.request.id, ...reply })}\n`); }
      catch (error) { if (!exited.signal.aborted) { state.failure = error; kill(); } }
    });
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); child.stdin!.end(JSON.stringify(job)); });
    exited.abort();
    await queue;
    signal.throwIfAborted();
    if (state.failure !== null) throw state.failure;
    return { result: state.result, code, stdout: state.stdout, stderr: state.stderr };
  } finally { signal.removeEventListener('abort', kill); kill(); }
}

async function runAttempt({ box, system, prompt, failing, model, gateway, limits, signal, scratch, log }: AttemptInput): Promise<AttemptOutcome> {
  const probe = await box.exec(['sh', '-c', PROBE], { signal, timeoutMs: 30_000 });
  const [name = '', node = '', release = '', version = '', machine = '', head = ''] = probe.stdout.split('\n').map(text => text.trim());
  // reproduced, by the product's rule: a command running a failing step's command exited non-zero before the first
  // change. With only a shell to change files, a change is the box's diff against its starting commit (what the judge
  // gets) turning non-empty; it is read before each such command, until one reproduced or a change was seen.
  const base = /^[a-f\d]{40}$/.test(head) ? head : null, rule = { measurable: base !== null, changed: false, reproduced: false };
  const execute = async ({ command, timeout, env, interpreter }: ExecRequest, running: AbortSignal): Promise<Reply> => {
    if (command.includes('\0')) return { error: 'The command contains a NUL byte.' };
    if (command.length > LIMIT.command) return { error: `The command is longer than ${LIMIT.command} characters.` };
    const candidate = rule.measurable && !rule.reproduced && !rule.changed && reproduces(command, failing);
    if (candidate && base) {
      try { rule.changed = (await box.diff(base)).length > 0; }
      catch (error) { if ((error as { rejected?: unknown }).rejected === true) rule.changed = true; else rule.measurable = false; }
    }
    const started = Date.now();
    let result: BoxResult;
    try { result = await box.exec(boxCommand(command, env, interpreter), { signal: running, timeoutMs: Math.min(timeout, COMMAND.most) * 1000, limit: OUTPUT, keep: 'tail' }); }
    catch (error) {
      if (running.aborted) throw error;
      if (box.signal?.aborted) throw box.signal.reason;
      return { error: String((error as Error)?.message ?? error).slice(0, 1000) };
    }
    if (candidate && rule.measurable && !rule.changed && result.exitCode !== 0) rule.reproduced = true;
    log({ type: 'exec', command: clip(command, 2000), exit: result.exitCode, timedOut: result.timedOut, ms: Date.now() - started });
    return { output: result.stdout + result.stderr, returncode: result.exitCode, timedOut: result.timedOut };
  };
  const job = driverJob({ system, prompt, model, gateway, limits, image: box.image, root: box.root, uname: { system: name, node, release, version, machine, processor: '' }, trajectory: join(scratch, 'trajectory.json') });
  const { result, code, stdout, stderr } = await drive({ job, scratch, signal, execute });
  const reproduced = rule.measurable ? rule.reproduced : null;
  if (!result) {
    log({ type: 'driver', exit: code, stdout: clip(stdout, 4000), stderr: clip(stderr, 4000) });
    return { reason: 'error', steps: 0, reproduced, error: `mini-swe-agent's driver exited (${code ?? 'killed'}) without a result: ${lastLine(stderr) || 'no output'}` };
  }
  const outcome = outcomeOf(result, limits);
  log({ type: 'attempt', version: result.version, exitStatus: result.exitStatus, end: outcome.reason, steps: result.steps, cost: result.cost, reproduced, ...(result.error ? { error: result.error } : {}),
    ...(stdout.trim() ? { stdout: clip(stdout, 4000) } : {}), ...(stderr.trim() ? { stderr: clip(stderr, 4000) } : {}) });
  return { ...outcome, reproduced };
}

/** Syncs the locked environment and checks it holds the locked mini; null when the adapter can run. */
async function check(): Promise<string | null> {
  if (!LOCKED) return 'adapters/miniswe/uv.lock pins no mini-swe-agent.';
  const env = Object.fromEntries(UV_ENVIRONMENT.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key] as string]));
  const uv = await capture('uv', ['--version'], { env, timeoutMs: 30_000 }).catch(() => null);
  if (!uv || uv.exitCode !== 0) return 'Install uv (https://docs.astral.sh/uv/) to run mini-swe-agent.';
  const synced = await capture('uv', ['sync', '--frozen', '--quiet', '--project', HERE], { cwd: HERE, env, timeoutMs: 15 * 60_000 }).catch((error: Error) => ({ exitCode: -1, stderr: error.message }));
  if (synced.exitCode !== 0) return `uv sync --frozen failed in adapters/miniswe: ${firstLine(synced.stderr) || `exit ${synced.exitCode}`}`;
  const installed = await capture(PYTHON, ['-B', '-E', '-s', '-c', 'import importlib.metadata as m; print(m.version("mini-swe-agent"))'], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeoutMs: 60_000 }).catch(() => null);
  const found = installed?.exitCode === 0 ? installed.stdout.trim() : '';
  return found === LOCKED ? null : `adapters/miniswe/.venv holds mini-swe-agent ${found || 'nothing'}, not ${LOCKED}.`;
}
let ready: Promise<string | null> | null = null;

export const adapter: Adapter = {
  key: 'miniswe', version: `mini-swe-agent@${LOCKED ?? 'unknown'}`, inBox: false,
  // Asked by `node run.ts setup` and by each run before any attempt, so the sync is never timed; a failure is asked again.
  available() {
    return ready ??= check().catch((error: Error) => `mini-swe-agent's setup failed: ${error.message}`).then(why => { if (why) ready = null; return why; });
  },
  runAttempt,
};
