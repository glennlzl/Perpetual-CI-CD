// One pi attempt through pi-coding-agent's SDK: pi's own agent session, system prompt, loop and tuned read, bash,
// edit and write tools, whose operations run in the box (operations.ts), plus a done tool. It lives in memory and
// loads nothing from disk or the network: no settings, credentials or model files, no context files (AGENTS.md and the
// like), skills, extensions, prompt templates or themes, and no catalog refresh, cache warming, install telemetry or
// attribution headers. The model is pi's own OpenRouter entry for the id, with pi's per-model compat flags, or one
// built from the bench's model info; either way OpenAI-compatible chat completions at the gateway, which pi streams,
// with the attempt's token as its in-memory key and the bench's context and output limits. INSTRUCTIONS follow pi's own
// system prompt. A turn that calls done, the step limit or a final answer ends the run at the end of that turn, before
// pi's post-run work such as compacting a long conversation; the gateway and the runner enforce cost, requests and time.
import {
  createAgentSession, createBashToolDefinition, createEditToolDefinition, createExtensionRuntime, createReadToolDefinition, createWriteToolDefinition, defineTool,
  ModelRuntime, SessionManager, SettingsManager, type CreateModelRuntimeOptions, type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Api, AssistantMessage, Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { Type } from 'typebox';
import { reproduces } from '../../../../src/repair/workflow.ts';
import { appendedInstructions, type AttemptInput, type AttemptOutcome, type ModelInfo } from '../../harness.ts';
import { boxOperations, loggedOutput, type BoxOperations } from './operations.ts';

// pi reads these when a model runtime is created and on each request: no model catalog from pi.dev, no install
// telemetry or attribution headers, whatever the host environment says, and no version check.
Object.assign(process.env, { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });

/** pi's default tools, working in the box, and done; pi's grep, find and ls are off, as by default, and would run on the host. */
export const TOOLS = ['read', 'bash', 'edit', 'write', 'done'];
/** Two retries of a failed model call, as the product's model calls make, and no prompt-cache warming requests. */
export const SETTINGS: Parameters<typeof SettingsManager.inMemory>[0] = { retry: { enabled: true, maxRetries: 2 }, cacheWarming: 'off', enableInstallTelemetry: false };
/** The product's done tool's description. */
const DONE = 'Ends the attempt: the cause, the change, and the command that now passes, or why the failure cannot be fixed here.';
/** No stored credentials: the gateway token is the model runtime's in-memory key. */
const NO_CREDENTIALS: NonNullable<CreateModelRuntimeOptions['credentials']> = {
  read: async () => undefined, list: async () => [], delete: async () => {},
  modify: async () => { throw new Error('The bench stores no credentials.'); },
};

/**
 * pi's model for an attempt: pi's own OpenRouter entry when it lists the id (a Messages API entry loses its Anthropic
 * compat flags), otherwise one built from the model info; always chat completions at baseUrl, with the bench's limits.
 */
export function piModel(info: ModelInfo, baseUrl: string, listed?: Model<Api>): Model<'openai-completions'> {
  const { compat, ...entry }: Partial<Model<Api>> = listed ?? {};
  return {
    name: info.id, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...entry,
    ...(listed?.api === 'openai-completions' && compat ? { compat: compat as OpenAICompletionsCompat } : {}),
    id: info.id, api: 'openai-completions', provider: 'openrouter', baseUrl, reasoning: info.reasoning, contextWindow: info.contextWindow, maxTokens: info.maxOutput,
  };
}

/** Nothing to load: pi's own system prompt, with INSTRUCTIONS as its appended text. */
export function resourceLoader(append: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [append],
    getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
}

/** pi's own tool definitions over the box, which replace the built-ins of the same names, and done. */
export function piTools(root: string, ops: BoxOperations, done: ToolDefinition) {
  const shell = createBashToolDefinition(root, { operations: ops.bash, exposeSessionEnvironment: false });
  const bash: typeof shell = {
    ...shell,
    async execute(...args) {
      try { const result = await shell.execute(...args); await ops.relocate(result.details?.fullOutputPath); return result; }
      catch (error) { await ops.relocate(loggedOutput(error instanceof Error ? error.message : String(error))); throw error; }
    },
  };
  return [defineTool(createReadToolDefinition(root, { operations: ops.read })), defineTool(bash), defineTool(createEditToolDefinition(root, { operations: ops.edit })),
    defineTool(createWriteToolDefinition(root, { operations: ops.write })), done];
}

export async function runPi(input: AttemptInput): Promise<AttemptOutcome> {
  const { box, model: info, gateway, limits, log } = input;
  const stop = box.signal ? AbortSignal.any([input.signal, box.signal]) : input.signal;
  stop.throwIfAborted();
  const state = { changed: false, reproduced: false, steps: 0, limited: false, summary: null as string | null, last: undefined as AssistantMessage | undefined };
  // The product's rule: a failing step's command failed before any tool wrote a file.
  const ops = boxOperations(box, { signal: stop, events: {
    run(command, exitCode) { if (!state.changed && exitCode !== 0 && reproduces(command, input.failing)) state.reproduced = true; },
    change() { state.changed = true; },
  } });
  // No models.json, no stored credentials, and no availability pass over every provider pi knows (which reads the host
  // environment); setting the key checks OpenRouter alone.
  const runtime = await ModelRuntime.create({ credentials: NO_CREDENTIALS, modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey('openrouter', gateway.token);
  const listed = runtime.getModel('openrouter', info.id);
  const done = defineTool({
    name: 'done', label: 'done', description: DONE, promptSnippet: 'End the attempt with its summary', parameters: Type.Object({ summary: Type.String() }),
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    async execute(_id, { summary }) {
      state.summary = summary.slice(0, 4000);
      return { content: [{ type: 'text', text: 'The attempt is finished.' }], details: { summary: state.summary }, terminate: true };
    },
  });
  const { session } = await createAgentSession({
    cwd: box.root, model: piModel(info, gateway.baseUrl, listed), modelRuntime: runtime, tools: TOOLS, customTools: piTools(box.root, ops, done),
    resourceLoader: resourceLoader(appendedInstructions('pi', input.system)), sessionManager: SessionManager.inMemory(box.root), settingsManager: SettingsManager.inMemory(SETTINGS),
  });
  // pi's documented hook after each turn's tool results: done ends the run even beside other calls in its batch, as
  // does the step limit, counted over answered turns; a final answer would end it anyway. The abort only skips what
  // pi does after a run, which no later turn would use.
  const finish = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    const decision = await finish?.(turn, signal) || undefined;
    if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return decision;
    state.steps += 1;
    const called = turn.toolResults.some(result => result.toolName === 'done' && !result.isError);
    state.limited = !called && state.steps >= limits.steps;
    const answered = turn.message.stopReason === 'stop' && !turn.message.content.some(block => block.type === 'toolCall');
    if (called || state.limited || answered) void session.abort().catch(() => {});
    return called || state.limited ? { action: 'end' as const } : decision;
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') state.last = event.message;
    else if (event.type === 'turn_end' && event.message.role === 'assistant') {
      const { stopReason, errorMessage, content } = event.message;
      log({ type: 'turn', step: state.steps, stop: stopReason, tools: content.flatMap(block => block.type === 'toolCall' ? [block.name] : []), ...(errorMessage ? { error: errorMessage.slice(0, 300) } : {}) });
    } else if (event.type === 'auto_retry_start') log({ type: 'retry', attempt: event.attempt, error: event.errorMessage.slice(0, 300) });
    else if (event.type === 'compaction_end') log({ type: 'compaction', reason: event.reason, aborted: event.aborted, ...(event.errorMessage ? { error: event.errorMessage.slice(0, 300) } : {}) });
  });
  const abort = () => { void session.abort().catch(() => {}); };
  stop.addEventListener('abort', abort, { once: true });
  try {
    stop.throwIfAborted();
    log({ type: 'session', model: info.id, listed: Boolean(listed), thinking: session.thinkingLevel, tools: session.getActiveToolNames() });
    await session.prompt(input.prompt, { expandPromptTemplates: false }).catch((error: unknown) => { if (!stop.aborted) throw error; });
    // Time, a stopped run, or a box removed for writing too much.
    stop.throwIfAborted();
    const stats = session.getSessionStats(), last = state.last;
    const reason: AttemptOutcome['reason'] = state.summary !== null ? 'done' : state.limited ? 'steps' : last?.stopReason !== 'error' ? 'idle' : isContextOverflow(last, info.contextWindow) ? 'context' : 'provider';
    log({ type: 'attempt', end: reason, steps: state.steps, tokens: stats.tokens, cost: stats.cost, reproduced: state.reproduced });
    return {
      reason, steps: state.steps, reproduced: state.reproduced, ...(state.summary !== null ? { summary: state.summary } : {}),
      ...(reason === 'provider' || reason === 'context' ? { error: (last?.errorMessage || 'The model call failed.').slice(0, 1000) } : {}),
      // pi's own price estimate, known for models in its catalog.
      ...(stats.cost > 0 ? { frameworkCost: stats.cost } : {}),
    };
  } finally {
    stop.removeEventListener('abort', abort);
    unsubscribe();
    session.dispose();
  }
}
