// Codex's smoke test in a real bench box, only with BENCH_DOCKER=1. prepare() fetches the pinned release once (then
// cached in .cache/codex) and copies it into a logic-tier-boundary box. A scripted Responses API on the host, reached
// through the box's gateway relay exactly as the gateway is, drives Codex's own exec_command tool: it reads the proxy
// and token variables of the command environment, reproduces the failure, applies the reference patch and runs CI;
// Codex then ends its turn with a message. The box's diff passes the judge in a new box. The scripted API stands in for
// the gateway's Responses route and checks the attempt's token itself. Containers and networks are labelled
// perpetual.owner=repair-bench and removed by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapter } from '../adapters/codex/index.ts';
import { createBenchBox, removeBenchResources, useBenchDocker } from '../box.ts';
import { prepareCase } from '../context.ts';
import { loadCases } from '../corpus.ts';
import { corpusSolutions, type Solution } from '../fake-upstream.ts';
import { LIMITS, harnessNote, type AttemptEvent } from '../harness.ts';
import { judge } from '../judge.ts';

const skip = process.env.BENCH_DOCKER !== '1' && 'Set BENCH_DOCKER=1 to run bench boxes in Docker.';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const said = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('\n') : '';
const SUMMARY = 'Applied the fix; the failing CI commands pass now.';
const PROBE = 'env | grep -iE "proxy|token" | sort';
const files = (diff: string) => [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]).sort();

/** The script's next output item: one exec_command per step, write_stdin while one still runs, then a final message. */
function next(body: Record<string, unknown>, solutions: ReadonlyMap<string, Solution>) {
  const input = Array.isArray(body.input) ? body.input.filter(isRecord) : [], id = () => randomBytes(6).toString('hex');
  const call = (name: string, args: Record<string, unknown>) => ({ type: 'function_call', id: `fc_${id()}`, call_id: `call_${id()}`, name, arguments: JSON.stringify(args) });
  const reply = (text: string) => ({ type: 'message', id: `msg_${id()}`, role: 'assistant', content: [{ type: 'output_text', text }] });
  const solution = solutions.get(/Repository ([\w.-]+\/[\w.-]+)/.exec(input.map(item => said(item.content)).join('\n'))?.[1] ?? '');
  if (!solution) return reply('No solution for this repository.');
  const running = /Process running with session ID (\d+)/.exec(said(input.filter(item => item.type === 'function_call_output').at(-1)?.output));
  if (running) return call('write_stdin', { session_id: Number(running[1]), chars: '', yield_time_ms: 30_000 });
  const marker = `BENCH_PATCH_${id()}`;
  const steps = [PROBE, solution.reproduce, `git apply --whitespace=nowarn <<'${marker}'\n${solution.patch.endsWith('\n') ? solution.patch : `${solution.patch}\n`}${marker}`, solution.verify];
  const ran = input.filter(item => item.type === 'function_call' && item.name === 'exec_command').length;
  return ran < steps.length ? call('exec_command', { cmd: steps[ran], yield_time_ms: 30_000 }) : reply(SUMMARY);
}

