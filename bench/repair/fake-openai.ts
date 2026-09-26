// A fake OpenAI API for tests and the OpenAI track's dry run: POST /v1/chat/completions and POST /v1/responses (JSON or
// SSE, as the request asks) with scripted replies, shaped as OpenAI's. Usage carries no dollars (the gateway prices
// it); a chat stream carries usage only when stream_options.include_usage asks; a Responses stream is typed events that
// end at response.completed with usage and no [DONE]. As OpenAI does for a reasoning model, every Responses reply
// starts with a reasoning item, whose encrypted content comes only when include asks for it; a request with
// store=false may not replay reasoning without that content or refer to items by reference; and previous_response_id
// must name a stored response. It demands the fake real key, so a request that reaches it proves the gateway swapped
// the attempt's token for the key.
//
// The OpenRouter fake's scripts drive it, the dry-run solver included: a Responses request is shown to the script as
// chat messages and chat tools (chatView).
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeReply, FakeScript, Received } from './fake-upstream.ts';

export const FAKE_OPENAI_KEY = 'sk-proj-fake00000000000000000000000000000000000000000000000000000000';
const CREATED = 1767225600;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hex = (bytes = 12) => randomBytes(bytes).toString('hex');

/** A Responses request as the chat-shaped script sees it: instructions and input items as messages, function tools as chat tools. */
export function chatView(body: Record<string, unknown>): Record<string, unknown> {
  const messages: unknown[] = typeof body.instructions === 'string' ? [{ role: 'system', content: body.instructions }] : [];
  const input: Record<string, unknown>[] = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input.filter(isRecord) : [];
  for (const item of input) {
    if (item.type === 'function_call') messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] });
    else if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
    else if ((item.type === undefined || item.type === 'message') && typeof item.role === 'string') messages.push({ role: item.role, content: item.content });
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap(tool => isRecord(tool) && tool.type === 'function' && typeof tool.name === 'string'
    ? [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }] : []);
  return { ...body, messages, tools };
}

/** Why OpenAI refuses a Responses request before generating: an unstored previous response, or state store=false cannot hold. */
function stateless(body: Record<string, unknown>, stored: ReadonlySet<string>): { status: number; message: string; param: string; code: string | null } | null {
  const previous = body.previous_response_id;
  if (typeof previous === 'string' && previous && !stored.has(previous)) return { status: 400, message: `Previous response with id '${previous}' not found.`, param: 'previous_response_id', code: 'previous_response_not_found' };
  if (body.store !== false) return null;
  const item = (Array.isArray(body.input) ? body.input.filter(isRecord) : []).find(entry => entry.type === 'item_reference' || entry.type === 'reasoning' && typeof entry.encrypted_content !== 'string');
  return item ? { status: 404, param: 'input', code: null, message: `Item with id '${String(item.id)}' not found. Items are not persisted when \`store\` is set to false. Try again with \`store\` set to true, or remove this item from your input.` } : null;
}

