import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { EGRESS_SCRIPT, egressEnvironment } from '../src/repair/egress.ts';

// The proxy runs on the host here, on loopback only; nothing leaves the machine. A listener on 127.0.0.1 stands in for
// the controller or a twin that the box must never reach.
async function proxy(t: TestContext) {
  const child = spawn(process.execPath, ['-e', EGRESS_SCRIPT, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill(); });
  const [chunk] = await once(child.stdout, 'data') as [Buffer];
  const hits: string[] = [], target: Server = createServer((incoming, answer) => { hits.push(incoming.url ?? ''); answer.end('controller'); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => { target.close(); });
  return { port: Number(chunk.toString().trim()), target: (target.address() as AddressInfo).port, hits };
}
const tunnel = (port: number, authority: string) => new Promise<number>((resolve, reject) => {
  const sent = request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority });
  sent.on('connect', (answer, socket) => { socket.destroy(); resolve(answer.statusCode ?? 0); });
  sent.on('error', reject);
  sent.end();
});
const forward = (port: number, path: string) => new Promise<number>((resolve, reject) => {
  const sent = request({ host: '127.0.0.1', port, path }, answer => { answer.resume(); resolve(answer.statusCode ?? 0); });
  sent.on('error', reject);
  sent.end();
});

test('the egress proxy refuses loopback, private, link-local and mapped addresses, by name or by number', async t => {
  const p = await proxy(t);
  for (const authority of [`127.0.0.1:${p.target}`, `localhost:${p.target}`, `[::1]:${p.target}`, `[::ffff:127.0.0.1]:${p.target}`, '10.1.2.3:443', '172.17.0.1:4317', '192.168.65.254:4317', '169.254.169.254:80', '[fd00::1]:443', '0.0.0.0:80', 'no-port', '127.0.0.1:0']) {
    assert.equal(await tunnel(p.port, authority), 403, authority);
  }
  for (const path of [`http://127.0.0.1:${p.target}/api/session`, `http://localhost:${p.target}/`, `http://[::1]:${p.target}/`, '/api/session', `ftp://127.0.0.1:${p.target}/`]) {
    assert.equal(await forward(p.port, path), 403, path);
  }
  assert.deepEqual(p.hits, [], 'Nothing reached the local listener.');
});

test('the box sends package managers, git, curl, JVMs and Node through the proxy, and local traffic around it', () => {
  const env = egressEnvironment();
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.equal(env[key as keyof typeof env], 'http://proxy:3128');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.match(env.JAVA_TOOL_OPTIONS, /-Dhttps\.proxyHost=proxy -Dhttps\.proxyPort=3128/);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});
