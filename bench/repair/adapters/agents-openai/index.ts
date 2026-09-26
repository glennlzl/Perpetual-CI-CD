// The OpenAI track's Agents SDK arm: @openai/agents' own run loop on OpenAI's Responses API, through the SDK's native
// OpenAIResponsesModel over an OpenAI client whose base URL is the gateway and whose key is the attempt's token, so the
// real key stays in the gateway's process. No request keeps state at OpenAI (store false; the loop resends the
// conversation), and a reasoning model's reasoning comes back as encrypted content for the next turn. The agent's tools
// are the product's seven repair tools (src/repair/tools.ts) acting in the box, as non-strict function tools with the
// product's schemas; its instructions are INSTRUCTIONS verbatim; the run stops at done, after limits.steps turns or on
// abort. Tracing is disabled with no trace processor left, and the client reaches only the gateway's base URL, with
// nothing from the environment. The SDK and its client are the bench's own pins, the one install the openai-agents arm
// also loads, and load only for an attempt.
import { readFile } from 'node:fs/promises';
import type { Model, ModelRequest, ModelResponse, ToolInputParameters } from '@openai/agents';
import { redact } from '../../../../src/providers.ts';
import { repairTools } from '../../../../src/repair/tools.ts';
import { reproduces } from '../../../../src/repair/workflow.ts';
import type { Adapter, AttemptEnd, AttemptOutcome, GatewayAccess, ModelInfo } from '../../harness.ts';

type Sdk = typeof import('@openai/agents');
type OpenAIClient = InstanceType<typeof import('openai').OpenAI>;
/** A JSON schema as the SDK takes a non-strict function tool's parameters. */
type LooseSchema = Extract<ToolInputParameters, { additionalProperties: true }>;
export interface PackageState { name: string; pinned: string; installed: string }

const PACKAGES = ['@openai/agents', 'openai'] as const;
// A conversation that outgrew the model's context window, as OpenAI and the product's loop word it.
const CONTEXT = /context_length_exceeded|context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long/i;
// What the client may send the gateway: its own headers, never ones the environment adds (OPENAI_CUSTOM_HEADERS).
const SENT = /^(?:accept|authorization|content-type|user-agent|x-stainless-[\w-]+)$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const json = async (path: string) => { const parsed: unknown = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')); return isRecord(parsed) ? parsed : {}; };

/** Each package's version as the bench's package.json pins it and as npm ci installed it there; empty when absent. */
async function packages(): Promise<PackageState[]> {
  const pins = await json('../../package.json').then(manifest => isRecord(manifest.dependencies) ? manifest.dependencies : {}, () => ({} as Record<string, unknown>));
  return Promise.all(PACKAGES.map(async name => ({
    name, pinned: typeof pins[name] === 'string' ? pins[name] : '',
    installed: await json(`../../node_modules/${name}/package.json`).then(manifest => typeof manifest.version === 'string' ? manifest.version : '', () => ''),
  })));
}
/** Why the pinned packages cannot load here, or null. */
export function readiness(found: readonly PackageState[]) {
  const wrong = found.filter(item => !item.pinned || item.installed !== item.pinned);
  return wrong.length ? `Run npm ci in bench/repair (${wrong.map(item => item.installed ? `${item.name} ${item.installed} is installed, ${item.pinned || 'none'} pinned` : `${item.name} is not installed`).join('; ')}).` : null;
}

/** A fetch that reaches the gateway's base URL with the client's own headers, and refuses anything else. */
export function gatewayOnly(baseUrl: string, fetcher: typeof fetch = fetch): typeof fetch {
  const base = `${baseUrl.replace(/\/+$/, '')}/`;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(base)) throw new Error(`The agents-openai adapter reaches only the gateway, not ${new URL(request.url).origin}.`);
    for (const name of [...request.headers.keys()]) if (!SENT.test(name)) request.headers.delete(name);
    return fetcher(request);
  }) as typeof fetch;
}

/** The attempt's OpenAI client: the gateway's base URL and the attempt's token, and no organization, project or key from the environment. */
const gatewayClient = (OpenAI: typeof import('openai').OpenAI, gateway: GatewayAccess): OpenAIClient => new OpenAI({
  baseURL: gateway.baseUrl, apiKey: gateway.token, adminAPIKey: null, organization: null, project: null, webhookSecret: null, fetch: gatewayOnly(gateway.baseUrl), logLevel: 'off',
});

/** What every request asks: nothing stored at OpenAI, and a reasoning model's reasoning returned encrypted. */
const modelSettings = (model: ModelInfo) => ({ store: false, ...(model.reasoning ? { providerData: { include: ['reasoning.encrypted_content'] } } : {}) });

/**
 * A product tool's JSON schema, read as unknown: the root's copy of ai built it, and the bench's copy, which the Agents
 * SDK's peer pins, types schemas against another zod, so the two are never mixed in one call.
 */
async function schemaOf(name: string, inputSchema: unknown): Promise<LooseSchema> {
  const schema: unknown = isRecord(inputSchema) ? await inputSchema.jsonSchema : undefined;
  if (!isRecord(schema) || schema.type !== 'object') throw new Error(`The ${name} tool has no object schema.`);
  // A non-strict schema reaches the model as given; the SDK types one with additionalProperties: true only.
  return schema as LooseSchema;
}

