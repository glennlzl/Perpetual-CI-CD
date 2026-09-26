// The bench's model gateway: the one base URL every framework under test uses, for one upstream provider per run (or a
// fake upstream in tests and dry runs). It listens on 127.0.0.1, authenticates each caller by a random per-attempt
// token (the only "API key" a framework or box ever sees), and forwards with the real key added here:
// - OpenRouter, the default: POST /api/v1/chat/completions, forcing provider.data_collection=deny and
//   usage.include=true, and recording OpenRouter's reported usage and cost from the JSON body or the final SSE chunk;
// - OpenAI: POST /api/v1/chat/completions and POST /api/v1/responses to https://api.openai.com/v1 at the Standard
//   tier, with store=false on a Responses request that does not chain with previous_response_id and usage asked of a
//   streamed chat completion, pricing each request from its reported usage with prices/openai.json, since OpenAI
//   reports no dollars. Hosted tools, billed per call and reaching the network outside the box, and unpriced models
//   are refused before anything is forwarded.
// Either way it applies one reasoning policy to every framework, and refuses a request once its attempt's cap, the
// run's global budget, its request limit or its deadline is reached (HTTP 402, which no client retries). Messages,
// reasoning details and items, tools, temperature and max tokens pass through untouched, and the response goes back
// byte for byte as it arrived.
//
// It runs in its own process (`node gateway.ts --ipc`, forked by the runner), which alone holds the real key: the key
// arrives over the IPC channel or is read from a key file here, never through argv or the environment, so frameworks
// running inside the runner cannot read it. Every text the bench writes passes through here to have the key replaced.
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { redact } from '../../src/providers.ts';
import { loadPrices, parsePrices, priceFor, priceOf, tierFactor, type ModelPrice, type PriceTable } from './prices.ts';

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const OPENAI = 'https://api.openai.com/v1';
export type Provider = 'openrouter' | 'openai';
export const PROVIDERS: readonly Provider[] = ['openrouter', 'openai'];
/** A wire API: OpenAI-compatible chat completions, or OpenAI's Responses. */
export type WireApi = 'chat' | 'responses';
/** Each provider's API, and the wire APIs the gateway serves for it under /api/v1. */
export const UPSTREAMS: Record<Provider, string> = { openrouter: OPENROUTER, openai: OPENAI };
export const WIRES: Record<Provider, readonly WireApi[]> = { openrouter: ['chat'], openai: ['chat', 'responses'] };
const PATHS: Record<WireApi, string> = { chat: '/chat/completions', responses: '/responses' };
export type RefusalKind = 'cost' | 'budget' | 'requests' | 'deadline' | 'closed';
export type ReasoningPolicy = 'default' | 'native' | 'low' | 'medium' | 'high';
export const REASONING: readonly ReasoningPolicy[] = ['default', 'native', 'low', 'medium', 'high'];
export type CostSource = 'usage' | 'generation' | 'unknown' | 'none';
/** Input (cached reads and cache writes included) and output (reasoning included) tokens. */
export interface Tokens { prompt: number; completion: number; reasoning: number; cached: number; cacheWrite: number }
/** One forwarded or refused request, without bodies. */
export interface RequestRecord {
  at: number; ms: number; status: number; stream: boolean; wire?: WireApi; id?: string; provider?: string; tier?: string; finish?: string; toolCalls: number;
  tokens: Tokens; cost: number; costSource: CostSource; byok?: boolean; refusal?: RefusalKind; violation?: string; error?: string;
}
export interface AttemptUsage {
  attempt: string; model: string; cap: number; requests: number; toolCalls: number; tokens: Tokens; cost: number;
  costSources: Record<Exclude<CostSource, 'none'>, number>; refusals: Partial<Record<RefusalKind, number>>; firstRefusal: RefusalKind | null;
  modelViolations: string[]; providers: Record<string, number>; byok: number; log: RequestRecord[];
}
export interface OpenInput { attempt: string; model: string; cap: number; deadline: number; maxRequests?: number }
export interface GatewayStatus { spent: number; reserved: number; budget: number }
/** The gateway as the runner drives it, in process (tests) or over IPC (runs). */
export interface GatewayControl {
  /** http://127.0.0.1:<port>/api/v1 */
  readonly url: string;
  readonly port: number;
  /** A token for one attempt, or null when the global budget cannot reserve its cap. */
  open(input: OpenInput): Promise<{ token: string } | null>;
  /** Revokes the token, waits for in-flight requests and cost recovery, releases the reservation and returns the usage. */
  close(token: string): Promise<AttemptUsage>;
  status(): Promise<GatewayStatus>;
  /** text with the real key replaced; JSON stays JSON. The bench applies the product's redaction itself (results.ts). */
  scrub(text: string): Promise<string>;
  stop(): Promise<void>;
}
export interface GatewayOptions {
  key: string; budget: number; provider?: Provider; upstream?: string;
  /** The OpenAI track's prices; prices/openai.json when absent. */
  prices?: PriceTable;
  reasoning?: ReasoningPolicy; providerOnly?: string; host?: string; port?: number;
  fetch?: typeof globalThis.fetch; recovery?: { tries: number; delayMs: number }; closeWaitMs?: number; maxBody?: number; now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const dollars = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const zero = (): Tokens => ({ prompt: 0, completion: 0, reasoning: 0, cached: 0, cacheWrite: 0 });
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });
const PASSED_HEADERS: Record<Provider, readonly string[]> = { openrouter: ['content-type', 'accept', 'http-referer', 'x-title', 'x-session-id'], openai: ['content-type', 'accept', 'x-openai-internal-codex-responses-lite'] };
const MESSAGES: Record<RefusalKind, string> = {
  cost: 'Bench limit: the attempt reached its cost cap.', budget: 'Bench limit: the run reached its global budget.',
  requests: 'Bench limit: the attempt reached its request limit.', deadline: 'Bench limit: the attempt reached its time limit.', closed: 'Bench limit: the attempt has ended.',
};

