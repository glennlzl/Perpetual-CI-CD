import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { APPS, ID, INSTALL, addressText, fail, leaveOutBlocked, placeholders, resolvePlaceholders, setupOrder, validateTwinConfig } from './config.mjs';
import { APP_IMAGE, HOST, HOST_GATEWAY, LABELS, LOOPBACK, PACKAGE_CACHE, PACKAGE_CACHE_ENV, PACKAGE_CACHE_MOUNT, SOURCE, WORKSPACE, WORKSPACE_VOLUME, addressKey, appCommand, composeTwin, formatEnv, hostUrl, portKey, variables } from './compose.mjs';
import { missingInputs } from './inputs.mjs';
import { services as registry } from './registry.mjs';

// A twin is <dataDir>/environments/<id>/twin/{compose.yaml,.env,twin.json}: service setup in
// placeholder order; once services are up, their test accounts, the shared install and fixtures;
// then `docker compose up --wait`.

export const PORT_BASE = 43100;
export const PORT_BLOCK = 48;
const ANY_ADDRESS = '0.0.0.0';
const ENVIRONMENTS = 'environments';
const TWIN = 'twin';
/** Per-machine state a service shares across twins, e.g. one self-hosted instance. */
const SHARED = 'twin-services';
const TWIN_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** SQL fixtures run psql against this variable of their service. */
export const SQL_URL = 'DATABASE_URL';
const SQL_CLIENT = 'postgres:17-alpine';
const SECRET_NAME = /secret|token|passw|private|credential|key$/i;
/** Read by the docker CLI itself, so never passed through its environment. */
const CLI_VARIABLE = /^(?:DOCKER_\w*|PATH|HOME)$/;
const MIN_SECRET = 4;
const REDACTED = '[redacted]';
/** Trailing lines of a failed command's output kept in its error; progress comes first, the error last. */
const ERROR_OUTPUT = 30;
const tail = text => text.trim().split('\n').slice(-ERROR_OUTPUT).join('\n');

const execFileAsync = promisify(execFile);
/** exec(file, args, { env, cwd }) -> { stdout, stderr }; rejects on a non-zero exit. */
export const execCommand = (file, args, { env, cwd } = {}) => execFileAsync(file, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });

const listens = (port, host) => new Promise(done => {
  const server = createServer();
  server.once('error', () => done(false));
  server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
});
export const portFree = async port => await listens(port, LOOPBACK) && await listens(port, ANY_ADDRESS);

/** The first `count` free host ports from `start` upward, skipping other twins' blocks. */
export async function allocatePorts({ count = PORT_BLOCK, start = PORT_BASE, reserved = new Set(), isFree = portFree } = {}) {
  const ports = [];
  for (let port = start; ports.length < count; port += 1) {
    if (port > 65535) fail('No free host ports are left for this twin.');
    if (!reserved.has(port) && await isFree(port)) ports.push(port);
  }
  return ports;
}

export function redactor(secrets) {
  const values = [...new Set(secrets)].filter(value => typeof value === 'string' && value.length >= MIN_SECRET).sort((a, b) => b.length - a.length);
  return text => values.reduce((result, value) => result.replaceAll(value, REDACTED), String(text));
}

const secretValues = values => Object.entries(values ?? {}).filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string').map(([, value]) => value);
const ACCOUNT_TEXT = { label: 120, username: 320, password: 1024 };

/** What a service's accounts(ctx) returns: [{ id, label, username, password, authEndpoints? }], checked before it is stored.
 * authEndpoints are the URLs the product's own sign-in posts to, so read-only discovery can let exactly that request through. */
