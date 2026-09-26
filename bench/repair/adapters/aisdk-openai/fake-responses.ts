// A scripted stand-in for the gateway's Responses route (POST /api/v1/responses, JSON only), for this adapter's tests
// while the bench's fake upstream speaks chat completions only. It demands the attempt's token, records every request as
// fake-upstream does and every answer it sent, and shapes each FakeReply as a Responses object: a reasoning item with
// encrypted content, the reply's function calls, its text as an assistant message, and OpenAI's usage fields, which
// carry no cost; a reply's status and error become an OpenAI error, and its cost, hang and OpenRouter-only fields are
// ignored. The script sees each request through chatView, as the chat body fake-upstream's framework-agnostic dry-run
// solver reads, so that solver drives this arm unchanged.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeReply, FakeScript, Received } from '../../fake-upstream.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('\n') : '';

/**
 * A Responses request as a chat completions body: developer messages as system, one turn's function calls as one
 * assistant message, their outputs as tool messages, and the function tools; reasoning items are left out.
 */
export function chatView(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const item of Array.isArray(body.input) ? body.input.filter(isRecord) : []) {
    const last = messages.at(-1);
    if (item.type === 'function_call') {
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      if (last?.role === 'assistant') last.tool_calls = [...(Array.isArray(last.tool_calls) ? last.tool_calls : []), call];
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: text(item.output) });
    else if (typeof item.role === 'string') messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: text(item.content) });
  }
  const tools = (Array.isArray(body.tools) ? body.tools.filter(isRecord) : []).filter(tool => tool.type === 'function')
    .map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  return { model: body.model, messages, tools };
}

/** A FakeReply as the Responses API returns it; the usage has OpenAI's fields and no cost. */
export function responseOf(reply: FakeReply, model: string) {
  const id = randomBytes(8).toString('hex');
  return {
    id: `resp_${id}`, object: 'response', created_at: 1767225600, status: 'completed', model, error: null, incomplete_details: null,
    output: [
      { type: 'reasoning', id: `rs_${id}`, encrypted_content: `encrypted-${id}`, summary: [] },
      ...(reply.calls ?? []).map((call, position) => ({ type: 'function_call', id: `fc_${id}_${position}`, call_id: `call_${id}_${position}`, name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments), status: 'completed' })),
      ...(reply.text ? [{ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] }] : []),
    ],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: reply.reasoningTokens ?? 10 }, total_tokens: 1050 },
  };
}

/** The stand-in on 127.0.0.1; url is its /api/v1 base, as the gateway's is. */
export async function createFakeResponses({ script, token }: { script: FakeScript; token: string }) {
  const received: Received[] = [], sent: ReturnType<typeof responseOf>[] = [];
  let index = 0;
  const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const failure = (response: ServerResponse, status: number, message: string) => json(response, status, { error: { message, type: 'bench_fake', param: null, code: String(status) } });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    let body: unknown = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    const path = new URL(request.url ?? '/', 'http://fake').pathname, authorization = request.headers.authorization ?? '';
    received.push({ path, authorization, headers: request.headers, body });
    try {
      if (request.method !== 'POST' || path !== '/api/v1/responses' || !isRecord(body)) return failure(response, 404, 'Only POST /api/v1/responses with a JSON body is served.');
      if (authorization !== `Bearer ${token}`) return failure(response, 401, 'Unknown token.');
      if (body.stream === true) return failure(response, 400, 'This stand-in answers JSON only.');
      const reply = await script(chatView(body), index++);
      if (reply.status && reply.status >= 400) return failure(response, reply.status, reply.error ?? 'Upstream error');
      const answer = responseOf(reply, typeof body.model === 'string' ? body.model : 'unknown');
      sent.push(answer);
      json(response, 200, answer);
    } catch (error) { if (!response.headersSent) failure(response, 500, String((error as Error).message)); else response.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v1`, port, received, sent,
    async stop() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}