/** The usage fields OpenRouter reports, as the product's stepCost reads them: cost plus a BYOK request's upstream cost. */
export function readUsage(usage: unknown): { tokens: Tokens; cost: number; byok: boolean } | null {
  if (!isRecord(usage)) return null;
  const completion = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {}, prompt = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    tokens: { prompt: count(usage.prompt_tokens), completion: count(usage.completion_tokens), reasoning: count(completion.reasoning_tokens), cached: count(prompt.cached_tokens), cacheWrite: count(prompt.cache_write_tokens) },
    cost: dollars(usage.cost) + dollars(isRecord(usage.cost_details) ? usage.cost_details.upstream_inference_cost : undefined), byok: usage.is_byok === true,
  };
}

/** OpenAI's usage in either wire's shape: Responses' input and output tokens, or chat's prompt and completion tokens. */
export function readOpenAIUsage(usage: unknown): Tokens | null {
  if (!isRecord(usage)) return null;
  const responses = 'input_tokens' in usage || 'output_tokens' in usage, details = (value: unknown) => isRecord(value) ? value : {};
  const input = details(responses ? usage.input_tokens_details : usage.prompt_tokens_details), output = details(responses ? usage.output_tokens_details : usage.completion_tokens_details);
  return {
    prompt: count(responses ? usage.input_tokens : usage.prompt_tokens), completion: count(responses ? usage.output_tokens : usage.completion_tokens),
    reasoning: count(output.reasoning_tokens), cached: count(input.cached_tokens), cacheWrite: count(input.cache_write_tokens),
  };
}