function testAccounts(list, where) {
  if (!Array.isArray(list)) fail(`${where} must be a list.`);
  return list.map((account, index) => {
    const text = name => typeof account?.[name] === 'string' && account[name].trim() && account[name].length <= ACCOUNT_TEXT[name] && !/[\x00-\x1f\x7f]/.test(account[name]);
    if (typeof account?.id !== 'string' || !ID.test(account.id) || !Object.keys(ACCOUNT_TEXT).every(text)) fail(`${where}[${index}] needs an id, label, username and password.`);
    const endpoints = account.authEndpoints ?? [];
    if (!Array.isArray(endpoints) || endpoints.length > 3 || endpoints.some(url => typeof url !== 'string' || !/^https?:\/\/[^/?#]+\/[^?#]+$/.test(url))) fail(`${where}[${index}].authEndpoints must list at most 3 absolute URLs with a path.`);
    return { id: account.id, label: account.label, username: account.username, password: account.password, ...(endpoints.length ? { authEndpoints: endpoints } : {}) };
  });
}
const exists = path => access(path).then(() => true, () => false);
// Some CLIs report progress on stderr and their final error on stdout, so both are kept, stdout last.
const errorText = error => tail([error?.stderr, error?.stdout].filter(text => typeof text === 'string' && text.trim()).map(text => text.trim()).join('\n') || String(error?.message || error));

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writePrivate(file, text) {
  const temporary = `${file}.${randomUUID()}`;
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

// Host ports belong to the machine: a twin reads the other twins' saved blocks and the ports of shared
// instances, and saves its own block in one turn, so twins prepared at the same time never share a port.
let reserving = Promise.resolve();
const reserveInTurn = work => { const turn = reserving.then(work); reserving = turn.catch(() => {}); return turn; };
/** Ports of services' machine-wide instances, { '<service>.<name>': port }, kept beside their shared state. */
const SHARED_PORTS = 'ports.json';
const isPort = value => Number.isInteger(value) && value > 0 && value <= 65535;

async function reservedPorts(dataDir, id) {
  const root = resolve(dataDir), environments = join(root, ENVIRONMENTS);
  const entries = await readdir(environments).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const states = await Promise.all(entries.filter(entry => entry !== id).map(entry => readJson(join(environments, entry, TWIN, 'twin.json')).catch(() => null)));
  const shared = Object.values(await readJson(join(root, SHARED, SHARED_PORTS)) ?? {});
  return new Set([...states.flatMap(state => Array.isArray(state?.block) ? state.block : []), ...shared]);
}

/** The host port of a machine-wide instance: reserved once, outside every twin's block, and never given to a twin.
 * `current` keeps the port an existing instance already publishes. */
const reserveSharedPort = (dataDir, key, current, { start, isFree }) => reserveInTurn(async () => {
  const dir = join(resolve(dataDir), SHARED), file = join(dir, SHARED_PORTS), ports = await readJson(file) ?? {};
  if (isPort(ports[key])) return ports[key];
  ports[key] = isPort(current) ? current : (await allocatePorts({ count: 1, start, reserved: await reservedPorts(dataDir), isFree }))[0];
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivate(file, `${JSON.stringify(ports, null, 2)}\n`);
  return ports[key];
});

const parsePs = stdout => {
  const text = String(stdout).trim();
  if (!text) return [];
  return text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line));
};

const overall = containers => !containers.length ? 'stopped'
  : containers.some(item => ['exited', 'dead'].includes(item.state) || item.health === 'unhealthy') ? 'failed'
  : containers.every(item => item.state === 'running' && [null, 'healthy'].includes(item.health)) ? 'ready' : 'starting';

export function createTwinRuntime({ exec = execCommand, services = registry, isFree = portFree, portBase = PORT_BASE, appImage = APP_IMAGE, owner } = {}) {
  const locate = (dataDir, id) => {
    if (typeof id !== 'string' || !TWIN_ID.test(id)) fail('A twin id must use lowercase letters, digits, hyphens or underscores.');
    const dir = join(resolve(dataDir), ENVIRONMENTS, id, TWIN);
    return { id, dir, root: resolve(dataDir), shared: join(resolve(dataDir), SHARED), project: `perpetual-${id}`, owner: owner ?? createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16),
      state: join(dir, 'twin.json'), compose: join(dir, 'compose.yaml'), env: join(dir, '.env') };
  };
  const composeArgs = (twin, ...args) => ['compose', '--project-name', twin.project, '--project-directory', twin.dir, '--file', twin.compose, '--env-file', twin.env, ...args];

  async function host(file, args, { env, cwd, redact = String } = {}) {
    try { return await exec(file, args, { ...(env && { env }), ...(cwd && { cwd }) }); }
    catch (error) { throw new Error(redact(errorText(error))); }
  }
  const docker = (args, options) => host('docker', args, options);

  // Values travel in the child's environment and `--env NAME`, never on the command line.
  const dockerRun = (twin, image, args, { env = {}, volumes = [], workdir, redact }) => {
    for (const name of Object.keys(env)) if (CLI_VARIABLE.test(name)) fail(`${name} cannot be passed to a container run.`);
    return docker(['run', '--rm', '--add-host', HOST_GATEWAY, '--label', `${LABELS.owner}=${twin.owner}`, '--label', `${LABELS.environment}=${twin.id}`,
      ...volumes.flatMap(volume => ['--volume', volume]), ...(workdir ? ['--workdir', workdir] : []), ...Object.keys(env).flatMap(name => ['--env', name]), image, ...args], { env, redact });
  };

  function context(twin, { service, options, inputs, outputs, ports, take, source, redact }) {
    const dir = join(twin.dir, 'services', service);
    const port = name => take(portKey(service, name));
    return {
      options, inputs, outputs, host: HOST, project: twin.project, dir, shared: join(twin.shared, service), source,
      port, url: (name, path = '') => hostUrl(port(name), path),
      // A port for this service's machine-wide instance, the same for every twin and outside all their blocks.
      sharedPort: (name, current) => reserveSharedPort(twin.root, portKey(service, name), current, { start: portBase, isFree }),
      app: id => { const appPort = ports[portKey(APPS, id)] ?? fail(`No app "${id}" is configured.`); return { url: hostUrl(appPort), port: appPort }; },
      run: (image, args, { env } = {}) => dockerRun(twin, image, args, { env: variables(env, `${service} run`), volumes: [`${dir}:${dir}`, `${source}:${source}:ro`], workdir: dir, redact }),
      // A pinned CLI on the host, for tools that drive Docker themselves; the Docker socket is never mounted into a container.
      exec: (file, args, { cwd = dir } = {}) => host(file, args, { cwd, redact }),
    };
  }

  const sqlEnv = (fixture, env) => ({ [SQL_URL]: env[SQL_URL] ?? fail(`${fixture.service} does not provide ${SQL_URL}, which SQL fixtures use.`) });
  const loadFixture = (twin, fixture, env, source, redact, workspace) => fixture.sql
    ? dockerRun(twin, SQL_CLIENT, ['sh', '-c', `exec psql "$${SQL_URL}" -v ON_ERROR_STOP=1 -f "$1"`, 'fixture', posix.join(WORKSPACE, fixture.sql)],
      { env: sqlEnv(fixture, env), volumes: [`${source}:${WORKSPACE}:ro`], redact })
    : fixture.query ? dockerRun(twin, SQL_CLIENT, ['sh', '-c', `exec psql "$${SQL_URL}" -v ON_ERROR_STOP=1 -c "$1"`, 'fixture', fixture.query], { env: sqlEnv(fixture, env), redact })
    // A command fixture runs where the install put the dependencies: the twin's workspace volume when it has one.
    : dockerRun(twin, appImage, ['sh', '-c', appCommand(fixture.command)], { env: { ...PACKAGE_CACHE_ENV, ...env }, volumes: [workspace ? `${twin.project}_${WORKSPACE_VOLUME}:${WORKSPACE}` : `${source}:${WORKSPACE}`, PACKAGE_CACHE_MOUNT], workdir: WORKSPACE, redact });

  /** inputs: { <service id>: { <input name>: value } }, e.g. from createTwinInputs().values(). */
  async function prepare({ dataDir, id, config: input, source, inputs = {}, onStep = () => {} }) {
    const config = validateTwinConfig(input, { services });
    const twin = locate(dataDir, id);
    if (typeof source !== 'string' || !await exists(source)) fail('A source snapshot directory is required.');
    source = resolve(source);
    if (await exists(twin.state)) await destroy({ dataDir, id, inputs });
    await mkdir(twin.dir, { recursive: true, mode: 0o700 });
    const free = [], secrets = new Set();
    const state = { id, project: twin.project, owner: twin.owner, source, block: [], ports: {}, services: [], secrets: [] };
    const redact = text => redactor(secrets)(text);
    const save = () => { state.secrets = [...secrets]; return writePrivate(twin.state, `${JSON.stringify(state, null, 2)}\n`); };
    const take = key => state.ports[key] ??= free.shift() ?? fail(`This twin needs more than ${PORT_BLOCK} host ports.`);
    // Service addresses are allocated before any setup, so a service may reference one whose setup needs its own variables.
    const addresses = [...placeholders(config.services, 'services'), ...placeholders(config.apps, APPS)].filter(ref => ref.addressOf);
    const own = new Set(); // ports services take themselves
    await reserveInTurn(async () => {
      state.block = await allocatePorts({ start: portBase, reserved: await reservedPorts(dataDir, id), isFree });
      free.push(...state.block);
      for (const app of Object.keys(config.apps)) take(portKey(APPS, app));
      for (const ref of addresses) take(addressKey(ref));
      await save();
    });

    const resolved = {};
    for (const serviceId of setupOrder(config)) {
      const definition = services[serviceId], values = inputs[serviceId] ?? {}, base = { id: serviceId, fidelity: definition.fidelity };
      for (const item of definition.inputs ?? []) if (item.secret && typeof values[item.name] === 'string') secrets.add(values[item.name]);
      const blocked = service => resolved[service]?.status === 'blocked';
      const declared = leaveOutBlocked(config.services[serviceId], blocked);
      const upstream = placeholders(declared).filter(ref => blocked(ref.service)).flatMap(ref => resolved[ref.service].missing);
      const missing = [...new Set([...missingInputs(definition, values), ...upstream])];
      if (missing.length) { resolved[serviceId] = { ...base, status: 'blocked', missing }; continue; }
      await onStep(`Setting up ${definition.title}`);
      const where = `services.${serviceId}`;
      const options = resolvePlaceholders(declared, ref => addressKey(ref) ? hostUrl(state.ports[addressKey(ref)])
        : resolved[ref.service].env[ref.variable] ?? fail(`${where}: ${ref.service} does not provide ${ref.variable}.`), where);
      const ctx = context(twin, { service: serviceId, options, inputs: values, outputs: {}, ports: state.ports, take: key => { own.add(key); return take(key); }, source, redact });
      const record = { id: serviceId, options, outputs: {} };
      state.services.push(record);
      try {
        await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
        await save();
        ctx.outputs = record.outputs = { ...(definition.setup ? await definition.setup(ctx) : {}) };
        secretValues(ctx.outputs).forEach(value => secrets.add(value));
        const env = variables(definition.env(ctx), `${serviceId} env`);
        const containers = definition.containers?.(ctx) ?? [];
        for (const container of containers) for (const name of Object.keys(container.ports ?? {})) ctx.port(name);
        [env, ...containers.map(container => container.env)].flatMap(secretValues).forEach(value => secrets.add(value));
        resolved[serviceId] = { ...base, status: 'ready', env, containers };
      } catch (error) { throw new Error(`${definition.title}: ${redact(error.message)}`); }
      finally { await save(); }
      for (const ref of addresses) if (ref.addressOf === serviceId && !own.has(addressKey(ref))) fail(`${ref.where} references ${addressText(ref)}, but ${definition.title} has no port ${ref.port}.`);
    }

    const result = composeTwin({ project: twin.project, owner: twin.owner, environment: id, source, config, appImage,
      services: Object.keys(config.services).map(serviceId => resolved[serviceId]), ports: state.ports });
    await writePrivate(twin.env, formatEnv(result.env));
    await writePrivate(twin.compose, YAML.stringify(result.compose, { aliasDuplicateObjects: false }));
    await save();
    // The shared package cache outlives every twin; creating it again is a no-op.
    if (result.compose.volumes?.[PACKAGE_CACHE] || config.fixtures.some(fixture => fixture.command)) await docker(['volume', 'create', '--label', 'perpetual.shared=package-cache', PACKAGE_CACHE], { redact });
    // Repository code runs from the twin's workspace volume, filled once from the snapshot before anything uses it.
    const workspace = Boolean(result.compose.services[SOURCE]);
    if (workspace) {
      await onStep('Loading source');
      await docker(composeArgs(twin, '--progress', 'quiet', '--profile', SOURCE, 'run', '--rm', '--no-TTY', SOURCE), { redact });
    }
    // Service containers that run repository code, like apps, wait for the install; the others start first.
    const names = Object.keys(result.compose.services).filter(name => name !== INSTALL && name !== SOURCE);
    const serviceNames = names.filter(name => !Object.hasOwn(config.apps, name) && !result.workspace.includes(name));
    const fixtures = config.fixtures.filter(fixture => resolved[fixture.service].status === 'ready');
    const withAccounts = state.services.filter(record => services[record.id].accounts);
    if ((fixtures.length || config.install || withAccounts.length) && serviceNames.length) {
      await onStep('Starting services');
      await docker(composeArgs(twin, 'up', '--wait', ...serviceNames), { redact });
    }
    // Test accounts, once their services run and before fixtures, which may give them data. Their
    // passwords stay in this private state and are redacted like every other secret.
    state.accounts = [];
    if (withAccounts.length) await onStep('Creating test accounts');
    for (const record of withAccounts) {
      const definition = services[record.id];
      const ctx = context(twin, { service: record.id, options: record.options, inputs: inputs[record.id] ?? {}, outputs: record.outputs, ports: state.ports, take, source, redact });
      try {
        for (const account of testAccounts(await definition.accounts(ctx), `${record.id} accounts`)) {
          secrets.add(account.password);
          if (state.accounts.some(item => item.id === account.id)) fail(`Test account "${account.id}" is defined twice.`);
          state.accounts.push({ service: record.id, ...account });
        }
      } catch (error) { throw new Error(`${definition.title}: ${redact(error.message)}`); }
      finally { await save(); }
    }
    // Command fixtures, such as seed scripts, run with the workspace dependencies the install provides.
    if (config.install) {
      const { directory, command } = config.install;
      await onStep('Installing dependencies');
      try { await exec('docker', composeArgs(twin, '--progress', 'quiet', '--profile', INSTALL, 'run', '--rm', '--no-TTY', INSTALL)); }
      catch (error) {
        // Package managers report on stdout or stderr, so keep the end of both.
        const output = tail(`${error.stdout ?? ''}${error.stderr ?? ''}`) || errorText(error);
        fail(redact(`Install "${command}" in ${directory} failed${Number.isInteger(error.code) ? ` with exit code ${error.code}` : ''}: ${output}`));
      }
    }
    for (const [index, fixture] of fixtures.entries()) {
      await onStep(`Loading fixture ${index + 1} of ${fixtures.length}`);
      await loadFixture(twin, fixture, resolved[fixture.service].env, source, redact, workspace);
    }
    if (names.length) {
      await onStep('Starting twin');
      await docker(composeArgs(twin, 'up', '--wait'), { redact });
    }
    // Accounts go out without their passwords; account() reads one for a run.
    const accounts = state.accounts.map(({ id: accountId, label, username }) => ({ id: accountId, label, username }));
    return { status: result.services.some(service => service.status === 'blocked') ? 'blocked' : 'ready', services: result.services, apps: result.apps, ...(accounts.length ? { accounts } : {}) };
  }

  /** One test account's username, password and sign-in endpoints, for the controller's own runs; null when the twin has no such account. */
  async function account({ dataDir, id, accountId }) {
    const found = (await readJson(locate(dataDir, id).state))?.accounts?.find(item => item.id === accountId);
    return found ? { username: found.username, password: found.password, authEndpoints: found.authEndpoints ?? [] } : null;
  }

  async function health({ dataDir, id }) {
    const twin = locate(dataDir, id);
    if (!await exists(twin.compose)) return { status: 'stopped', containers: [] };
    const state = await readJson(twin.state);
    const { stdout } = await docker(composeArgs(twin, 'ps', '--all', '--format', 'json'), { redact: redactor(state?.secrets ?? []) });
    const containers = parsePs(stdout).map(item => ({ name: item.Service, state: item.State, health: item.Health || null, exitCode: item.ExitCode ?? null }));
    return { status: overall(containers), containers };
  }

  async function logs({ dataDir, id, service, tail = 200 }) {
    const twin = locate(dataDir, id);
    if (!Number.isInteger(tail) || tail < 1) fail('tail must be a positive whole number.');
    if (service != null && !ID.test(service)) fail('Choose a service or app of this twin.');
    if (!await exists(twin.compose)) return '';
    const redact = redactor((await readJson(twin.state))?.secrets ?? []);
    const { stdout = '', stderr = '' } = await docker(composeArgs(twin, 'logs', '--no-color', '--tail', String(tail), ...(service ? [service] : [])), { redact });
    return redact(`${stdout}${stderr}`);
  }

  /** Compose down --volumes, then each service's teardown in reverse setup order. Failures keep the files. */
  async function destroy({ dataDir, id, inputs = {} }) {
    const twin = locate(dataDir, id);
    const state = await readJson(twin.state);
    const redact = redactor(state?.secrets ?? []), failures = [];
    if (await exists(twin.compose)) {
      try { await docker(composeArgs(twin, 'down', '--volumes', '--remove-orphans'), { redact }); }
      catch (error) { failures.push(`Compose: ${error.message}`); }
    }
    for (const record of [...(state?.services ?? [])].reverse()) {
      const definition = services[record.id];
      if (!definition?.teardown) continue;
      const take = key => state.ports[key] ?? fail(`No host port was allocated for ${key}.`);
      const ctx = context(twin, { service: record.id, options: record.options, inputs: inputs[record.id] ?? {}, outputs: record.outputs ?? {}, ports: state.ports, take, source: state.source, redact });
      try { await definition.teardown(ctx); }
      catch (error) { failures.push(`${definition.title}: ${redact(error.message)}`); }
    }
    if (failures.length) fail(`Twin cleanup failed; its files are kept for another attempt. ${failures.join(' ')}`);
    await rm(twin.dir, { recursive: true, force: true });
    return { status: 'destroyed' };
  }

  return { prepare, health, logs, destroy, account };
}
