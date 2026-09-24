import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';

// Official local Trigger.dev: one self-hosted webapp stack per machine (Compose project `perpetual-trigger`),
// one Trigger project per twin, and a per-twin `trigger dev` worker that runs the repository's tasks.
// Deploy-only parts of the official stack (registry, supervisor, Docker socket proxy) are left out.
export const VERSION = '4.6.4';
export const PROJECT = 'perpetual-trigger';
export const BOT_EMAIL = 'trigger@perpetual.localhost'; // the only address the instance accepts
const ORG = 'Perpetual';
const IMAGES = { webapp: `ghcr.io/triggerdotdev/trigger.dev:v${VERSION}`, postgres: 'postgres:14', redis: 'redis:7', clickhouse: 'clickhouse/clickhouse-server:26.2' };
const SECRETS = ['SESSION_SECRET', 'MAGIC_LINK_SECRET', 'ENCRYPTION_KEY', 'PROVIDER_SECRET', 'COORDINATOR_SECRET', 'MANAGED_WORKER_SECRET', 'POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD'];
const HEALTH = "http.get('http://localhost:3000/healthcheck', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))";
const LOG_ATTEMPTS = 30;
const FIRST_BOOT = '15m';
/** The CLI must match the repository's SDK exactly. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// The CLI is installed once per version into a local image layer, so a worker start or restart never downloads it.
// The tag carries the recipe's hash, so a changed recipe builds a new image.
const CLI_RECIPE = 'FROM node:22-bookworm-slim\nARG VERSION\nRUN npm install --global "trigger.dev@$VERSION" && npm cache clean --force\n';
export const cliImage = version => `perpetual-trigger-cli:${version}-${createHash('sha256').update(CLI_RECIPE).digest('hex').slice(0, 12)}`;

// `trigger dev` signs in only with a personal access token, never a project key, and hands its whole environment
// to every task process. The machine-wide bot token therefore reaches the CLI as its login profile: written 0600
// when the worker starts and removed from the environment before the CLI runs. Tasks get the project's dev key,
// which the CLI adds itself.
export const CREDENTIALS = 'PERPETUAL_TRIGGER_CREDENTIALS';
export const LOGIN = [
  'config="${XDG_CONFIG_HOME:-$HOME/.config}/trigger"',
  `(umask 077 && mkdir -p "$config" && printf %s "$${CREDENTIALS}" > "$config/config.json")`,
  `unset ${CREDENTIALS}`,
  'exec trigger dev "$@"',
].join(' && ');
const profile = ({ apiUrl, accessToken }) => JSON.stringify({ version: 2, currentProfile: 'default', profiles: { default: { accessToken, apiUrl } } });

const home = ctx => ctx.shared;
const compose = (ctx, ...args) => ctx.exec('docker', ['compose', '--project-name', PROJECT, '--project-directory', home(ctx), ...args]);
const request = (ctx, url, init) => (ctx.fetch ?? fetch)(url, init);
const origin = port => `http://localhost:${port}`;
const projectName = ctx => ctx.project;
const cliVersion = options => options.version ?? VERSION;
const absent = fallback => error => { if (error.code === 'ENOENT') return fallback; throw error; };
const json = async response => {
  if (!response.ok) throw new Error(`Trigger.dev responded ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
};
const api = (ctx, state) => async (method, path, body) => json(await request(ctx, origin(state.port) + path, {
  method, headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}));

// The webapp's environment. Humans use localhost; containers reach the same port via host.docker.internal,
// including the URLs the server hands back to `trigger dev`.
export function webappEnv(port, secrets) {
  const inside = `http://host.docker.internal:${port}`, db = `postgresql://postgres:${secrets.POSTGRES_PASSWORD}@postgres:5432/main?schema=public&sslmode=disable`;
  const clickhouse = `http://default:${secrets.CLICKHOUSE_PASSWORD}@clickhouse:8123`;
  return {
    ...secrets, APP_ORIGIN: origin(port), LOGIN_ORIGIN: origin(port), API_ORIGIN: inside, DEV_ENGINE_URL: inside,
    DEV_OTEL_EXPORTER_OTLP_ENDPOINT: `${inside}/otel`, DATABASE_URL: db, DIRECT_URL: db,
    REDIS_HOST: 'redis', REDIS_PORT: '6379', REDIS_TLS_DISABLED: 'true',
    CLICKHOUSE_URL: `${clickhouse}?secure=false`, RUN_REPLICATION_CLICKHOUSE_URL: clickhouse, RUN_REPLICATION_ENABLED: '1',
    DEPLOY_REGISTRY_HOST: 'localhost:5000', // required by the webapp; deploys are not used
    REALTIME_STREAMS_DEFAULT_VERSION: 'v1', TRIGGER_TELEMETRY_DISABLED: '1', POSTHOG_PROJECT_KEY: '',
    WHITELISTED_EMAILS: `^${BOT_EMAIL.replace(/\./g, '\\.')}$`, ORG_CREATION_API_ENABLED: '1', TRIGGER_BOOTSTRAP_ENABLED: '0',
    NODE_MAX_OLD_SPACE_SIZE: '1536',
  };
}

// The stack's .env: single-quoted, so Compose interpolates nothing. Its secrets are read back on every start.
const formatEnv = env => Object.entries(env).map(([key, value]) => `${key}='${value}'\n`).join('');
const parseEnv = text => Object.fromEntries([...text.matchAll(/^(\w+)='([^'\n]*)'$/gm)].map(([, key, value]) => [key, value]));

export function stack(port) {
  const healthy = Object.fromEntries(['postgres', 'redis', 'clickhouse'].map(name => [name, { condition: 'service_healthy' }]));
  const check = test => ({ test, interval: '5s', timeout: '10s', retries: 60 });
  // The instance outlives any one twin, so it comes back with Docker unless someone stops it.
  const restart = 'unless-stopped';
  return {
    services: {
      // The first boot applies every database and ClickHouse migration before the server listens.
      webapp: { image: IMAGES.webapp, restart, env_file: ['.env'], ports: [`127.0.0.1:${port}:3000`], depends_on: healthy,
        extra_hosts: ['host.docker.internal:host-gateway'], healthcheck: { ...check(['CMD', 'node', '-e', HEALTH]), start_period: FIRST_BOOT } },
      postgres: { image: IMAGES.postgres, restart, command: ['-c', 'wal_level=logical'], environment: { POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}' },
        volumes: ['postgres:/var/lib/postgresql/data'], healthcheck: check(['CMD', 'pg_isready', '-U', 'postgres']) },
      redis: { image: IMAGES.redis, restart, volumes: ['redis:/data'], healthcheck: check(['CMD', 'redis-cli', 'ping']) },
      clickhouse: { image: IMAGES.clickhouse, restart, environment: { CLICKHOUSE_PASSWORD: '${CLICKHOUSE_PASSWORD}', CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' },
        ulimits: { nofile: { soft: 262144, hard: 262144 } }, volumes: ['clickhouse:/var/lib/clickhouse'],
        healthcheck: check(['CMD-SHELL', 'clickhouse-client --password "$$CLICKHOUSE_PASSWORD" --query "SELECT 1"']) },
    },
    volumes: { postgres: {}, redis: {}, clickhouse: {} },
  };
}

// The documented self-hosted sign-in, run once per machine (exercised against a live v4.6.4 webapp).
// Without an email transport the webapp logs the magic link; the CLI's authorization-code flow then
// turns that session into the bot's personal access token.
export async function bootstrapToken(ctx, port) {
  const cookies = new Map();
  const browse = async (path, init = {}) => {
    const response = await request(ctx, origin(port) + path, { ...init, redirect: 'manual',
      headers: { ...init.headers, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  const since = new Date().toISOString();
  await browse('/login/magic', { method: 'POST', body: new URLSearchParams({ action: 'send', email: BOT_EMAIL }) });
  let token;
  for (let attempt = 0; !token && attempt < LOG_ATTEMPTS; attempt += 1) {
    if (attempt) await delay(1000);
    token = [...(await compose(ctx, 'logs', '--no-log-prefix', '--since', since, 'webapp')).stdout.matchAll(/\/magic\?token=([^\s"'<>&]+)/g)].at(-1)?.[1];
  }
  if (!token) throw new Error('Trigger.dev did not log a sign-in link');
  await browse(`/magic?token=${token}`);
  const { authorizationCode } = await json(await request(ctx, `${origin(port)}/api/v1/authorization-code`, { method: 'POST' }));
  // The consent form's action mints the token; it is a form post like the dashboard's.
  await browse(`/account/authorization-code/${authorizationCode}`, { method: 'POST', body: new URLSearchParams() });
  const issued = await json(await request(ctx, `${origin(port)}/api/v1/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorizationCode }) }));
  const minted = typeof issued.token === 'string' ? issued.token : issued.token?.token;
  if (!minted) throw new Error('Trigger.dev did not issue an access token');
  return minted;
}

// Twins set up at the same time share the instance, so it is started, signed in and given its organization one at a time.
let turn = Promise.resolve();
const inTurn = work => { const next = turn.then(work); turn = next.catch(() => {}); return next; };

// Starts or updates the shared instance and returns its state: port, bot token and organization slug.
// The port is reserved machine-wide; secrets are generated once; compose.yaml and .env follow this file on every start.
const instance = ctx => inTurn(async () => {
  const dir = home(ctx), file = join(dir, 'state.json'), envFile = join(dir, '.env');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const state = await readFile(file, 'utf8').then(JSON.parse, () => ({}));
  const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
  state.port = await ctx.sharedPort(PROJECT, state.port);
  const saved = parseEnv(await readFile(envFile, 'utf8').catch(absent('')));
  const secrets = Object.fromEntries(SECRETS.map(name => [name, saved[name] || randomBytes(16).toString('hex')]));
  await writeFile(envFile, formatEnv(webappEnv(state.port, secrets)), { mode: 0o600 });
  await writeFile(join(dir, 'compose.yaml'), stringify(stack(state.port)));
  await save();
  await compose(ctx, 'up', '--detach', '--wait');
  if (!state.token) { state.token = await bootstrapToken(ctx, state.port); await save(); }
  if (!state.org) {
    const call = api(ctx, state), [existing] = await call('GET', '/api/v1/orgs');
    state.org = (existing ?? await call('POST', '/api/v1/orgs', { title: ORG })).slug;
    await save();
  }
  return state;
});

// Builds the pinned CLI image unless this machine already has it.
export async function ensureCli(ctx, version) {
  const image = cliImage(version);
  if (await ctx.exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, () => false)) return;
  const dir = join(home(ctx), 'cli');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'Dockerfile'), CLI_RECIPE);
  await ctx.exec('docker', ['build', '--build-arg', `VERSION=${version}`, '--tag', image, dir]);
}

const findProject = async (ctx, call, org) => (await call('GET', `/api/v1/orgs/${org}/projects`)).find(project => project.name === projectName(ctx));

export default {
  id: 'trigger-dev', title: 'Trigger.dev', fidelity: 'official-sandbox',
  detect: { packages: ['@trigger.dev/sdk', 'trigger.dev'], env: [/^TRIGGER_/] },
  setup: async ctx => {
    const version = cliVersion(ctx.options);
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) throw new Error('version must be an exact trigger.dev CLI version, such as 4.4.4.');
    await ensureCli(ctx, version);
    const state = await instance(ctx), call = api(ctx, state);
    const { externalRef } = await findProject(ctx, call, state.org) ?? await call('POST', `/api/v1/orgs/${state.org}/projects`, { name: projectName(ctx) });
    const { apiKey } = await call('GET', `/api/v1/projects/${externalRef}/dev`);
    return { apiUrl: `http://${ctx.host}:${state.port}`, secretKey: apiKey, projectRef: externalRef, accessToken: state.token };
  },
  // Runs in the repository's task directory, like an app, with the pinned CLI (or the repo's SDK version).
  containers: ({ options, outputs }) => [{
    name: 'trigger-dev', image: cliImage(cliVersion(options)), directory: options.directory ?? '.',
    command: ['sh', '-c', LOGIN, 'trigger', '--project-ref', outputs.projectRef, '--skip-update-check'],
    env: { ...options.env, TRIGGER_API_URL: outputs.apiUrl, [CREDENTIALS]: profile(outputs) },
  }],
  env: ({ outputs }) => ({ TRIGGER_API_URL: outputs.apiUrl, TRIGGER_SECRET_KEY: outputs.secretKey }),
  // Soft-deletes this twin's project; the shared instance keeps running for other twins.
  teardown: async ctx => {
    const state = await readFile(join(home(ctx), 'state.json'), 'utf8').then(JSON.parse, () => ({}));
    if (!state.token || !state.org) return;
    const call = api(ctx, state), project = await findProject(ctx, call, state.org);
    if (project) await call('DELETE', `/api/v1/projects/${project.externalRef}`);
  },
};
