// Bench boxes: exactly the product's repair box (createRepairBoxes, owner repair-bench), each with a data directory of
// its own, since create() first removes leftovers of its owner and data directory and would otherwise remove sibling
// boxes running concurrently. A bench box adds two things the product's does not have:
// - copyIn: docker cp of a host folder into the box, for harness binaries and holdout tests;
// - attachGateway: the one extra endpoint an in-box harness may reach, the model gateway's port. A relay container
//   (node:22-bookworm-slim, read-only, no capabilities, user node, 128 MB) sits on a private uplink network of its own
//   and joins the box's internal network as `gateway`; it pipes each TCP connection to host.docker.internal:<gateway
//   port> and nowhere else. The box then reaches http://gateway:8080 directly, while host.docker.internal stays out of
//   reach directly (internal network) and through the egress proxy (a private address), and the proxy refuses
//   `gateway` too (it resolves to a private address). Every other product protection is unchanged.
// Every bench container and network is labelled perpetual.owner=repair-bench, perpetual.repair=<id> and
// perpetual.data=<data hash>, and docker runs with an empty DOCKER_CONFIG so no credential helper is ever asked.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, createRepairBoxes, type BoxResult, type RepairBox } from '../../src/repair/box.ts';
import { EGRESS } from '../../src/repair/egress.ts';
import { RELAY, RELAY_SCRIPT } from './relay.ts';

export const OWNER = 'repair-bench';
export const BENCH = dirname(fileURLToPath(import.meta.url));
export interface BenchBox extends RepairBox {
  readonly id: string; readonly name: string; readonly network: string; readonly scope: string;
  /** Copies a host folder's contents into path in the box, owned by root. */
  copyIn(host: string, path: string): Promise<void>;
  /** Attaches the gateway relay for a host port; returns the base URL the box reaches it at. */
  attachGateway(port: number): Promise<string>;
}

/**
 * What an in-box harness process adds to the box's environment: gateway joins NO_PROXY, so it is reached directly
 * rather than through the egress proxy (which would refuse it). Pass it as `env K=V … command`.
 */
export const gatewayEnvironment = () => { const local = `localhost,127.0.0.1,::1,${RELAY.alias}`; return { NO_PROXY: local, no_proxy: local }; };

