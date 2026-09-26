// The OpenAI Agents SDK arm: the SDK's Runner drives an Agent whose instructions are the product's INSTRUCTIONS,
// verbatim; whose model is the product's own OpenRouter model (the baseline's factory, its fetch sent to the gateway
// with the attempt's token as the key) wrapped by the SDK's AI SDK adapter (@openai/agents-extensions/ai-sdk), which
// round-trips OpenRouter's reasoning details; and whose tools are the product's seven repair tools acting in the box
// (tools.ts). The provider, tools and wire format are the baseline's, so only the loop differs. A run ends at the done
// tool (stopAtToolNames), after limits.steps turns (maxTurns), when the model answers with text and no tool call, or
// at limits.timeMs. Tracing is off with OpenAI's exporter removed, and the runner resolves no model by name, so nothing
// reaches OpenAI and no OpenAI key is read.
import { readFile } from 'node:fs/promises';
import { Agent, AgentsError, MaxTurnsExceededError, RunContext, RunToolCallItem, Runner, setTraceProcessors, setTracingDisabled, type ModelProvider, type RunItem } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { APICallError } from 'ai';
import { redact } from '../../../../src/providers.ts';
import { openrouterModels } from '../../../../src/repair/agent.ts';
import { repairTools } from '../../../../src/repair/tools.ts';
import { reproduces } from '../../../../src/repair/workflow.ts';
import type { Adapter, AttemptOutcome, GatewayAccess, ModelInfo } from '../../harness.ts';
import { gatewayFetch } from '../aisdk/index.ts';
import { DONE, agentTools } from './tools.ts';

// Importing @openai/agents registers OpenAI's trace exporter and reads OPENAI_AGENTS_DISABLE_TRACING once; tracing is
// switched off here and the exporter removed, so no span is made or sent whatever the environment holds.
setTracingDisabled(true);
setTraceProcessors([]);

// A conversation that outgrew the model's context window, read as the product reads one (CONTEXT in src/repair/agent.ts).
const CONTEXT = /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;
/** The runner's model provider: the agent carries its model, so a model name is never resolved to an OpenAI model. */
export const NO_NAMED_MODELS: ModelProvider = { async getModel(name) { throw new Error(`The bench gives the agent its model; ${name || 'the default model'} is not resolved.`); } };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** The model endpoint's error as the product's loop words it: the status code and message of an API call error. */
function providerMessage(error: unknown) {
  if (APICallError.isInstance(error)) return error.statusCode === undefined ? error.message : JSON.stringify({ code: error.statusCode, message: error.message });
  return error instanceof Error ? error.message : String(error);
}

/**
 * The agent and runner of one attempt, with the SDK's defaults except: the done tool ends the run; no model name is
 * resolved and tracing is off; and a call to an unknown tool answers the model with an error, as the AI SDK loop
 * does, where the SDK's default would end the run.
 */
export function repairAgent({ system, model, gateway, tools }: { system: string; model: ModelInfo; gateway: GatewayAccess; tools: Awaited<ReturnType<typeof agentTools>> }) {
  const language = openrouterModels({ fetch: gatewayFetch(gateway.baseUrl) })(model.id, gateway.token);
  if (typeof language === 'string') throw new Error('The product\'s OpenRouter factory returned a model id instead of a model.');
  const agent = new Agent({ name: 'repair', instructions: system, model: aisdk(language), tools, toolUseBehavior: { stopAtToolNames: [DONE] } });
  const runner = new Runner({ modelProvider: NO_NAMED_MODELS, tracingDisabled: true, toolNotFoundBehavior: 'return_error_to_model' });
  return { agent, runner };
}

/** The run's done call and its summary, read from its input as the product reads one; a malformed input has none. */
export function doneCall(items: readonly RunItem[]): { summary: string } | null {
  for (const item of items) {
    if (!(item instanceof RunToolCallItem) || item.rawItem.type !== 'function_call' || item.rawItem.name !== DONE) continue;
    let input: unknown = null;
    try { input = JSON.parse(item.rawItem.arguments); } catch { /* no summary */ }
    return { summary: isRecord(input) && typeof input.summary === 'string' ? input.summary.slice(0, 4000) : '' };
  }
  return null;
}

/** The versions under test: the SDK and its AI SDK adapter from the bench, and the product's OpenRouter provider. */
async function versions() {
  const version = async (path: string) => {
    const parsed: unknown = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : 'unknown';
  };
  const [agents, extensions, provider] = await Promise.all(['../../node_modules/@openai/agents/package.json', '../../node_modules/@openai/agents-extensions/package.json',
    '../../../../node_modules/@openrouter/ai-sdk-provider/package.json'].map(version));
  return `@openai/agents@${agents} + @openai/agents-extensions@${extensions} + @openrouter/ai-sdk-provider@${provider}`;
}

export const adapter: Adapter = {
  key: 'openai-agents', version: await versions().catch(() => '@openai/agents'), inBox: false,
  async available() { return null; },
  async runAttempt({ box, system, prompt, failing, model, gateway, limits, signal, log }): Promise<AttemptOutcome> {
    const timeout = AbortSignal.timeout(limits.timeMs), stop = AbortSignal.any([signal, timeout, ...(box.signal ? [box.signal] : [])]);
    let changed = false, reproduced = false;
    const tools = await agentTools(repairTools(box, { signal: stop, events: { run(command, exitCode) { if (!changed && exitCode !== 0 && reproduces(command, failing)) reproduced = true; }, change() { changed = true; } } }));
    const { agent, runner } = repairAgent({ system, model, gateway, tools }), context = new RunContext();
    // Steps are the model responses the run received, as the SDK counts its requests.
    const outcome = (reason: AttemptOutcome['reason'], extra: Partial<AttemptOutcome> = {}): AttemptOutcome => {
      const { requests: steps, inputTokens, outputTokens } = context.usage;
      log({ type: 'attempt', end: reason, steps, inputTokens, outputTokens, reproduced });
      return { reason, steps, reproduced, ...extra };
    };
    try {
      const result = await runner.run(agent, prompt, { maxTurns: limits.steps, signal: stop, context });
      if (box.signal?.aborted) throw box.signal.reason;
      const done = doneCall(result.newItems);
      return done ? outcome('done', done) : outcome('idle');
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (box.signal?.aborted) throw box.signal.reason;
      if (timeout.aborted) return outcome('time');
      if (error instanceof MaxTurnsExceededError) return outcome('steps');
      const message = redact(providerMessage(error)).slice(0, 1000);
      if (CONTEXT.test(message)) return outcome('context', { error: message });
      // The SDK's own errors (a model behaving outside its rules) end the attempt as errors; the rest came from the
      // model endpoint: an HTTP error such as the gateway's 402, no connection, or a response the provider rejected.
      return outcome(error instanceof AgentsError ? 'error' : 'provider', { error: message });
    }
  },
};