/** What a response says about itself: usage, tool calls, finish reason, provider, service tier, id and error. */
interface Observed { usage: unknown; toolCalls: number; finish?: string; provider?: string; tier?: string; id?: string; error?: string }
const CALL = /^(?:function|custom_tool)_call$/;
function observe(payload: unknown, seen: Observed, ids: Set<string>) {
  if (!isRecord(payload)) return;
  // A Responses stream wraps the response in its lifecycle events, names each output item in its item events, and
  // reports a failure as an error event.
  if (isRecord(payload.response)) observe(payload.response, seen, ids);
  if (isRecord(payload.item)) called(payload.item, seen, ids);
  if (payload.type === 'error' && typeof payload.message === 'string') seen.error = payload.message.slice(0, 500);
  if (isRecord(payload.usage)) seen.usage = payload.usage;
  if (typeof payload.id === 'string' && !seen.id) seen.id = payload.id.slice(0, 200);
  if (typeof payload.provider === 'string') seen.provider = payload.provider.slice(0, 100);
  if (typeof payload.service_tier === 'string') seen.tier = payload.service_tier.slice(0, 40);
  if (isRecord(payload.error)) seen.error = String(payload.error.message ?? payload.error.code ?? 'error').slice(0, 500);
  if (payload.object === 'response' && typeof payload.status === 'string') {
    const reason = isRecord(payload.incomplete_details) ? payload.incomplete_details.reason : undefined;
    seen.finish = (typeof reason === 'string' ? `${payload.status}: ${reason}` : payload.status).slice(0, 100);
  }
  for (const item of Array.isArray(payload.output) ? payload.output.filter(isRecord) : []) called(item, seen, ids);
  for (const choice of Array.isArray(payload.choices) ? payload.choices.filter(isRecord) : []) {
    if (typeof choice.finish_reason === 'string') seen.finish = choice.finish_reason;
    const calls = isRecord(choice.delta) ? choice.delta.tool_calls : isRecord(choice.message) ? choice.message.tool_calls : undefined;
    for (const call of Array.isArray(calls) ? calls : []) {
      // A streamed call names its id in its first delta only; a whole message names every call.
      if (isRecord(choice.message)) seen.toolCalls += 1;
      else if (isRecord(call) && typeof call.id === 'string' && call.id && !ids.has(call.id)) { ids.add(call.id); seen.toolCalls += 1; }
    }
  }
}
/** A Responses output item: a function or custom tool call counts once, by its id, however many events name it. */
function called(item: Record<string, unknown>, seen: Observed, ids: Set<string>) {
  const key = typeof item.id === 'string' && item.id ? item.id : typeof item.call_id === 'string' ? item.call_id : '';
  if (typeof item.type === 'string' && CALL.test(item.type) && key && !ids.has(key)) { ids.add(key); seen.toolCalls += 1; }
}

/** An incremental SSE reader: data lines are parsed as JSON, comments and [DONE] ignored. */
export function sseObserver() {
  const seen: Observed = { usage: null, toolCalls: 0 }, ids = new Set<string>();
  let buffer = '';
  const line = (text: string) => {
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { observe(JSON.parse(data), seen, ids); } catch { /* a partial or foreign line */ }
  };
  const decoder = new TextDecoder();
  return {
    seen,
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      lines.forEach(line);
    },
    end() { buffer += decoder.decode(); if (buffer) line(buffer); buffer = ''; },
  };
}

/** A non-streamed completion's observations. */
export function jsonObserved(body: Buffer): Observed {
  const seen: Observed = { usage: null, toolCalls: 0 };
  try { observe(JSON.parse(body.toString('utf8')), seen, new Set()); } catch { /* not JSON */ }
  return seen;
}

/** The request body as forwarded: data collection denied, usage on, the reasoning policy applied; nothing else changes. */
export function rewrite(body: Record<string, unknown>, { reasoning = 'default', providerOnly }: { reasoning?: ReasoningPolicy; providerOnly?: string } = {}) {
  const next: Record<string, unknown> = { ...body };
  next.provider = { ...(isRecord(body.provider) ? body.provider : {}), data_collection: 'deny', ...(providerOnly ? { only: [providerOnly] } : {}) };
  next.usage = { ...(isRecord(body.usage) ? body.usage : {}), include: true };
  if (reasoning === 'default') { delete next.reasoning; delete next.reasoning_effort; delete next.include_reasoning; }
  else if (reasoning !== 'native') { delete next.reasoning_effort; delete next.include_reasoning; next.reasoning = { effort: reasoning }; }
  return next;
}

