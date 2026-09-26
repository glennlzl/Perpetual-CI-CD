// The Codex CLI as the bake-off runs it in a bench box, as pure functions: the config.toml one attempt gets, the
// command line that starts `codex exec --json` with the attempt's token read from stdin, and the reading of its JSONL
// event stream (thread.started, item.*, turn.completed|failed, error) into the shared outcome. index.ts drives the box.
import { reproduces } from '../../../../src/repair/workflow.ts';
import type { AttemptEnd, AttemptEvent } from '../../harness.ts';

/**
 * Where the release and Codex's home live in the box, both outside /workspace; the model provider's id; and the one
 * variable that holds the attempt's token, only in Codex's own process.
 */
export const CODEX = { root: '/opt/bench/codex', bin: '/opt/bench/codex/bin/codex', home: '/opt/bench/codex-home', provider: 'bench', token: 'BENCH_TOKEN' } as const;
/** The box's egress proxy settings: removed from Codex's own process, handed back to the commands it runs. */
export const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
// A conversation that outgrew the context window, as the product reads provider errors (src/repair/agent.ts).
const CONTEXT = /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;
// The items that are one tool or command each; agent messages, reasoning, plans and warnings are not steps.
const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search']);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
const tail = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(-limit) : '';
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** A TOML basic string: JSON's escapes are TOML's, save DEL, which TOML also escapes, and lone surrogates, which it forbids. */
export const tomlString = (value: string) => JSON.stringify(value.toWellFormed()).replace(/\u007f/g, '\\u007F');
const tomlKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
const inlineTable = (entries: Record<string, string>) => `{ ${Object.entries(entries).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ')} }`;

export interface CodexConfig { model: string; contextWindow: number; baseUrl: string; instructions: string; proxy: Readonly<Record<string, string>> }
/**
 * config.toml for one attempt, loaded with --strict-config so a key this Codex does not know fails the run instead of
 * being ignored:
 * - the gateway as the one model provider (Responses API, no WebSocket, no OpenAI login), its key read from BENCH_TOKEN;
 * - the attempt's model and context window, at the default service tier the gateway prices;
 * - no approvals and no sandbox of Codex's own, since the box is the sandbox;
 * - INSTRUCTIONS and the harness note as developer instructions after Codex's own base instructions, which stay;
 * - no web search, apps, plugins, image generation, sub-agents, skills, AGENTS.md, analytics, feedback, OTEL or
 *   Statsig metrics, update check or history file;
 * - commands inherit Codex's environment without the token, with the box's proxy settings set back.
 */
export function configToml({ model, contextWindow, baseUrl, instructions, proxy }: CodexConfig) {
  const window = Math.floor(contextWindow), proxies = Object.fromEntries(PROXY_VARIABLES.flatMap(name => proxy[name] ? [[name, proxy[name]]] : []));
  return [
    '# One bench attempt: the gateway is the only model provider, and the box is the sandbox.',
    `model = ${tomlString(model)}`, `model_provider = ${tomlString(CODEX.provider)}`, ...(Number.isSafeInteger(window) && window > 0 ? [`model_context_window = ${window}`] : []),
    'service_tier = "default"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', 'web_search = "disabled"', 'project_doc_max_bytes = 0',
    'check_for_update_on_startup = false', `developer_instructions = ${tomlString(instructions)}`,
    '', `[model_providers.${CODEX.provider}]`, `name = ${tomlString(CODEX.provider)}`, `base_url = ${tomlString(baseUrl)}`, `env_key = ${tomlString(CODEX.token)}`,
    'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    '', '[shell_environment_policy]', 'inherit = "all"', 'ignore_default_excludes = false', `exclude = [${tomlString(CODEX.token)}]`, ...(Object.keys(proxies).length ? [`set = ${inlineTable(proxies)}`] : []),
    '', '[features]', 'apps = false', 'plugins = false', 'image_generation = false',
    '', '[agents]', 'enabled = false',
    '', '[skills]', 'include_instructions = false', '', '[skills.bundled]', 'enabled = false',
    '', '[analytics]', 'enabled = false', '', '[feedback]', 'enabled = false',
    '', '[otel]', 'exporter = "none"', 'trace_exporter = "none"', 'metrics_exporter = "none"',
    '', '[history]', 'persistence = "none"', '',
  ].join('\n');
}

