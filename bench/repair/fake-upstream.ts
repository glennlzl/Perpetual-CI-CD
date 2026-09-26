// A fake OpenRouter for tests and the dry run: POST /api/v1/chat/completions (JSON or SSE, as the request asks) with
// scripted replies, GET /api/v1/generation for cost recovery and GET /api/v1/models. It demands the fake real key, so
// a request that reaches it proves the gateway swapped the attempt's token for the key. Its SSE stream is shaped as
// OpenRouter's: a role chunk, content and split tool-call argument deltas, a `: OPENROUTER PROCESSING` comment, the
// finish chunk, then a usage chunk with no choices and usage.cost, then [DONE].
//
// The dry-run solver answers any framework: it finds the case by `Repository <owner/name>` in the prompt, runs the
// failing CI commands through the framework's shell tool (run or bash), applies the case's reference patch, runs CI
// again and finishes the framework's way (a done tool, mini-swe-agent's submit line, or plain text).
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Case } from './corpus.ts';
import { workflowJob } from './ci.ts';

export const FAKE_KEY = 'sk-or-v1-fake0000000000000000000000000000000000000000000000000000';
export interface FakeCall { name: string; arguments: unknown }
/** One reply: text, tool calls, reported cost, an HTTP error, a hang (after the first chunk when streaming), or no usage. */
export interface FakeReply {
  text?: string; calls?: FakeCall[]; cost?: number; upstreamCost?: number | null; status?: number; error?: string; hang?: boolean; noUsage?: boolean;
  reasoningDetails?: unknown[]; reasoningTokens?: number; provider?: string;
}
export type FakeScript = (body: Record<string, unknown>, index: number) => FakeReply | Promise<FakeReply>;
export interface FakeModel { id: string; context_length: number; top_provider: { max_completion_tokens: number }; supported_parameters: string[] }
export interface Received { path: string; authorization: string; headers: Record<string, string | string[] | undefined>; body: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const FAKE_MODELS: FakeModel[] = [
  { id: 'fake/coder', context_length: 200_000, top_provider: { max_completion_tokens: 32_000 }, supported_parameters: ['tools', 'tool_choice', 'reasoning', 'max_tokens', 'temperature'] },
  { id: 'fake/escalation', context_length: 400_000, top_provider: { max_completion_tokens: 64_000 }, supported_parameters: ['tools', 'tool_choice', 'max_tokens'] },
];

/** The fake upstream on 127.0.0.1; url is its /api/v1 base. */
export async function createFakeUpstream({ script, key = FAKE_KEY, models = FAKE_MODELS, latencyMs = 0 }: { script: FakeScript; key?: string; models?: FakeModel[]; latencyMs?: number }) {
  const received: Received[] = [], costs = new Map<string, number>();
  let index = 0;
  const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  async function completion(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) {
    const reply = await script(body, index++), id = `gen-${randomBytes(8).toString('hex')}`, model = typeof body.model === 'string' ? body.model : 'unknown';
    if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
    if (reply.status && reply.status >= 400) return json(response, reply.status, { error: { code: reply.status, message: reply.error ?? 'Upstream error' } });
    const cost = reply.cost ?? 0.001;
    costs.set(id, cost + (reply.upstreamCost ?? 0));
    const calls = (reply.calls ?? []).map((call, position) => ({ id: `call_${id.slice(4, 12)}_${position}`, type: 'function' as const, function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } }));
    const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: reply.reasoningTokens ?? 10 },
      cost, is_byok: reply.upstreamCost != null, cost_details: { upstream_inference_cost: reply.upstreamCost ?? null } };
    const finish = calls.length ? 'tool_calls' : 'stop', provider = reply.provider ?? 'FakeProvider';
    const hang = () => new Promise<void>(resolve => { request.on('close', () => resolve()); response.on('close', () => resolve()); });
    if (body.stream !== true) {
      if (reply.hang) return hang();
      return json(response, 200, { id, object: 'chat.completion', created: 1767225600, model, provider,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: reply.text ?? (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}), ...(reply.reasoningDetails ? { reasoning_details: reply.reasoningDetails } : {}) } }],
        ...(reply.noUsage ? {} : { usage }) });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1767225600, model, provider, choices, ...extra })}\n\n`);
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    if (reply.hang) return hang();
    response.write(': OPENROUTER PROCESSING\n\n');
    if (reply.reasoningDetails) chunk([{ index: 0, delta: { reasoning_details: reply.reasoningDetails }, finish_reason: null }]);
    if (reply.text) for (const part of reply.text.match(/[\s\S]{1,12}/g) ?? []) chunk([{ index: 0, delta: { content: part }, finish_reason: null }]);
    calls.forEach((call, position) => {
      const parts = call.function.arguments.match(/[\s\S]{1,16}/g) ?? [''];
      chunk([{ index: 0, delta: { tool_calls: [{ index: position, id: call.id, type: 'function', function: { name: call.function.name, arguments: parts[0] } }] }, finish_reason: null }]);
      for (const part of parts.slice(1)) chunk([{ index: 0, delta: { tool_calls: [{ index: position, function: { arguments: part } }] }, finish_reason: null }]);
    });
    chunk([{ index: 0, delta: {}, finish_reason: finish }]);
    if (!reply.noUsage) chunk([], { usage });
    response.end('data: [DONE]\n\n');
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake'), authorization = request.headers.authorization ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    let body: unknown = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    received.push({ path: url.pathname, authorization, headers: request.headers, body });
    try {
      if (request.method === 'GET' && url.pathname === '/api/v1/models') return json(response, 200, { data: models });
      if (authorization !== `Bearer ${key}`) return json(response, 401, { error: { code: 401, message: 'No auth credentials found' } });
      if (request.method === 'GET' && url.pathname === '/api/v1/generation') {
        const id = url.searchParams.get('id') ?? '';
        return costs.has(id) ? json(response, 200, { data: { id, total_cost: costs.get(id) } }) : json(response, 404, { error: { code: 404, message: 'Generation not found' } });
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/chat/completions' && isRecord(body)) return await completion(request, response, body);
      json(response, 404, { error: { code: 404, message: 'Not found' } });
    } catch (error) { if (!response.headersSent) json(response, 500, { error: { code: 500, message: String((error as Error).message) } }); else response.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v1`, port, received, key,
    async stop() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}