const ENCRYPTED = 'reasoning.encrypted_content';
/** Whether a Responses request chains with previous_response_id, which needs the previous response stored. */
export const chains = (body: Record<string, unknown>) => typeof body.previous_response_id === 'string' && body.previous_response_id !== '';
/**
 * An OpenAI request as forwarded. Both wires run at the Standard tier the price table prices (service_tier default).
 * A streamed chat completion asks for its usage (stream_options.include_usage), which OpenAI otherwise leaves out, and
 * a chat request keeps its reasoning_effort, since GPT-6 Sol and Luna call functions over chat completions only at
 * reasoning_effort none. A Responses request that does not chain with previous_response_id is not stored (store=false)
 * and, for a reasoning model, asks for its reasoning as encrypted content, so the reasoning items a framework replays
 * still work without stored state; a chaining request keeps store and include as sent. The reasoning policy removes or
 * sets reasoning.effort on a Responses request. Nothing else changes.
 */
export function rewriteOpenAI(body: Record<string, unknown>, wire: WireApi, { reasoning = 'default', reasoningModel = false }: { reasoning?: ReasoningPolicy; reasoningModel?: boolean } = {}) {
  const next: Record<string, unknown> = { ...body, service_tier: 'default' };
  if (wire === 'chat') {
    if (body.stream === true) next.stream_options = { ...(isRecord(body.stream_options) ? body.stream_options : {}), include_usage: true };
    return next;
  }
  if (!chains(body)) {
    next.store = false;
    const include = Array.isArray(body.include) ? body.include : [];
    if (reasoningModel && !include.includes(ENCRYPTED)) next.include = [...include, ENCRYPTED];
  }
  const given = isRecord(body.reasoning) ? body.reasoning : {};
  if (reasoning === 'default' && 'effort' in given) {
    const { effort: _effort, ...rest } = given;
    if (Object.keys(rest).length) next.reasoning = rest; else delete next.reasoning;
  } else if (reasoning !== 'default' && reasoning !== 'native') next.reasoning = { ...given, effort: reasoning };
  return next;
}

/**
 * The hosted tools an OpenAI request asks for, which the bench never forwards: OpenAI bills them per call beside the
 * tokens it reports, and they reach the network outside the box. Function and custom tools run in the box.
 */
export function hostedTools(body: Record<string, unknown>) {
  const types = (Array.isArray(body.tools) ? body.tools : []).map(tool => isRecord(tool) && typeof tool.type === 'string' ? tool.type : 'function').filter(type => type !== 'function' && type !== 'custom');
  if (body.web_search_options !== undefined && body.web_search_options !== null) types.push('web_search_options');
  return [...new Set(types)].join(', ').slice(0, 200);
}

/** How a key file names each provider's API, and the shape of another provider's key, which is never sent to it. */
const KEYS: Record<Provider, { name: string; baseUrl: RegExp; foreign: RegExp }> = {
  openrouter: { name: 'OpenRouter', baseUrl: /^https:\/\/openrouter\.ai\/api\/v1\/?$/, foreign: /^sk-(?:proj|svcacct|admin)-/ },
  openai: { name: 'OpenAI', baseUrl: /^https:\/\/api\.openai\.com\/v1\/?$/, foreign: /^sk-or-/ },
};
/** The models a key file's settings name, without keeping its key. */
export const keyFileModels = (path: string, provider: Provider = 'openrouter') => readKeyFile(path, provider).then(settings => settings.models);

/**
 * A key file as the controller writes browser-model.json, or a person writes {"apiKey": …} for OpenAI: a regular file,
 * not a link, at most 16 KB, with apiKey, for the provider's API.
 */
export async function readKeyFile(path: string, provider: Provider = 'openrouter'): Promise<{ apiKey: string; models: string[] }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 16384) throw new Error('The key file must be a regular file of at most 16 KB.');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('The key file is not JSON.'); }
  if (!isRecord(parsed) || typeof parsed.apiKey !== 'string' || !parsed.apiKey.trim() || parsed.apiKey.length > 1000) throw new Error('The key file has no apiKey.');
  // A key saved for another provider's endpoint, or shaped as another provider's key, is never sent to this one.
  const { name, baseUrl, foreign } = KEYS[provider], apiKey = parsed.apiKey.trim();
  if (parsed.baseUrl !== undefined && !(typeof parsed.baseUrl === 'string' && baseUrl.test(parsed.baseUrl)) || foreign.test(apiKey)) throw new Error(`The key file's key is not for ${name}.`);
  const models = [parsed.model, parsed.escalationModel].filter((value): value is string => typeof value === 'string' && /^[\w.:/-]{1,200}$/.test(value));
  return { apiKey, models: [...new Set(models)] };
}

