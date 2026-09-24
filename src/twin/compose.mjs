import { posix } from 'node:path';
import { APPS, INSTALL, VARIABLE, fail, placeholders, resolvePlaceholders } from './config.mjs';
import { relative } from './paths.mjs';

// Pure: resolved services + apps + allocated host ports -> compose.yaml object and .env map.
// Every environment value lives in .env; compose.yaml only references it, so it holds no secret.

export const HOST = 'host.docker.internal';
export const HOST_GATEWAY = `${HOST}:host-gateway`;
export const LOOPBACK = '127.0.0.1';
export const APP_IMAGE = 'node:22-bookworm-slim';
export const WORKSPACE = '/workspace';
export const LABELS = { owner: 'perpetual.owner', environment: 'perpetual.environment' };
const PACKAGE_MANAGERS = 'corepack enable';
/** One machine-wide volume Perpetual owns, where package managers keep downloads, so a rebuilt twin installs from cache. */
export const PACKAGE_CACHE = 'perpetual-package-cache';
const CACHE = '/perpetual-cache';
// Each manager's documented cache location. pnpm needs its store named: on another filesystem than the
// project it would otherwise make one at the project's root, inside the workspace.
export const PACKAGE_CACHE_ENV = { COREPACK_HOME: `${CACHE}/corepack`, npm_config_cache: `${CACHE}/npm`, npm_config_store_dir: `${CACHE}/pnpm-store`, XDG_CACHE_HOME: `${CACHE}/xdg-cache`, YARN_CACHE_FOLDER: `${CACHE}/yarn`, BUN_INSTALL_CACHE_DIR: `${CACHE}/bun` };
/** The one-shot service that copies the source snapshot into the twin's workspace volume. */
export const SOURCE = 'source';
/** The twin's own volume holding its source, dependencies and build output; removed with the twin. */
export const WORKSPACE_VOLUME = 'workspace';
export const PACKAGE_CACHE_MOUNT = `${PACKAGE_CACHE}:${CACHE}`;
const PORT_VARIABLE = 'PORT';
const SERVICE_HEALTH = { interval: '2s', timeout: '5s', retries: 90 };
const APP_HEALTH = { interval: '5s', timeout: '5s', retries: 3, start_period: '30m' };

export const portKey = (owner, name) => `${owner}.${name}`;
/** The host port a URL placeholder names, an app's or a service's named port; null for a variable placeholder. */
export const addressKey = ref => ref.app ? portKey(APPS, ref.app) : ref.addressOf ? portKey(ref.addressOf, ref.port) : null;
export const hostUrl = (port, path = '') => `http://${HOST}:${port}${path}`;
/** Shell command run in the app image, with the repository's package manager available. */
export const appCommand = (...steps) => [PACKAGE_MANAGERS, ...steps].filter(Boolean).join(' && ');
const literal = value => String(value).replaceAll('$', () => '$$');
const containerName = (service, name) => name === service ? service : `${service}-${name}`;

/** Env map from a service or setup result: drops empty values, checks names. */
export function variables(input, where) {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value != null).map(([name, value]) => {
    if (!VARIABLE.test(name)) fail(`${where} returned an invalid variable name ${name}.`);
    return [name, String(value)];
  }));
}

/** .env text: double-quoted with escapes, so no value is interpolated by Compose. */
export const formatEnv = env => Object.entries(env).map(([key, value]) =>
  `${key}="${String(value).replace(/[\\"$]/g, '\\$&').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"\n`).join('');

function environment(name, values, dotenv) {
  const prefix = name.toUpperCase().replaceAll('-', '_');
  return Object.fromEntries(Object.entries(values).map(([variable, value]) => {
    const key = `${prefix}__${variable}`;
    dotenv[key] = value;
    return [variable, `\${${key}}`];
  }));
}

function healthcheck(container, where) {
  const { http, command } = container.health ?? {};
  if (http) {
    const port = typeof http.port === 'number' ? http.port : container.ports?.[http.port] ?? fail(`${where} health names an unknown port ${http.port}.`);
    const url = `http://${LOOPBACK}:${port}${http.path ?? '/'}`;
    return { test: ['CMD-SHELL', literal(`wget -q -O /dev/null ${url} || curl -fsS -o /dev/null ${url}`)], ...SERVICE_HEALTH };
  }
  if (command) return { test: Array.isArray(command) ? ['CMD', ...command.map(literal)] : ['CMD-SHELL', literal(command)], ...SERVICE_HEALTH };
  return null;
}

/**
 * services: [{ id, fidelity, status: 'ready'|'blocked', missing?, env?, containers? }], in config order.
 * A container is { name, image, command?, env?, ports?: { name: containerPort }, health?, directory? };
 * `directory` runs it in that snapshot directory, like an app; `workspace` lists those containers, which need the install first.
 * ports: { '<service>.<port name>' | 'apps.<id>': hostPort }. source: absolute snapshot path.
 */