/** docker runs with an empty config of the bench's own, never the user's credential helper or context. */
export async function useBenchDocker(directory = join(BENCH, '.cache', 'docker-config')) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'config.json'), '{}\n');
  process.env.DOCKER_CONFIG = directory;
  return directory;
}
function dockerEnvironment() {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR'];
  return Object.fromEntries(keep.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key] as string]));
}
export const docker = (args: readonly string[], timeoutMs = 60_000, signal?: AbortSignal) => capture('docker', args, { env: dockerEnvironment(), timeoutMs, signal });
const must = async (args: readonly string[], failure: string, timeoutMs = 60_000) => {
  const result = await docker(args, timeoutMs);
  if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim().split('\n')[0] || `docker ${args[0]} failed`}`);
  return result;
};
const scopeOf = async (dataDir: string) => createHash('sha256').update(await realpath(dataDir)).digest('hex').slice(0, 16);
let desktop: Promise<boolean> | null = null;
/** Docker Desktop resolves host.docker.internal on every network; a Linux engine needs host-gateway named. */
const dockerDesktop = () => desktop ??= docker(['info', '--format', '{{.OperatingSystem}}'], 20_000).then(result => /Docker Desktop/i.test(result.stdout), () => false);

/** Why no bench box can start, or null. */
export async function dockerAvailable() {
  try { const result = await docker(['version', '--format', '{{.Server.Version}}'], 15_000); return result.exitCode === 0 && result.stdout.trim() ? null : 'Start Docker to run the bench.'; }
  catch { return 'Install Docker to run the bench.'; }
}

/**
 * A product repair box from source for the bench, in a fresh data directory under root. onScope hears its data hash
 * before anything is created, so a cleanup can find a box whose creation was interrupted.
 */
export async function createBenchBox({ image, source, root, signal, onScope }: { image: string; source: string; root: string; signal?: AbortSignal; onScope?(scope: string): void | Promise<void> }): Promise<BenchBox> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dataDir = await mkdtemp(join(root, 'box-')), id = randomUUID(), scope = await scopeOf(dataDir);
  await onScope?.(scope);
  const name = `perpetual-${OWNER}-${id}`, relay = `${name}-gateway`, uplink = `${name}-uplink`;
  const labels = [`perpetual.owner=${OWNER}`, `perpetual.repair=${id}`, `perpetual.data=${scope}`].flatMap(label => ['--label', label]);
  let box: RepairBox;
  try { box = await createRepairBoxes({ dataDir, owner: OWNER }).create({ id, image, source, signal }); }
  catch (error) { await rm(dataDir, { recursive: true, force: true }).catch(() => {}); throw error; }
  // Debian's /etc/profile resets PATH for login shells, dropping what the image's ENV added (golang's /usr/local/go/bin), so a
  // harness that runs commands with bash -l would miss a toolchain that CI and non-login shells find. Login shells keep the image's PATH.
  const kept = await box.exec(['sh', '-c', 'printf "export PATH=\'%s\'\\n" "$PATH" > /etc/profile.d/00-image-path.sh'], { timeoutMs: 30_000, signal }).catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }));
  if (kept.exitCode !== 0) { await box.remove().catch(() => {}); await rm(dataDir, { recursive: true, force: true }).catch(() => {}); throw new Error(`Could not keep the image's PATH for login shells: ${kept.stderr.trim().slice(0, 200)}`); }
  let attached = false;
  const detach = async () => {
    if (!attached) return;
    await docker(['rm', '-f', '-v', relay]).catch(() => {});
    await docker(['network', 'rm', uplink]).catch(() => {});
  };
  return {
    id, name, network: name, scope, root: box.root, image: box.image, signal: box.signal,
    exec: (argv, options) => box.exec(argv, options),
    diff: base => box.diff(base),
    async remove() { await detach(); await box.remove(); await rm(dataDir, { recursive: true, force: true }).catch(() => {}); },
    async copyIn(host, path) {
      if (!path.startsWith('/') || path.includes('\0')) throw new Error('Copy into an absolute box path.');
      await must(['cp', `${host}/.`, `${name}:${path}`], 'Could not copy into the bench box', 10 * 60_000);
      await must(['exec', name, 'chown', '-R', '0:0', path], 'Could not copy into the bench box');
    },
    async attachGateway(port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port.');
      if (attached) throw new Error('The gateway is already attached.');
      attached = true;
      try {
        await must(['network', 'create', ...labels, uplink], 'Could not create the gateway uplink');
        await must(['create', '--name', relay, ...labels, '--init', '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', EGRESS.user,
          '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64', '--network', uplink, ...(await dockerDesktop() ? [] : ['--add-host', 'host.docker.internal:host-gateway']),
          '--pull', 'missing', EGRESS.image, 'node', '-e', RELAY_SCRIPT, String(RELAY.port), 'host.docker.internal', String(port)], `Could not create the gateway relay from ${EGRESS.image}`, 15 * 60_000);
        await must(['network', 'connect', '--alias', RELAY.alias, name, relay], 'Could not attach the gateway relay');
        await must(['start', relay], 'Could not start the gateway relay');
        for (let tries = 0; ; tries += 1) {
          const logs: BoxResult = await docker(['logs', relay], 10_000);
          if (logs.stdout.trim() === String(RELAY.port)) break;
          if (tries >= 50) throw new Error('The gateway relay did not start.');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error) { await detach(); attached = false; throw error; }
      return `http://${RELAY.alias}:${RELAY.port}`;
    },
  };
}

/** Removes bench containers and networks: those of the given data hashes, or every repair-bench one. */
export async function removeBenchResources(scopes: readonly string[] | 'all') {
  const ids = (result: BoxResult) => result.exitCode === 0 ? result.stdout.split(/\s+/).filter(id => /^[a-f\d]{12,64}$/.test(id)) : [];
  const filters = scopes === 'all' ? [['--filter', `label=perpetual.owner=${OWNER}`]] : scopes.map(scope => ['--filter', `label=perpetual.owner=${OWNER}`, '--filter', `label=perpetual.data=${scope}`]);
  let containers = 0, networks = 0;
  for (const filter of filters) {
    const found = ids(await docker(['ps', '-aq', '--no-trunc', ...filter], 20_000));
    if (found.length) { await docker(['rm', '-f', '-v', ...found]); containers += found.length; }
  }
  for (const filter of filters) {
    const found = ids(await docker(['network', 'ls', '-q', '--no-trunc', ...filter], 20_000));
    if (found.length) { await docker(['network', 'rm', ...found]); networks += found.length; }
  }
  return { containers, networks };
}
