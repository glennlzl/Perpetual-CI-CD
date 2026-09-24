import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supabase, { CLI as SUPABASE_CLI, setToml } from '../src/twin/services/supabase.mjs';
import stripe, { CLI as STRIPE_CLI, EVENTS } from '../src/twin/services/stripe.mjs';
import { detectTwinConfig } from '../src/twin/detect.mjs';

const HOST = 'host.docker.internal';
const SOCKET = /docker\.sock/;

// A service context whose CLI runs return canned output; nothing touches Docker or the network.
const context = async ({ respond = () => '', ...values } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'twin-official-'));
  const ports = new Map(), calls = [];
  const port = name => { if (!ports.has(name)) ports.set(name, 43100 + ports.size); return ports.get(name); };
  const call = async entry => { calls.push(entry); return { stdout: await respond(entry) ?? '' }; };
  return {
    project: 'perpetual-beta1', dir: join(root, 'twin'), source: join(root, 'source'), shared: join(root, 'shared', 'trigger-dev'),
    options: {}, inputs: {}, outputs: {}, host: HOST, port, url: (name, path = '') => `http://${HOST}:${port(name)}${path}`,
    run: (image, args, options) => call({ image, args, options }), exec: (command, args, options) => call({ command, args, options }),
    calls, ...values,
  };
};
const mode = async file => (await stat(file)).mode & 0o777;
const section = (toml, name) => toml.split(/^(?=\[)/m).find(part => part.startsWith(`[${name}]\n`)) ?? '';

const CONFIG = `project_id = "shop-api"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]

[db]
port = 54322
shadow_port = 54320
major_version = 17

[db.migrations]
enabled = false

[inbucket]
enabled = true
port = 54324
`;
const STATUS = [
  'API_URL="http://127.0.0.1:43100"', 'ANON_KEY="anon.jwt"', 'SERVICE_ROLE_KEY="service.jwt"', 'JWT_SECRET="jwt-secret"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:43101/postgres"', '',
].join('\n');
const supabaseSource = async ctx => {
  await mkdir(ctx.dir, { recursive: true });
  const dir = join(ctx.source, 'services/api/supabase');
  await mkdir(join(dir, 'migrations'), { recursive: true }); await mkdir(join(dir, '.temp'), { recursive: true });
  await writeFile(join(dir, 'config.toml'), CONFIG);
  await writeFile(join(dir, 'migrations/0001_init.sql'), 'create table items (id int);');
  await writeFile(join(dir, '.temp/project-ref'), 'remote-project');
  ctx.options = { directory: 'services/api/supabase' };
};

test('Supabase runs the pinned CLI on the host, never in a container with the Docker socket', async () => {
  const ctx = await context({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  ctx.outputs = await supabase.setup(ctx);
  const workdir = join(ctx.dir, 'supabase');
  assert.deepEqual(ctx.calls.map(({ command, args }) => [command, ...args]), [
    ['npx', '--yes', SUPABASE_CLI, 'stop', '--no-backup', '--project-id', 'perpetual-beta1'],
    ['npx', '--yes', SUPABASE_CLI, 'start', '--workdir', workdir],
    ['npx', '--yes', SUPABASE_CLI, 'status', '--output', 'env', '--workdir', workdir],
  ]);
  assert.match(SUPABASE_CLI, /^supabase@\d+\.\d+\.\d+$/);
  assert.ok(ctx.calls.every(({ image, args }) => !image && !args.some(arg => SOCKET.test(arg))));
  assert.deepEqual(supabase.containers(ctx), []);
});

test('Supabase copies the project with twin ports, id and a host.docker.internal issuer', async () => {
  const ctx = await context({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await supabase.setup(ctx);
  const target = join(ctx.dir, 'supabase/supabase'), config = await readFile(join(target, 'config.toml'), 'utf8');
  assert.match(config, /^project_id = "perpetual-beta1"$/m);
  // The CLI health-checks its stack from the host through api.external_url, where host.docker.internal does not
  // resolve, so only the token issuer takes the address containers verify against.
  assert.doesNotMatch(section(config, 'api'), /^external_url =/m);
  assert.match(section(config, 'auth'), new RegExp(`^jwt_issuer = "http://${HOST}:${ctx.port('api')}/auth/v1"$`, 'm'));
  for (const [name, key, port] of [['api', 'port', 'api'], ['db', 'port', 'db'], ['db', 'shadow_port', 'shadow'], ['inbucket', 'port', 'mail'],
    ['db.pooler', 'port', 'pooler'], ['studio', 'port', 'studio'], ['analytics', 'port', 'analytics'], ['edge_runtime', 'inspector_port', 'inspector']]) {
    assert.match(section(config, name), new RegExp(`^${key} = ${ctx.port(port)}$`, 'm'), `${name}.${key}`);
  }
  assert.doesNotMatch(config, /5432\d|shop-api|\[local_smtp\]/);
  assert.match(config, /schemas = \["public", "graphql_public"\]/);
  assert.equal(await readFile(join(target, 'migrations/0001_init.sql'), 'utf8'), 'create table items (id int);');
  await assert.rejects(stat(join(target, '.temp')));
});

test('Supabase provides its standard variables from supabase status', async () => {
  const ctx = await context({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  ctx.outputs = await supabase.setup(ctx);
  const url = `http://${HOST}:${ctx.port('api')}`;
  assert.deepEqual(supabase.env(ctx), {
    SUPABASE_URL: url, SUPABASE_ANON_KEY: 'anon.jwt', SUPABASE_SERVICE_ROLE_KEY: 'service.jwt', SUPABASE_JWT_SECRET: 'jwt-secret',
    // The CLI fixes the local password; the URL carries what status reports.
    DATABASE_URL: `postgresql://postgres:postgres@${HOST}:${ctx.port('db')}/postgres?sslmode=disable`,
    NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon.jwt',
  });
});

test('Supabase setup fails when status reports no keys', async () => {
  const ctx = await context({ respond: ({ args }) => args.includes('status') ? 'API_URL="http://127.0.0.1:1"\n' : '' });
  await supabaseSource(ctx);
  await assert.rejects(supabase.setup(ctx), /did not report its keys/);
});

test('Supabase is detected from its config.toml, which gives its directory', () => {
  assert.deepEqual(detectTwinConfig({ files: ['backend/api/supabase/config.toml'] }).services, { supabase: { directory: 'backend/api/supabase' } });
});

test('Supabase supersedes PostgreSQL, which its local stack includes', () => {
  const postgresEvidence = { packages: ['pg', 'postgres'], env: ['POSTGRES_HOST', 'PGUSER'] };
  assert.deepEqual(detectTwinConfig({ ...postgresEvidence, packages: [...postgresEvidence.packages, '@supabase/supabase-js'] }).services, { supabase: {} });
  assert.deepEqual(detectTwinConfig(postgresEvidence).services, { postgres: {} });
});

test('Supabase teardown stops the twin project without a backup', async () => {
  const ctx = await context();
  await supabase.teardown(ctx);
  assert.deepEqual(ctx.calls.map(({ command, args }) => [command, ...args]),
    [['npx', '--yes', SUPABASE_CLI, 'stop', '--no-backup', '--project-id', 'perpetual-beta1']]);
});

test('A long twin project gets a Supabase project id the CLI keeps whole, used by start and stop alike', async () => {
  // The CLI cuts project ids to 40 characters and `stop --project-id` matches the cut id, so a longer id would leak the stack.
  const project = 'perpetual-0a24d90e-fa7c-4399-88ad-48d9a2836afa', other = 'perpetual-0a24d90e-fa7c-4399-88ad-48d9a2836afb';
  const ctx = await context({ project, respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await supabase.setup(ctx);
  const id = (await readFile(join(ctx.dir, 'supabase/supabase/config.toml'), 'utf8')).match(/^project_id = "([^"]+)"$/m)[1];
  assert.ok(id.length <= 40, id);
  assert.match(id, /^perpetual-0a24d90e-/);
  const stops = [...ctx.calls];
  const fresh = await context({ project });
  await supabase.teardown(fresh);
  for (const call of [stops[0], fresh.calls[0]]) assert.deepEqual(call.args.slice(-3), ['--no-backup', '--project-id', id]);
  const sibling = await context({ project: other });
  await supabase.teardown(sibling);
  assert.notEqual(sibling.calls[0].args.at(-1), id, 'twins that share a long prefix keep separate stacks');
});

test('TOML rewrite adds missing keys and sections and uses [local_smtp] for current configs', async () => {
  assert.equal(setToml('[api]\nport = 1\n', '', 'project_id', 'x'), 'project_id = "x"\n[api]\nport = 1\n');
  assert.equal(setToml('[api]\nenabled = true\n\n[db]\nport = 2\n', 'api', 'port', 3), '[api]\nenabled = true\nport = 3\n\n[db]\nport = 2\n');
  assert.equal(setToml('[api] # gateway\nport = 1\n', 'api', 'port', 5), '[api] # gateway\nport = 5\n');
  assert.equal(setToml('[db]\nport = 2\n', 'db.pooler', 'port', 4), '[db]\nport = 2\n\n[db.pooler]\nport = 4\n');
  const ctx = await context({ respond: ({ args }) => args.includes('status') ? STATUS : '' });
  await supabaseSource(ctx);
  await writeFile(join(ctx.source, ctx.options.directory, 'config.toml'), '[api]\nport = 54321\n');
  await supabase.setup(ctx);
  assert.match(await readFile(join(ctx.dir, 'supabase/supabase/config.toml'), 'utf8'), new RegExp(`\\[local_smtp\\]\\nport = ${ctx.port('mail')}\\nsmtp_port = ${ctx.port('smtp')}\\n`));
});

test('Stripe accepts only test keys', () => {
  const [secret, publishable] = stripe.inputs;
  assert.deepEqual({ name: secret.name, secret: secret.secret }, { name: 'secretKey', secret: true });
  for (const key of ['sk_test_123', 'rk_test_123']) assert.ok(secret.pattern.test(key), key);
  for (const key of ['sk_live_123', 'rk_live_123', 'pk_test_123', 'whsec_123', ' sk_test_123']) assert.ok(!secret.pattern.test(key), key);
  assert.ok(publishable.optional && publishable.pattern.test('pk_test_1') && !publishable.pattern.test('pk_live_1'));
});

test('Stripe setup runs fixtures and prints the webhook secret through the pinned CLI image', async () => {
  let ctx;
  const respond = async ({ args }) => {
    if (args[0] === 'fixtures') await writeFile(join(ctx.dir, '.env'), 'STRIPE_PRICE_PRO_MONTHLY="price_month"\nSTRIPE_PRODUCT_PRO="prod_pro"\n');
    return args.includes('--print-secret') ? 'whsec_abc123\n' : '';
  };
  ctx = await context({ respond, inputs: { secretKey: 'sk_test_key' }, options: { fixtures: 'billing/stripe.json', webhook: 'http://host.docker.internal:43150/stripe/webhook' } });
  await mkdir(join(ctx.source, 'billing'), { recursive: true }); await mkdir(ctx.dir, { recursive: true });
  await writeFile(join(ctx.source, 'billing/stripe.json'), '{"_meta":{"template_version":0},"fixtures":[]}');
  ctx.outputs = await stripe.setup(ctx);
  const env = { STRIPE_API_KEY: 'sk_test_key', STRIPE_DEVICE_NAME: 'perpetual-beta1', STRIPE_CLI_TELEMETRY_OPTOUT: '1' };
  const dir = ctx.dir;
  assert.deepEqual(ctx.calls, [
    { image: STRIPE_CLI, args: ['fixtures', 'fixtures.json'], options: { env } },
    { image: STRIPE_CLI, args: ['listen', '--print-secret'], options: { env } },
  ]);
  assert.match(STRIPE_CLI, /^stripe\/stripe-cli:v\d+\.\d+\.\d+$/);
  assert.ok(ctx.calls.every(({ args }) => !args.some(arg => /sk_test/.test(arg))));
  assert.equal(await readFile(join(dir, 'fixtures.json'), 'utf8'), '{"_meta":{"template_version":0},"fixtures":[]}');
  assert.equal(await mode(join(dir, '.env')), 0o600);
  assert.deepEqual(stripe.env(ctx), {
    STRIPE_PRICE_PRO_MONTHLY: 'price_month', STRIPE_PRODUCT_PRO: 'prod_pro', STRIPE_SECRET_KEY: 'sk_test_key', STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
  });
  ctx.inputs.publishableKey = 'pk_test_pub';
  assert.equal(stripe.env(ctx).STRIPE_PUBLISHABLE_KEY, 'pk_test_pub');
});

test('Stripe listen forwards explicit events to the configured webhook', async () => {
  const ctx = await context({ inputs: { secretKey: 'rk_test_key' }, options: { webhook: 'http://host.docker.internal:43150/hooks/stripe' } });
  const [listen] = stripe.containers(ctx);
  assert.equal(listen.image, STRIPE_CLI);
  assert.deepEqual(listen.command, ['listen', '--skip-update', '--events', EVENTS.join(','), '--forward-to', 'http://host.docker.internal:43150/hooks/stripe']);
  assert.equal(listen.env.STRIPE_API_KEY, 'rk_test_key');
  assert.ok(!EVENTS.includes('*'));
  ctx.options.events = ['invoice.paid'];
  assert.deepEqual(stripe.containers(ctx)[0].command.slice(2, 4), ['--events', 'invoice.paid']);
  assert.deepEqual(stripe.containers(await context({ inputs: { secretKey: 'sk_test_key' } })), []);
});

test('Stripe without a webhook or fixtures only provides the key', async () => {
  const ctx = await context({ inputs: { secretKey: 'sk_test_key' } });
  ctx.outputs = await stripe.setup(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(stripe.env(ctx), { STRIPE_SECRET_KEY: 'sk_test_key' });
});

test('Stripe setup fails when the CLI prints no signing secret', async () => {
  const ctx = await context({ respond: () => 'Your API key is invalid', inputs: { secretKey: 'sk_test_key' }, options: { webhook: 'http://host.docker.internal:1/w' } });
  await assert.rejects(stripe.setup(ctx), /webhook signing secret/);
});

test('Stripe lists the Dashboard-only settings with links', () => {
  assert.ok(stripe.checklist.length);
  for (const item of stripe.checklist) {
    assert.ok(item.id && item.title);
    assert.match(item.url, /^https:\/\/dashboard\.stripe\.com\/test\//);
  }
});