/** POST /api/v1/responses as a Responses API stream, for the attempt's token only. */
async function responsesApi(token: string, solutions: ReadonlyMap<string, Solution>) {
  const bodies: Record<string, unknown>[] = [], seen: string[] = [];
  const answer = (response: ServerResponse, status: number, message: string) => void response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } }));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    seen.push(`${request.method} ${(request.url ?? '').split('?')[0]}`);
    if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== '/api/v1/responses') return answer(response, 404, 'Not found.');
    if (request.headers.authorization !== `Bearer ${token}`) return answer(response, 401, 'Unknown token.');
    let body: unknown = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* refused below */ }
    if (!isRecord(body)) return answer(response, 400, 'The body is not a JSON object.');
    bodies.push(body);
    const id = `resp_${bodies.length}`, item = next(body, solutions);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: { id, status: 'in_progress' } });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { id, status: 'completed', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1050 } } });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}/api/v1`, bodies, seen, async stop() { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); } };
}

test('Codex repairs logic-tier-boundary in a bench box through the relay, and the judge passes its diff', { skip, timeout: 25 * 60_000 }, async t => {
  await useBenchDocker();
  const directory = await mkdtemp(join(tmpdir(), 'bench-codex-')), root = join(directory, 'boxes'), scopes: string[] = [];
  const onScope = (scope: string) => { scopes.push(scope); };
  const cases = await loadCases(['logic-tier-boundary']), [c] = cases, token = randomBytes(32).toString('base64url');
  const api = await responsesApi(token, await corpusSolutions(cases));
  t.after(async () => { await removeBenchResources(scopes).catch(() => {}); await api.stop(); await rm(directory, { recursive: true, force: true }); });
  const context = await prepareCase(c, { directory: join(directory, c.name), root, onScope });
  const box = await createBenchBox({ image: context.image, source: context.snapshot, root, onScope });
  const events: AttemptEvent[] = [], signal = new AbortController().signal;
  let diff: Buffer;
  try {
    await adapter.prepare?.(box, signal);
    const boxUrl = `${await box.attachGateway(api.port)}/api/v1`;
    const outcome = await adapter.runAttempt({ box, system: context.system, prompt: context.prompt, failing: context.failing, model: { id: 'fake/coder', contextWindow: 200_000, maxOutput: 32_000, reasoning: true },
      gateway: { baseUrl: api.url, boxUrl, token }, limits: LIMITS, signal, scratch: directory, log: event => { events.push(event); } });
    assert.deepEqual([outcome.reason, outcome.reproduced, outcome.summary], ['done', true, SUMMARY], JSON.stringify(events.at(-1)));
    assert.ok(outcome.steps >= 4, 'Each exec_command ran in the box.');
    diff = await box.diff(context.sha);
  } finally { await box.remove(); }
  const first = api.bodies[0], input = Array.isArray(first?.input) ? first.input.filter(isRecord) : [];
  assert.deepEqual([first?.model, first?.stream, first?.store], ['fake/coder', true, false]);
  assert.ok(input.some(item => item.role === 'user' && said(item.content) === context.prompt), 'The product\'s prompt is the task, byte for byte.');
  assert.ok(input.some(item => item.role === 'developer' && said(item.content).includes(`${context.system}\n\n${harnessNote('codex')}`)), 'INSTRUCTIONS and the harness note are developer instructions.');
  assert.ok(typeof first?.instructions === 'string' && first.instructions.length > 0 && !first.instructions.includes(context.system), 'Codex keeps its own base instructions.');
  const tools = (Array.isArray(first?.tools) ? first.tools.filter(isRecord) : []).map(tool => String(tool.name ?? tool.type));
  assert.ok(tools.includes('exec_command') && !tools.some(name => /web_search|image_gen|spawn_agent/.test(name)), tools.join(', '));
  assert.deepEqual([...new Set(api.seen)], ['POST /api/v1/responses'], 'Codex asked this host for nothing but the Responses route.');
  const probe = events.find(event => event.type === 'codex.command' && String(event.command).includes('grep -iE'));
  assert.match(String(probe?.output), /^HTTPS_PROXY=http:\/\/proxy:3128\r?$/m, 'Commands keep the box\'s egress proxy.');
  // Codex 0.157's exec_command ignores shell_environment_policy (neither `exclude` nor `inherit = "core"` removes it), so
  // commands see the attempt's token: a known limitation of the harness, recorded rather than asserted away. The real key
  // never enters the box, and the token only reaches this attempt's gateway route under its cap.
  if (/BENCH_TOKEN/.test(String(probe?.output))) t.diagnostic('Codex passes BENCH_TOKEN to the commands it runs, despite shell_environment_policy.');
  assert.deepEqual(files(diff.toString('utf8')), files(await readFile(c.reference, 'utf8')), 'Codex left nothing of its own in /workspace.');
  assert.match(diff.toString('utf8'), /^\+  for \(const \[min, percent\] of TIERS\) if \(subtotal >= min\) return percent;$/m);
  const judged = await judge({ c, snapshot: context.snapshot, sha: context.sha, diff, image: context.image, steps: context.job.steps, root, onScope });
  assert.deepEqual([judged.reason, judged.passed, judged.steps.map(step => step.exit)], ['passed', true, [0, 0]]);
});