/**
 * The product's repair tools as the SDK's function tools: the same names, descriptions and JSON schemas, not strict
 * (the product's schemas have optional properties), each result sent as JSON as the product's loop sends it. done only
 * ends the run (toolUseBehavior); its summary is read from the model's call.
 */
async function functionTools(sdk: Pick<Sdk, 'tool'>, tools: ReturnType<typeof repairTools>, signal: AbortSignal) {
  return Promise.all(Object.entries(tools).map(async ([name, product]) => sdk.tool({
    name, description: typeof product.description === 'string' ? product.description : name, strict: false,
    parameters: await schemaOf(name, product.inputSchema),
    execute: async (input: unknown, _context, details) => JSON.stringify(product.execute
      ? await product.execute(input, { toolCallId: details?.toolCall?.callId ?? name, messages: [], abortSignal: signal, context: {} })
      : { ok: true }),
  })));
}

/** What the loop's completed model responses said: how many, their tokens, and the first done call with its summary. */
interface Tally { responses: number; inputTokens: number; outputTokens: number; done: boolean; summary: string }
const summaryOf = (args: string) => {
  try { const input: unknown = JSON.parse(args); return isRecord(input) && typeof input.summary === 'string' ? input.summary.slice(0, 4000) : ''; } catch { return ''; }
};
/** The SDK's Responses model over the client, tallying each completed response. */
function talliedModel(sdk: Pick<Sdk, 'OpenAIResponsesModel'>, client: OpenAIClient, id: string, tally: Tally): Model {
  return new (class extends sdk.OpenAIResponsesModel {
    override async getResponse(request: ModelRequest): Promise<ModelResponse> {
      const response = await super.getResponse(request);
      tally.responses += 1; tally.inputTokens += response.usage.inputTokens; tally.outputTokens += response.usage.outputTokens;
      const done = response.output.find(item => item.type === 'function_call' && item.name === 'done');
      if (!tally.done && done?.type === 'function_call') Object.assign(tally, { done: true, summary: summaryOf(done.arguments) });
      return response;
    }
  })(client, id);
}

async function versions() { return (await packages()).map(item => `${item.name}@${item.installed || 'not installed'}`).join(' + '); }
/** The SDK and its OpenAI client, from the bench's node_modules. */
export const load = () => Promise.all([import('@openai/agents'), import('openai')]);

export const adapter: Adapter = {
  key: 'agents-openai', version: await versions(), inBox: false, providers: { openai: 'responses' },
  async available() { return readiness(await packages()); },
  async runAttempt({ box, system, prompt, failing, model, gateway, limits, signal, log }): Promise<AttemptOutcome> {
    const [sdk, { OpenAI }] = await load();
    // Nothing is traced, and no processor is left that could export a trace to OpenAI.
    sdk.setTracingDisabled(true);
    sdk.setTraceProcessors([]);
    const timeout = AbortSignal.timeout(limits.timeMs), stop = AbortSignal.any([signal, timeout, ...(box.signal ? [box.signal] : [])]);
    const tally: Tally = { responses: 0, inputTokens: 0, outputTokens: 0, done: false, summary: '' };
    let changed = false, reproduced = false;
    const tools = await functionTools(sdk, repairTools(box, { signal: stop, events: { run(command, exitCode) { if (!changed && exitCode !== 0 && reproduces(command, failing)) reproduced = true; }, change() { changed = true; } } }), stop);
    const agent = new sdk.Agent({ name: 'repair', instructions: system, model: talliedModel(sdk, gatewayClient(OpenAI, gateway), model.id, tally), modelSettings: modelSettings(model), tools, toolUseBehavior: { stopAtToolNames: ['done'] } });
    // No model name resolves: OpenAI's default provider is never asked. A call of an unknown tool answers the model with
    // an error, as the product's tools answer theirs, rather than ending the run.
    const runner = new sdk.Runner({ tracingDisabled: true, traceIncludeSensitiveData: false, toolNotFoundBehavior: 'return_error_to_model', modelProvider: { getModel() { throw new Error('The agents-openai adapter runs only the attempt\'s gateway model.'); } } });
    const end = (reason: AttemptEnd, error?: string): AttemptOutcome => {
      log({ type: 'attempt', end: reason, steps: tally.responses, inputTokens: tally.inputTokens, outputTokens: tally.outputTokens, reproduced, ...(error ? { error } : {}) });
      return { reason, steps: tally.responses, summary: tally.summary, reproduced, ...(error ? { error } : {}) };
    };
    try { await runner.run(agent, prompt, { maxTurns: limits.steps, signal: stop }); }
    catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (box.signal?.aborted) throw box.signal.reason;
      if (timeout.aborted) return end('time');
      if (error instanceof sdk.MaxTurnsExceededError) return end('steps');
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      if (CONTEXT.test(message) || isRecord(error) && error.code === 'context_length_exceeded') return end('context', message);
      return end(error instanceof sdk.UserError ? 'error' : 'provider', message);
    }
    if (box.signal?.aborted) throw box.signal.reason;
    return end(tally.done ? 'done' : 'idle');
  },
};