interface Attempt { input: Required<OpenInput>; spent: number; open: boolean; inflight: Set<Promise<void>>; usage: AttemptUsage }

/** The gateway in this process. */
export async function createGateway(options: GatewayOptions): Promise<GatewayControl> {
  const { key, budget, provider = 'openrouter', reasoning = 'default', providerOnly, host = '127.0.0.1', port: wanted = 0, maxBody = 64 * 1024 * 1024, closeWaitMs = 60_000 } = options;
  if (!PROVIDERS.includes(provider)) throw new Error(`The provider is one of ${PROVIDERS.join(', ')}.`);
  const upstream = (options.upstream ?? UPSTREAMS[provider]).replace(/\/+$/, ''), fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  const recovery = options.recovery ?? { tries: 3, delayMs: 3_333 };
  if (!key) throw new Error('The gateway needs an upstream key.');
  if (!(budget >= 0)) throw new Error('The gateway needs a budget.');
  if (!REASONING.includes(reasoning)) throw new Error(`Reasoning is one of ${REASONING.join(', ')}.`);
  if (process.env.NODE_TEST_CONTEXT && /(?:^|\.)(?:openrouter\.ai|openai\.com)$/i.test(new URL(upstream).hostname)) throw new Error('Tests never reach OpenRouter or OpenAI.');
  // OpenAI reports no dollars: its track prices each request with the table, validated as unknown however it arrived.
  const prices = provider === 'openai' ? options.prices ? parsePrices(options.prices) : await loadPrices() : null;
  const served = WIRES[provider].map(wire => `POST /api/v1${PATHS[wire]}`);
  const attempts = new Map<string, Attempt>();
  let spent = 0;
  const reserved = () => [...attempts.values()].filter(attempt => attempt.open).reduce((total, attempt) => total + Math.max(0, attempt.input.cap - attempt.spent), 0);
  const scrub = (text: string) => String(text).split(key).join('[REDACTED]');

  const answer = (response: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}) => {
    if (response.headersSent) return void response.end();
    response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ error: { code: status, type, message } }));
  };
  const refusal = (attempt: Attempt): RefusalKind | null => {
    if (!attempt.open) return 'closed';
    if (attempt.spent >= attempt.input.cap) return 'cost';
    if (spent >= budget) return 'budget';
    if (attempt.usage.requests >= attempt.input.maxRequests) return 'requests';
    if (now() > attempt.input.deadline) return 'deadline';
    return null;
  };
  const charge = (attempt: Attempt, record: RequestRecord) => {
    attempt.spent += record.cost; spent += record.cost;
    const usage = attempt.usage;
    usage.cost += record.cost; usage.toolCalls += record.toolCalls;
    for (const name of ['prompt', 'completion', 'reasoning', 'cached', 'cacheWrite'] as const) usage.tokens[name] += record.tokens[name];
    if (record.costSource !== 'none') usage.costSources[record.costSource] += 1;
    if (record.provider) usage.providers[record.provider] = (usage.providers[record.provider] ?? 0) + 1;
    if (record.byok) usage.byok += 1;
  };
  // A generation's cost when its usage never arrived, such as after a client abort: OpenRouter's /generation.
  async function recover(id: string): Promise<number | null> {
    for (let attempt = 0; attempt < recovery.tries; attempt += 1) {
      if (attempt) await pause(recovery.delayMs);
      try {
        const response = await fetcher(`${upstream}/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) continue;
        const body: unknown = await response.json();
        const data = isRecord(body) && isRecord(body.data) ? body.data : null;
        if (data && typeof data.total_cost === 'number' && Number.isFinite(data.total_cost)) return dollars(data.total_cost);
      } catch { /* tried again */ }
    }
    return null;
  }
  async function readBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) { size += chunk.length; if (size > maxBody) throw Object.assign(new Error('The request body is too large.'), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  async function forward(attempt: Attempt, body: Record<string, unknown>, wire: WireApi, price: ModelPrice | null, request: IncomingMessage, response: ServerResponse) {
    const started = now(), record: RequestRecord = { at: started, ms: 0, status: 0, stream: false, wire, toolCalls: 0, tokens: zero(), cost: 0, costSource: 'none' };
    attempt.usage.requests += 1;
    const controller = new AbortController();
    const abort = () => { if (!response.writableFinished) controller.abort(new Error('The client went away.')); };
    response.on('close', abort);
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    for (const name of PASSED_HEADERS[provider]) { const value = request.headers[name]; if (typeof value === 'string') headers[name] = value; }
    headers['content-type'] = 'application/json';
    // Only OpenAI's requests are priced, and its rules differ from OpenRouter's.
    const forwarded = price ? rewriteOpenAI(body, wire, { reasoning, reasoningModel: price.reasoning }) : rewrite(body, { reasoning, providerOnly });
    let seen: Observed = { usage: null, toolCalls: 0 };
    try {
      const upstreamResponse = await fetcher(`${upstream}${PATHS[wire]}`, { method: 'POST', headers, body: JSON.stringify(forwarded), signal: controller.signal });
      record.status = upstreamResponse.status;
      const type = upstreamResponse.headers.get('content-type') ?? 'application/json';
      record.stream = /text\/event-stream/i.test(type);
      response.writeHead(upstreamResponse.status, { 'content-type': type, ...(record.stream ? { 'cache-control': 'no-cache' } : {}) });
      if (record.stream && upstreamResponse.body) {
        const reader = sseObserver();
        seen = reader.seen;
        for await (const chunk of upstreamResponse.body as AsyncIterable<Uint8Array>) { reader.push(chunk); if (!response.destroyed) response.write(chunk); }
        reader.end();
        response.end();
      } else {
        const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
        seen = jsonObserved(bytes);
        response.end(bytes);
      }
    } catch (error) {
      record.error = scrub(error instanceof Error ? error.message : String(error)).slice(0, 300);
      if (!response.headersSent) answer(response, 502, 'bench_upstream', 'Bench gateway: the upstream request failed.');
      else response.destroy();
    } finally { response.off('close', abort); }
    record.ms = now() - started;
    Object.assign(record, { toolCalls: seen.toolCalls, ...(seen.finish ? { finish: seen.finish } : {}), ...(seen.provider ? { provider: seen.provider } : {}), ...(seen.tier ? { tier: seen.tier } : {}), ...(seen.id ? { id: seen.id } : {}) });
    if (seen.error && !record.error) record.error = scrub(seen.error).slice(0, 300);
    // A request that got no answer, or a 2xx that lost its usage, may have cost something; an upstream error status (a
    // rejected request) costs nothing.
    const answered = record.status === 0 || record.status >= 200 && record.status < 300;
    if (price) {
      // OpenAI's dollars are the reported usage at the table's prices and the serving tier's factor. OpenAI keeps no
      // generation record, so dollars without usage stay unknown.
      const tokens = readOpenAIUsage(seen.usage);
      if (tokens) Object.assign(record, { tokens, cost: priceOf(tokens, price, tierFactor(prices!, seen.tier)), costSource: 'usage' });
      else if (answered) record.costSource = 'unknown';
    } else {
      // Without usage, OpenRouter's generation id recovers the cost.
      const usage = readUsage(seen.usage);
      if (usage) Object.assign(record, { tokens: usage.tokens, cost: usage.cost, costSource: 'usage', byok: usage.byok });
      else if (seen.id) {
        const recovered = await recover(seen.id);
        Object.assign(record, recovered === null ? { costSource: 'unknown' } : { cost: recovered, costSource: 'generation' });
      } else if (answered) record.costSource = 'unknown';
    }
    charge(attempt, record);
    attempt.usage.log.push(record);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = (request.url ?? '').split('?')[0];
    const wire = request.method === 'POST' ? WIRES[provider].find(name => path === `/api/v1${PATHS[name]}`) : undefined;
    if (!wire) return answer(response, 404, 'bench_route', `Bench gateway: only ${served.join(' and ')} ${served.length > 1 ? 'are' : 'is'} served.`);
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const attempt = bearer ? attempts.get(hash(bearer)) : undefined;
    if (!attempt) return answer(response, 401, 'bench_auth', 'Bench gateway: unknown token.');
    let parsed: unknown;
    try { parsed = JSON.parse((await readBody(request)).toString('utf8')); }
    catch (error) { return answer(response, (error as { status?: number }).status ?? 400, 'bench_request', 'Bench gateway: the body is not a JSON object.'); }
    if (!isRecord(parsed)) return answer(response, 400, 'bench_request', 'Bench gateway: the body is not a JSON object.');
    const body = parsed;
    const log = (extra: Partial<RequestRecord>) => attempt.usage.log.push({ at: now(), ms: 0, status: 0, stream: body.stream === true, wire, toolCalls: 0, tokens: zero(), cost: 0, costSource: 'none', ...extra });
    const kind = refusal(attempt);
    if (kind) {
      attempt.usage.refusals[kind] = (attempt.usage.refusals[kind] ?? 0) + 1;
      attempt.usage.firstRefusal ??= kind === 'closed' ? null : kind;
      log({ status: 402, refusal: kind });
      return answer(response, 402, 'bench_limit', MESSAGES[kind], { 'x-bench-refusal': kind });
    }
    if (body.model !== attempt.input.model) {
      const named = typeof body.model === 'string' ? body.model.slice(0, 200) : String(typeof body.model);
      attempt.usage.modelViolations.push(named);
      log({ status: 400, violation: named });
      return answer(response, 400, 'bench_model', `Bench gateway: this attempt may only use ${attempt.input.model}.`);
    }
    // OpenAI's track forwards neither hosted tools nor a model without a price.
    const price = prices ? priceFor(prices, attempt.input.model) : null;
    if (prices) {
      const hosted = hostedTools(body);
      if (hosted) { log({ status: 400, error: `hosted tools: ${hosted}` }); return answer(response, 400, 'bench_tools', `Bench gateway: only function and custom tools are forwarded, not ${hosted}.`); }
      if (!price) { log({ status: 400, error: 'no price' }); return answer(response, 400, 'bench_price', `Bench gateway: ${attempt.input.model} has no price, so it is not forwarded.`); }
    }
    await forward(attempt, body, wire, price, request, response);
  }

  const server = createServer((request, response) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const attempt = bearer ? attempts.get(hash(bearer)) : undefined;
    const work = handle(request, response).catch(() => answer(response, 500, 'bench_gateway', 'Bench gateway: internal error.'));
    if (attempt) { attempt.inflight.add(work); void work.finally(() => attempt.inflight.delete(work)); }
  });
  server.listen(wanted, host);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/api/v1`, port,
    async open(input) {
      const cap = Number(input.cap), deadline = Number(input.deadline), maxRequests = input.maxRequests ?? 120;
      if (!input.attempt || !input.model || !(cap > 0) || !Number.isFinite(deadline) || !(maxRequests > 0)) throw new Error('Invalid attempt.');
      if (prices && !priceFor(prices, input.model)) throw new Error(`No price for ${input.model} in the price table.`);
      if (spent + reserved() + cap > budget + 1e-9) return null;
      const token = randomBytes(32).toString('base64url');
      attempts.set(hash(token), {
        input: { attempt: input.attempt, model: input.model, cap, deadline, maxRequests }, spent: 0, open: true, inflight: new Set(),
        usage: { attempt: input.attempt, model: input.model, cap, requests: 0, toolCalls: 0, tokens: zero(), cost: 0, costSources: { usage: 0, generation: 0, unknown: 0 }, refusals: {}, firstRefusal: null, modelViolations: [], providers: {}, byok: 0, log: [] },
      });
      return { token };
    },
    async close(token) {
      const attempt = attempts.get(hash(token));
      if (!attempt) throw new Error('Unknown attempt.');
      attempt.open = false;
      await Promise.race([Promise.allSettled([...attempt.inflight]), pause(closeWaitMs)]);
      return structuredClone(attempt.usage);
    },
    async status() { return { spent, reserved: reserved(), budget }; },
    async scrub(text) { return scrub(text); },
    async stop() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}

// ── IPC ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Init = { type: 'init'; key?: string; keyFile?: string; options: Omit<GatewayOptions, 'key' | 'fetch' | 'now'> };
type Call = { type: 'call'; id: number; op: 'open' | 'close' | 'status' | 'scrub' | 'stop'; args: unknown[] };

/**
 * The gateway in a child process, given the key over IPC (or reading keyFile there). The child's environment never
 * holds OPENROUTER_API_KEY or OPENAI_API_KEY and its argv names no key.
 */
export async function forkGateway({ key, keyFile, ...options }: { key?: string; keyFile?: string } & Init['options']): Promise<GatewayControl & { child: ChildProcess }> {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENAI_API_KEY;
  const child = fork(fileURLToPath(import.meta.url), ['--ipc'], { env, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 1;
  const exited = new Promise<never>((_resolve, reject) => child.once('exit', code => {
    const error = new Error(`The gateway exited (${code ?? 'signal'}).`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear(); reject(error);
  }));
  exited.catch(() => {});
  const ready = new Promise<{ url: string; port: number }>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === 'ready' && typeof message.url === 'string' && typeof message.port === 'number') return resolve({ url: message.url, port: message.port });
      if (message.type === 'failed') return reject(new Error(String(message.error)));
      if (message.type !== 'result' || typeof message.id !== 'number') return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) waiter?.reject(new Error(String(message.error))); else waiter?.resolve(message.result);
    });
  });
  child.send({ type: 'init', key, keyFile, options } satisfies Init);
  const { url, port } = await Promise.race([ready, exited]);
  const call = <T>(op: Call['op'], ...args: unknown[]) => new Promise<T>((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve: value => resolve(value as T), reject });
    child.send({ type: 'call', id, op, args } satisfies Call);
  });
  return {
    child, url, port,
    open: input => call('open', input), close: token => call('close', token), status: () => call('status'), scrub: text => call('scrub', text),
    async stop() { if (child.exitCode !== null) return; await call('stop').catch(() => {}); child.disconnect(); await Promise.race([once(child, 'exit'), pause(5_000)]); if (child.exitCode === null) child.kill('SIGKILL'); },
  };
}