/**
 * The shell that starts Codex: it reads the token from stdin's first line into BENCH_TOKEN, drops the proxy settings
 * so Codex itself can reach nothing but `gateway`, and becomes Codex, which reads the rest of stdin as the task.
 */
export const LAUNCH = `IFS= read -r ${CODEX.token} || exit 2; export ${CODEX.token}; unset ${PROXY_VARIABLES.join(' ')}; exec "$@"`;
/** The argv of one attempt, for box.exec with stdin `${token}\n${prompt}`: no token, key or prompt in it. */
export const launchArgv = (workspace: string, environment: Readonly<Record<string, string>>) => [
  'env', `CODEX_HOME=${CODEX.home}`, ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), 'sh', '-c', LAUNCH, 'sh',
  CODEX.bin, 'exec', '--json', '--color', 'never', '--strict-config', '--skip-git-repo-check', '--cd', workspace, '-',
];

/** The words of a command line as Codex's shlex join wrote it: single quotes, double quotes and backslashes. */
export function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word = '', quote: '\'' | '"' | null = null, open = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '\'') { if (character === '\'') quote = null; else word += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\' && '$`"\\\n'.includes(line[index + 1] ?? '')) word += line[++index];
      else word += character;
      continue;
    }
    if (character === '\'' || character === '"') { quote = character; open = true; }
    else if (character === '\\' && index + 1 < line.length) { word += line[++index]; open = true; }
    else if (/\s/.test(character)) { if (open) words.push(word); word = ''; open = false; }
    else { word += character; open = true; }
  }
  if (quote) return null;
  if (open) words.push(word);
  return words;
}
/** The script of a `bash -lc '…'` wrapper, as Codex reports the commands it runs; any other command as it is. */
export function shellScript(command: string) {
  const words = shellWords(command);
  return words?.length === 3 && /(?:^|\/)(?:ba|da|z)?sh$/.test(words[0]) && /^-l?c$/.test(words[1]) ? words[2] : command;
}

/** The JSON objects with a string type among stdout's lines; anything else Codex or the shell printed is skipped. */
export function readEvents(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
    try { const value: unknown = JSON.parse(trimmed); return isRecord(value) && typeof value.type === 'string' ? [value] : []; } catch { return []; }
  });
}

export interface CodexUsage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }
export interface CodexExit { exitCode: number; timedOut: boolean; truncated: boolean; stderr: string }
export interface CodexRun {
  end: AttemptEnd; steps: number; summary: string; error: string; reproduced: boolean;
  turn: 'completed' | 'failed' | null; usage: CodexUsage | null; events: AttemptEvent[];
}

/** One completed item as a compact log event; tool output only as its tail. */
function itemEvent(item: Record<string, unknown>): AttemptEvent {
  const status = text(item.status, 40);
  switch (item.type) {
    case 'command_execution': return { type: 'codex.command', command: text(item.command, 2000), exitCode: typeof item.exit_code === 'number' ? item.exit_code : null, status, output: tail(item.aggregated_output, 2000) };
    case 'file_change': return { type: 'codex.file_change', status, changes: (Array.isArray(item.changes) ? item.changes.filter(isRecord) : []).slice(0, 50).map(change => ({ path: text(change.path, 300), kind: text(change.kind, 20) })) };
    case 'mcp_tool_call': return { type: 'codex.tool', item: item.type, name: `${text(item.server, 100)}/${text(item.tool, 100)}`, status };
    case 'collab_tool_call': return { type: 'codex.tool', item: item.type, name: text(item.tool, 100), status };
    case 'web_search': return { type: 'codex.tool', item: item.type, name: text(item.query, 300), status };
    case 'agent_message': return { type: 'codex.message', text: text(item.text) };
    case 'reasoning': return { type: 'codex.reasoning', text: text(item.text, 2000) };
    case 'todo_list': return { type: 'codex.plan', items: Array.isArray(item.items) ? item.items.length : 0 };
    case 'error': return { type: 'codex.warning', message: text(item.message, 1000) };
    default: return { type: 'codex.item', item: text(item.type, 100) };
  }
}

/**
 * An attempt from Codex's events and exit, validated as unknown:
 * - steps are completed tool and command items;
 * - the summary is the last agent message;
 * - `reproduced` holds when a command that ran one of the failing steps' commands exited non-zero before the first
 *   applied file change, the product's rule, applied to the script inside Codex's `bash -lc` wrapper.
 *
 * The end is `time` when the box's time limit stopped Codex. A completed turn is `done` when it ends with a message,
 * which is how Codex finishes, else `idle`. A failed turn is `context` or `provider`, a gateway refusal included.
 * No terminal event at all is `error`.
 */
export function readRun(events: readonly Record<string, unknown>[], failing: readonly string[], exit: CodexExit): CodexRun {
  const log: AttemptEvent[] = [];
  let steps = 0, changed = false, reproduced = false, summary = '', error = '', turn: CodexRun['turn'] = null, usage: CodexUsage | null = null;
  const message = (value: unknown) => text(isRecord(value) ? value.message : value, 1000);
  for (const event of events) {
    if (event.type === 'thread.started') log.push({ type: 'codex.thread', id: text(event.thread_id, 100) });
    else if (event.type === 'turn.completed') {
      turn = 'completed';
      const reported = isRecord(event.usage) ? event.usage : {};
      usage = { input: count(reported.input_tokens), cached: count(reported.cached_input_tokens), cacheWrite: count(reported.cache_write_input_tokens), output: count(reported.output_tokens), reasoning: count(reported.reasoning_output_tokens) };
      log.push({ type: 'codex.turn', status: 'completed', usage });
    } else if (event.type === 'turn.failed') {
      turn = 'failed';
      error = message(event.error) || error || 'The turn failed.';
      log.push({ type: 'codex.turn', status: 'failed', error });
    } else if (event.type === 'error') {
      // Codex reports errors it retries too, so only a turn that never completed takes one as its error.
      const said = message(event);
      if (turn !== 'failed' && said) error = said;
      log.push({ type: 'codex.error', message: said });
    } else if (event.type === 'item.completed' && isRecord(event.item)) {
      const item = event.item;
      log.push(itemEvent(item));
      if (typeof item.type === 'string' && TOOL_ITEMS.has(item.type)) steps += 1;
      if (item.type === 'agent_message' && typeof item.text === 'string') summary = item.text.slice(0, 4000);
      if (item.type === 'file_change' && item.status === 'completed') changed = true;
      if (item.type === 'command_execution' && !changed && typeof item.exit_code === 'number' && item.exit_code !== 0 && typeof item.command === 'string'
        && reproduces(shellScript(item.command), failing)) reproduced = true;
    }
  }
  let end: AttemptEnd;
  if (exit.timedOut) end = 'time';
  else if (turn === 'completed') end = summary.trim() ? 'done' : 'idle';
  else if (turn === 'failed') end = CONTEXT.test(error) ? 'context' : 'provider';
  else {
    end = 'error';
    const said = exit.stderr.trim().split('\n').filter(Boolean).slice(-5).join(' ').slice(0, 1000);
    error = [exit.truncated ? 'Codex\'s event stream outgrew what the bench keeps.' : '', error || said || `Codex exited with code ${exit.exitCode} before a turn ended.`].filter(Boolean).join(' ');
  }
  return { end, steps, summary, error: end === 'done' || end === 'idle' ? '' : error, reproduced, turn, usage, events: log };
}
