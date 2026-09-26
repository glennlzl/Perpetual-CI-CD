// A fake OpenAI Responses endpoint for the agents-openai tests: POST <url>/responses (JSON; the adapter never streams)
// with scripted replies, on 127.0.0.1, demanding the attempt's token. A reply is reasoning, function calls, text, an
// HTTP error in OpenAI's shape, or a hang until the client goes away. solverReplies puts the dry-run solver, which reads
// chat completions, behind it, so a smoke test solves a corpus case. It stands in for the gateway's /responses route.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeCall, FakeScript } from '../../fake-upstream.ts';

export interface ResponsesReply {
  calls?: FakeCall[]; text?: string; reasoning?: boolean; hang?: boolean;
  status?: number; error?: { message: string; type?: string; code?: string | number };
}
export type ResponsesScript = (body: Record<string, unknown>, index: number) => ResponsesReply | Promise<ResponsesReply>;
export interface ResponsesReceived { path: string; authorization: string; headers: Record<string, string | string[] | undefined>; body: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/** A reply as a Responses API response: reasoning with encrypted content, function calls and text as output items, and usage. */
export function responseBody(reply: ResponsesReply, model: unknown) {
  const output = [
    ...(reply.reasoning ? [{ type: 'reasoning', id: id('rs'), summary: [], encrypted_content: id('enc') }] : []),
    ...(reply.calls ?? []).map(call => ({ type: 'function_call', id: id('fc'), call_id: id('call'), name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments), status: 'completed' })),
    ...(reply.text !== undefined ? [{ type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] }] : []),
  ];
  return {
    id: id('resp'), object: 'response', created_at: 1767225600, status: 'completed', model: typeof model === 'string' ? model : 'unknown', output, error: null, incomplete_details: null,
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: reply.reasoning ? 10 : 0 }, total_tokens: 1050 },
  };
}

/** The fake on 127.0.0.1; url is its base, which the adapter takes as the gateway's. */
export async function createFakeResponses({ script, token }: { script: ResponsesScript; token: string }) {
  const received: ResponsesReceived[] = [];
  let index = 0;
  const answer = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    let body: unknown = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    const path = new URL(request.url ?? '/', 'http://fake').pathname, authorization = request.headers.authorization ?? '';
    received.push({ path, authorization, headers: request.headers, body });
    try {
      if (authorization !== `Bearer ${token}`) return answer(response, 401, { error: { message: 'Unknown token.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (request.method !== 'POST' || path !== '/v1/responses' || !isRecord(body)) return answer(response, 404, { error: { message: 'Not found.', type: 'invalid_request_error', code: null } });
      const reply = await script(body, index++);
      if (reply.hang) return void await new Promise<void>(resolve => { request.on('close', () => resolve()); response.on('close', () => resolve()); });
      if (reply.status && reply.status >= 400) return answer(response, reply.status, { error: { message: 'Upstream error.', type: 'invalid_request_error', code: null, ...reply.error } });
      answer(response, 200, responseBody(reply, body.model));
    } catch (error) { if (!response.headersSent) answer(response, 500, { error: { message: String((error as Error).message), type: 'server_error', code: null } }); else response.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`, port, received,
    async stop() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}

const text = (content: unknown) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('\n') : '';
/** A Responses request as the chat completions body the dry-run solver reads: its conversation as messages, and its function tools. */
export function chatView(body: Record<string, unknown>) {
  const messages = (Array.isArray(body.input) ? body.input : []).filter(isRecord).flatMap((item): Record<string, unknown>[] => {
    if (item.type === 'function_call') return [{ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] }];
    if (item.type === 'function_call_output') return [{ role: 'tool', tool_call_id: item.call_id, content: text(item.output) }];
    return typeof item.role === 'string' ? [{ role: item.role, content: text(item.content) }] : [];
  });
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isRecord).filter(tool => tool.type === 'function')
    .map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  return { model: body.model, messages: [...(typeof body.instructions === 'string' ? [{ role: 'system', content: body.instructions }] : []), ...messages], tools };
}

/** The dry-run solver answering Responses requests: reproduce, patch and verify through the run tool, then done. */
export const solverReplies = (script: FakeScript): ResponsesScript => async (body, index) => {
  const reply = await script(chatView(body), index);
  return { ...(reply.calls ? { calls: reply.calls } : {}), ...(reply.text !== undefined ? { text: reply.text } : {}) };
};
