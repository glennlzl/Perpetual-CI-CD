// A bench box's network in real Docker, only with BENCH_DOCKER=1: with the gateway relay attached it reaches the model
// gateway's port as http://gateway:8080 and nothing else on the host, directly or through the product's egress proxy.
// Its containers and networks are labelled perpetual.owner=repair-bench and removed by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchBox, docker, gatewayEnvironment, removeBenchResources, useBenchDocker } from '../box.ts';
import { FAKE_KEY, createFakeUpstream } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';

const skip = process.env.BENCH_DOCKER !== '1' && 'Set BENCH_DOCKER=1 to run bench boxes in Docker.';

test('a bench box reaches the gateway through its relay, and no other host port, directly or through the proxy', { skip, timeout: 10 * 60_000 }, async t => {
  await useBenchDocker();
  const root = await mkdtemp(join(tmpdir(), 'bench-box-')), source = await mkdtemp(join(tmpdir(), 'bench-box-source-'));
  await writeFile(join(source, 'README.md'), 'box\n');
  const upstream = await createFakeUpstream({ script: () => ({ text: 'from the gateway', cost: 0.001 }) });
  const gateway = await createGateway({ key: FAKE_KEY, budget: 1, upstream: upstream.url });
  const hits: string[] = [], controller = createServer((request, response) => { hits.push(request.url ?? ''); response.end('controller'); });
  controller.listen(0, '127.0.0.1');
  await once(controller, 'listening');
  const other = (controller.address() as AddressInfo).port;
  const scopes: string[] = [];
  t.after(async () => {
    await removeBenchResources(scopes).catch(() => {});
    controller.close(); await gateway.stop(); await upstream.stop();
    await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
  });
  const box = await createBenchBox({ image: 'node:22-bookworm', source, root, onScope: scope => { scopes.push(scope); } });
  const base = await box.attachGateway(gateway.port);
  assert.equal(base, 'http://gateway:8080');
  const opened = await gateway.open({ attempt: 'box', model: 'fake/coder', cap: 0.1, deadline: Date.now() + 5 * 60_000 });
  const curl = (...args: string[]) => box.exec(['curl', '-sS', '-m', '10', ...args], { timeoutMs: 30_000 });
  const code = (...args: string[]) => curl('-o', '/dev/null', '-w', '%{http_code}', ...args);
  // Directly, as an in-box harness does with gateway in NO_PROXY.
  assert.equal((await code('--noproxy', '*', '-X', 'POST', '-d', '{}', `${base}/api/v1/chat/completions`)).stdout, '401', 'The gateway answers, and wants a token.');
  // As a harness started with gatewayEnvironment() does: the box's proxy settings stay, and gateway is reached directly.
  const env = Object.entries(gatewayEnvironment()).map(([key, value]) => `${key}=${value}`);
  const answered = await box.exec(['env', ...env, 'curl', '-sS', '-m', '10', '-H', `Authorization: Bearer ${opened!.token}`, '-d', JSON.stringify({ model: 'fake/coder', messages: [{ role: 'user', content: 'hi' }] }), `${base}/api/v1/chat/completions`], { timeoutMs: 30_000 });
  assert.match(answered.stdout, /from the gateway/);
  assert.equal(upstream.received.filter(item => item.path === '/api/v1/chat/completions').length, 1);
  // Nothing else on the host: not directly, not through the proxy, and not through the relay on another port.
  const direct = await code('--noproxy', '*', `http://host.docker.internal:${other}/`);
  assert.notEqual(direct.exitCode, 0, 'The internal network has no route to the host.');
  assert.equal((await code(`http://host.docker.internal:${other}/`)).stdout, '403', 'The proxy refuses the host.');
  assert.equal((await code(`http://host.docker.internal:${gateway.port}/api/v1/chat/completions`)).stdout, '403', 'The proxy refuses the gateway\'s own host port.');
  assert.equal((await code(`${base}/api/v1/chat/completions`)).stdout, '403', 'The proxy refuses gateway, a private address.');
  assert.notEqual((await code('--noproxy', '*', `http://gateway:${other}/`)).exitCode, 0, 'The relay listens on its one port only.');
  assert.deepEqual(hits, [], 'The other host listener was never reached.');
  // The relay is locked down, labelled as the box, and on the box's network and its own uplink alone.
  const [relay] = JSON.parse((await docker(['inspect', `${box.name}-gateway`])).stdout);
  assert.deepEqual([relay.Config.Labels['perpetual.owner'], relay.Config.Labels['perpetual.repair'], relay.Config.Labels['perpetual.data']], ['repair-bench', box.id, box.scope]);
  assert.deepEqual([relay.HostConfig.ReadonlyRootfs, relay.HostConfig.CapDrop, relay.HostConfig.SecurityOpt, relay.Config.User, relay.HostConfig.Memory], [true, ['ALL'], ['no-new-privileges'], 'node', 128 * 1024 ** 2]);
  assert.deepEqual(Object.keys(relay.NetworkSettings.Networks).sort(), [box.name, `${box.name}-uplink`].sort());
  assert.deepEqual([relay.Mounts, relay.HostConfig.Binds ?? []], [[], []]);
  await box.remove();
  const left = await docker(['ps', '-aq', '--filter', `label=perpetual.repair=${box.id}`]);
  const networks = await docker(['network', 'ls', '-q', '--filter', `label=perpetual.repair=${box.id}`]);
  assert.deepEqual([left.stdout.trim(), networks.stdout.trim()], ['', ''], 'Removing the box removes its relay and uplink.');
});