async function serveIpc() {
  let gateway: GatewayControl | null = null;
  const reply = (message: Record<string, unknown>) => { if (process.connected) process.send?.(message); };
  process.on('disconnect', () => { void gateway?.stop().finally(() => process.exit(0)); if (!gateway) process.exit(0); });
  process.on('message', async (message: unknown) => {
    if (!isRecord(message)) return;
    if (message.type === 'init' && !gateway) {
      try {
        const init = message as unknown as Init, named: unknown = isRecord(init.options) ? init.options.provider : undefined;
        const provider = PROVIDERS.find(name => name === named) ?? 'openrouter';
        const key = typeof init.key === 'string' && init.key ? init.key : typeof init.keyFile === 'string' ? (await readKeyFile(init.keyFile, provider)).apiKey : '';
        gateway = await createGateway({ ...(isRecord(init.options) ? init.options : {}), key } as GatewayOptions);
        reply({ type: 'ready', url: gateway.url, port: gateway.port });
      } catch (error) { reply({ type: 'failed', error: redact((error as Error).message) }); process.exit(1); }
      return;
    }
    if (message.type !== 'call' || !gateway || typeof message.id !== 'number') return;
    const { id, op, args } = message as unknown as Call, list = Array.isArray(args) ? args : [];
    try {
      const result = op === 'open' ? await gateway.open(list[0] as OpenInput) : op === 'close' ? await gateway.close(String(list[0])) : op === 'status' ? await gateway.status()
        : op === 'scrub' ? await gateway.scrub(String(list[0])) : op === 'stop' ? await gateway.stop() : undefined;
      reply({ type: 'result', id, result: result ?? null });
    } catch (error) { reply({ type: 'result', id, error: redact((error as Error).message) }); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--ipc')) void serveIpc();