/** The fake OpenAI on 127.0.0.1; url is its /v1 base. */
export async function createFakeOpenAI({ script, key = FAKE_OPENAI_KEY }: { script: FakeScript; key?: string }) {
  const received: Received[] = [], stored = new Set<string>();
  let index = 0;
  const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const refuse = (response: ServerResponse, status: number, message: string, param: string | null = null, code: string | null = null) => json(response, status, { error: { message, type: 'invalid_request_error', param, code } });
  const hang = (request: IncomingMessage, response: ServerResponse) => new Promise<void>(resolve => { request.on('close', () => resolve()); response.on('close', () => resolve()); });
  const stream = (response: ServerResponse) => response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const calls = (reply: FakeReply) => (reply.calls ?? []).map(call => ({ name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) }));
  // Every reply reads 1000 input tokens (200 cached, 100 written to the cache) and writes 50, 10 of them reasoning.
  const tokens = (reply: FakeReply) => ({ input: 1000, cached: 200, cacheWrite: 100, output: 50, reasoning: reply.reasoningTokens ?? 10 });

  async function chat(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>, reply: FakeReply) {
    const t = tokens(reply), made = calls(reply).map((call, position) => ({ id: `call_${hex(8)}_${position}`, type: 'function' as const, function: call }));
    const usage = { prompt_tokens: t.input, completion_tokens: t.output, total_tokens: t.input + t.output, prompt_tokens_details: { cached_tokens: t.cached, cache_write_tokens: t.cacheWrite, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: t.reasoning, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
    const base = { id: `chatcmpl-${hex()}`, created: CREATED, model: String(body.model), service_tier: 'default', system_fingerprint: null }, finish = made.length ? 'tool_calls' : 'stop';
    if (body.stream !== true) {
      if (reply.hang) return hang(request, response);
      return json(response, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? (made.length ? null : ''), refusal: null, annotations: [], ...(made.length ? { tool_calls: made } : {}) },
        logprobs: null, finish_reason: finish }], ...(reply.noUsage ? {} : { usage }) });
    }
    const counted = isRecord(body.stream_options) && body.stream_options.include_usage === true;
    stream(response);
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...(counted ? { usage: null } : {}), ...extra })}\n\n`);
    chunk([{ index: 0, delta: { role: 'assistant', content: '', refusal: null }, logprobs: null, finish_reason: null }]);
    if (reply.hang) return hang(request, response);
    for (const part of reply.text?.match(/[\s\S]{1,12}/g) ?? []) chunk([{ index: 0, delta: { content: part }, logprobs: null, finish_reason: null }]);
    made.forEach((call, position) => {
      const parts = call.function.arguments.match(/[\s\S]{1,16}/g) ?? [''];
      chunk([{ index: 0, delta: { tool_calls: [{ index: position, id: call.id, type: 'function', function: { name: call.function.name, arguments: parts[0] } }] }, logprobs: null, finish_reason: null }]);
      for (const part of parts.slice(1)) chunk([{ index: 0, delta: { tool_calls: [{ index: position, function: { arguments: part } }] }, logprobs: null, finish_reason: null }]);
    });
    chunk([{ index: 0, delta: {}, logprobs: null, finish_reason: finish }]);
    if (counted && !reply.noUsage) chunk([], { usage });
    response.end('data: [DONE]\n\n');
  }

  async function responses(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>, reply: FakeReply) {
    const t = tokens(reply), id = `resp_${hex()}`, encrypted = Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content');
    const output: Record<string, unknown>[] = [];
    if (t.reasoning > 0) output.push({ id: `rs_${hex()}`, type: 'reasoning', summary: [], ...(encrypted ? { encrypted_content: `gAAAAB${hex(24)}` } : {}) });
    for (const call of calls(reply)) output.push({ id: `fc_${hex()}`, type: 'function_call', status: 'completed', arguments: call.arguments, call_id: `call_${hex(8)}`, name: call.name });
    if (reply.text || !reply.calls?.length) output.push({ id: `msg_${hex()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], logprobs: [], text: reply.text ?? '' }] });
    const usage = { input_tokens: t.input, input_tokens_details: { cached_tokens: t.cached, cache_write_tokens: t.cacheWrite }, output_tokens: t.output, output_tokens_details: { reasoning_tokens: t.reasoning }, total_tokens: t.input + t.output };
    if (body.store !== false) stored.add(id);
    const shaped = (status: string, extra: Record<string, unknown> = {}) => ({
      id, object: 'response', created_at: CREATED, status, background: false, error: null, incomplete_details: null, instructions: body.instructions ?? null, max_output_tokens: body.max_output_tokens ?? null,
      model: String(body.model), output: [], parallel_tool_calls: body.parallel_tool_calls ?? true, previous_response_id: body.previous_response_id ?? null,
      reasoning: { effort: isRecord(body.reasoning) && typeof body.reasoning.effort === 'string' ? body.reasoning.effort : 'medium', summary: null }, service_tier: 'default', store: body.store !== false,
      text: { format: { type: 'text' } }, tool_choice: body.tool_choice ?? 'auto', tools: body.tools ?? [], truncation: 'disabled', usage: null, metadata: {}, ...extra,
    });
    const done = shaped('completed', { output, usage: reply.noUsage ? null : usage });
    if (body.stream !== true) {
      if (reply.hang) return hang(request, response);
      return json(response, 200, done);
    }
    stream(response);
    let sequence = 0;
    const event = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event('response.created', { response: shaped('in_progress') });
    if (reply.hang) return hang(request, response);
    event('response.in_progress', { response: shaped('in_progress') });
    output.forEach((item, position) => {
      const at = { output_index: position }, text = item.type === 'message' ? reply.text ?? '' : '';
      if (item.type === 'reasoning') {
        event('response.output_item.added', { ...at, item: { id: item.id, type: 'reasoning', summary: [] } });
      } else if (item.type === 'function_call') {
        event('response.output_item.added', { ...at, item: { ...item, status: 'in_progress', arguments: '' } });
        for (const part of String(item.arguments).match(/[\s\S]{1,16}/g) ?? []) event('response.function_call_arguments.delta', { ...at, item_id: item.id, delta: part });
        event('response.function_call_arguments.done', { ...at, item_id: item.id, name: item.name, arguments: item.arguments });
      } else {
        const part = (value: string) => ({ type: 'output_text', annotations: [], logprobs: [], text: value });
        event('response.output_item.added', { ...at, item: { ...item, status: 'in_progress', content: [] } });
        event('response.content_part.added', { ...at, item_id: item.id, content_index: 0, part: part('') });
        for (const delta of text.match(/[\s\S]{1,12}/g) ?? []) event('response.output_text.delta', { ...at, item_id: item.id, content_index: 0, delta, logprobs: [] });
        event('response.output_text.done', { ...at, item_id: item.id, content_index: 0, text, logprobs: [] });
        event('response.content_part.done', { ...at, item_id: item.id, content_index: 0, part: part(text) });
      }
      event('response.output_item.done', { ...at, item });
    });
    event('response.completed', { response: done });
    response.end();
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake'), authorization = request.headers.authorization ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    let body: unknown = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    received.push({ path: url.pathname, authorization, headers: request.headers, body });
    try {
      if (authorization !== `Bearer ${key}`) return refuse(response, 401, 'Incorrect API key provided.', null, 'invalid_api_key');
      const wire = url.pathname === '/v1/chat/completions' ? 'chat' : url.pathname === '/v1/responses' ? 'responses' : null;
      if (request.method !== 'POST' || !wire || !isRecord(body)) return refuse(response, 404, `Unknown request URL: ${request.method} ${url.pathname}.`, null, 'unknown_url');
      const refused = wire === 'responses' ? stateless(body, stored) : null;
      if (refused) return refuse(response, refused.status, refused.message, refused.param, refused.code);
      const reply = await script(wire === 'responses' ? chatView(body) : body, index++);
      if (reply.status && reply.status >= 400) return refuse(response, reply.status, reply.error ?? 'Upstream error');
      return wire === 'responses' ? await responses(request, response, body, reply) : await chat(request, response, body, reply);
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: { message: String((error as Error).message), type: 'server_error', param: null, code: null } }); else response.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`, port, received, key,
    async stop() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}