export function composeTwin({ project, owner, environment: id, source, config, services, ports, appImage = APP_IMAGE }) {
  const dotenv = {}, compose = { name: project, services: {} }, dependsOn = {}, inWorkspace = [];
  const common = { extra_hosts: [HOST_GATEWAY], labels: { [LABELS.owner]: owner, [LABELS.environment]: id } };
  const hostPort = key => ports[key] ?? fail(`No host port was allocated for ${key}.`);
  // Repository code runs from a Docker volume, not a host bind mount: installs and builds write many small files,
  // which a host mount makes several times slower on Docker Desktop.
  const workspace = directory => ({ working_dir: posix.join(WORKSPACE, directory), volumes: [{ type: 'volume', source: WORKSPACE_VOLUME, target: WORKSPACE }, { type: 'volume', source: PACKAGE_CACHE, target: CACHE }] });
  const ready = services.filter(service => service.status === 'ready');
  const blocked = new Set(services.filter(service => service.status !== 'ready').map(service => service.id));
  const provided = Object.fromEntries(ready.map(service => [service.id, service.env ?? {}]));

  for (const service of ready) for (const container of service.containers ?? []) {
    const name = containerName(service.id, container.name), where = `${service.id} container ${container.name}`;
    const health = healthcheck(container, where);
    compose.services[name] = {
      image: container.image,
      ...(container.command == null ? {} : { command: Array.isArray(container.command) ? container.command.map(literal) : literal(container.command) }),
      environment: { ...(container.directory == null ? {} : PACKAGE_CACHE_ENV), ...environment(name, variables(container.env, where), dotenv) },
      ports: Object.entries(container.ports ?? {}).map(([port, target]) => `${LOOPBACK}:${hostPort(portKey(service.id, port))}:${target}`),
      ...(container.directory == null ? {} : workspace(relative(container.directory, `${where} directory`))),
      ...common, ...(health ? { healthcheck: health } : {}),
    };
    dependsOn[name] = { condition: health ? 'service_healthy' : 'service_started' };
    if (container.directory != null) inWorkspace.push(name);
  }

  // A one-shot service under a profile of its own name, so a plain `up` never starts it; the runtime runs it once.
  if (config.install) {
    if (compose.services[INSTALL]) fail(`A service container is named ${INSTALL}, which the install step uses.`);
    compose.services[INSTALL] = { image: appImage, ...workspace(config.install.directory), command: ['sh', '-c', literal(appCommand(config.install.command))], environment: { ...PACKAGE_CACHE_ENV }, profiles: [INSTALL], ...common };
  }

  const offered = {};
  for (const service of ready) for (const [variable, value] of Object.entries(provided[service.id])) (offered[variable] ??= new Map()).set(service.id, value);
  const apps = [];
  for (const [appId, app] of Object.entries(config.apps)) {
    if (compose.services[appId]) fail(`App "${appId}" has the same name as a service container; rename the app.`);
    const automatic = {};
    for (const [variable, sources] of Object.entries(offered)) {
      if (Object.hasOwn(app.env, variable)) continue;
      if (new Set(sources.values()).size > 1) fail(`${variable} is provided by ${[...sources.keys()].join(' and ')}; map it in apps.${appId}.env.`);
      automatic[variable] = sources.values().next().value;
    }
    const explicit = {};
    for (const [variable, value] of Object.entries(app.env)) {
      const where = `apps.${appId}.env.${variable}`;
      if (placeholders(value, where).some(ref => blocked.has(ref.service))) continue;
      explicit[variable] = resolvePlaceholders(value, ref => addressKey(ref) ? hostUrl(hostPort(addressKey(ref)))
        : provided[ref.service]?.[ref.variable] ?? fail(`${where}: ${ref.service} does not provide ${ref.variable}.`), where);
    }
    const port = hostPort(portKey(APPS, appId));
    compose.services[appId] = {
      image: appImage,
      ...workspace(app.directory),
      command: ['sh', '-c', literal(appCommand(app.build, app.start))],
      environment: { ...PACKAGE_CACHE_ENV, ...environment(appId, { ...automatic, [PORT_VARIABLE]: String(app.port), ...explicit }, dotenv) },
      ports: [`${LOOPBACK}:${port}:${app.port}`],
      ...common,
      healthcheck: { test: ['CMD', 'node', '-e', `fetch('http://${LOOPBACK}:${app.port}/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`], ...APP_HEALTH },
      ...(Object.keys(dependsOn).length ? { depends_on: { ...dependsOn } } : {}),
    };
    apps.push({ id: appId, url: hostUrl(port) });
  }

  // The workspace volume is the twin's own; the cache is external, so tearing a twin down (down --volumes) keeps it.
  if (Object.values(compose.services).some(service => service.volumes?.some(volume => volume.source === WORKSPACE_VOLUME))) {
    if (compose.services[SOURCE]) fail(`A service container is named ${SOURCE}, which copying the source uses.`);
    compose.services[SOURCE] = { image: appImage, volumes: [{ type: 'bind', source: literal(source), target: '/snapshot', read_only: true }, { type: 'volume', source: WORKSPACE_VOLUME, target: WORKSPACE }],
      command: ['sh', '-c', `cp -a /snapshot/. ${WORKSPACE}/`], profiles: [SOURCE], ...common };
    compose.volumes = { [WORKSPACE_VOLUME]: {}, [PACKAGE_CACHE]: { external: true } };
  }
  const summary = services.map(({ id: serviceId, fidelity, status, missing }) => ({ id: serviceId, fidelity, status, ...(status === 'ready' ? {} : { missing }) }));
  return { compose, env: dotenv, services: summary, apps, workspace: inWorkspace };
}