// ── The dry-run solver ──────────────────────────────────────────────────────────────────────────────────────────────
/** What the solver does for one repository: reproduce, patch, verify. */
export interface Solution { reproduce: string; patch: string; verify: string }
export const SUBMIT = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT';

/** The solutions for corpus cases, keyed by their repository: the CI commands through the failing step, and all of them. */
export async function corpusSolutions(cases: readonly Case[]): Promise<Map<string, Solution>> {
  const entries = await Promise.all(cases.map(async c => {
    const job = workflowJob(await readFile(join(c.repo, '.github/workflows/ci.yml'), 'utf8')), runs = job.steps.map(step => step.run.trim());
    const failing = job.steps.findIndex(step => step.name === c.meta.failingStep);
    return [c.meta.repository, { reproduce: runs.slice(0, failing + 1).join(' && '), patch: await readFile(c.reference, 'utf8'), verify: runs.join(' && ') }] as const;
  }));
  return new Map(entries);
}

const content = (message: unknown): string => {
  if (!isRecord(message)) return '';
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('\n') : '';
};
type Tool = { name: string; properties: Record<string, unknown>; required: string[] };
const toolsOf = (body: Record<string, unknown>): Tool[] => (Array.isArray(body.tools) ? body.tools : []).flatMap(tool => {
  const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : null;
  if (!fn || typeof fn.name !== 'string') return [];
  const parameters = isRecord(fn.parameters) ? fn.parameters : {};
  return [{ name: fn.name, properties: isRecord(parameters.properties) ? parameters.properties : {}, required: Array.isArray(parameters.required) ? parameters.required.filter(item => typeof item === 'string') : [] }];
});
/** Arguments for a tool: the given ones, and any other required string parameter filled with a short description. */
const fill = (tool: Tool, given: Record<string, unknown>) => Object.fromEntries([...Object.entries(given), ...tool.required.filter(name => !(name in given)).map(name => [name, 'Bench step'] as const)]);

/** The scripted solver for `run --dry-run`, framework-agnostic. */
export function solver(solutions: ReadonlyMap<string, Solution>, { cost = 0.002 }: { cost?: number } = {}): FakeScript {
  return body => {
    const messages = Array.isArray(body.messages) ? body.messages : [], tools = toolsOf(body);
    if (!tools.length && !messages.some(message => content(message).includes(SUBMIT))) return { text: 'Build repair', cost: 0 };
    const all = messages.map(content).join('\n'), repository = /Repository ([\w.-]+\/[\w.-]+)/.exec(all)?.[1] ?? '';
    const solution = solutions.get(repository);
    if (!solution) return { text: `No solution for ${repository || 'this repository'}.`, cost };
    const step = messages.filter(message => isRecord(message) && message.role === 'assistant').length;
    const shell = tools.find(tool => tool.name === 'run') ?? tools.find(tool => tool.name === 'bash');
    const command = (text: string): FakeReply => {
      if (!shell) return { text: `\`\`\`bash\n${text}\n\`\`\``, cost };
      const field = 'command' in shell.properties ? 'command' : shell.required.find(name => isRecord(shell.properties[name]) && shell.properties[name].type === 'string') ?? 'command';
      return { calls: [{ name: shell.name, arguments: fill(shell, { [field]: text }) }], cost };
    };
    const marker = `BENCH_PATCH_${randomBytes(4).toString('hex')}`;
    if (step === 0) return command(solution.reproduce);
    if (step === 1) return command(`git apply --whitespace=nowarn <<'${marker}'\n${solution.patch.endsWith('\n') ? solution.patch : `${solution.patch}\n`}${marker}`);
    if (step === 2) return command(solution.verify);
    const summary = 'Applied the fix; the failing CI commands pass now.';
    const done = tools.find(tool => tool.name === 'done');
    if (done) return { calls: [{ name: 'done', arguments: fill(done, { summary }) }], cost };
    if (messages.some(message => content(message).includes(SUBMIT))) return command(`echo ${SUBMIT} && echo '${summary}'`);
    return { text: summary, cost };
  };
}
