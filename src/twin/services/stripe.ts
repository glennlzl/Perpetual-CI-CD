import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../config.ts';
import { optionText } from '../options.ts';
import { relative } from '../paths.ts';
import type { ServiceContext, ServiceProvision, TwinService } from '../registry.ts';

// Official Stripe sandbox: a test key (the user's own, or a claimable sandbox Perpetual creates on request),
// `stripe fixtures`, and `stripe listen` forwarding to the twin.
export const CLI = 'stripe/stripe-cli:v1.51.1';
// Since v1.51.0, `listen --forward-to` requires explicit events and rejects `*`.
export const EVENTS = ['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.created',
  'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed',
  'payment_intent.succeeded', 'payment_intent.payment_failed'];
const FIXTURES = 'fixtures.json';
/** Test secret keys: standard, restricted, and a claimable sandbox's restricted key. */
const SECRET_KEY = /^(sk|rk|rkcs)_test_/;
const SANDBOX = { publishable_key: /^pk_test_/, expires_at: /^\d{4}-\d{2}-\d{2}$/, claim_url: /^https:\/\/dashboard\.stripe\.com\//, account_id: /^acct_/ };
/** x@y.z; never a leading `-`, which the CLI could read as a flag. */
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/;
const SANDBOX_TIMEOUT = 90_000;
/** The only error sandbox creation reports: the CLI's output carries keys, so none of it is ever shown. */
export const SANDBOX_FAILED = 'Stripe could not create a sandbox. Try again later, or enter test keys.';
const fail: (message: string) => never = message => { throw new Error(message); };

/** fixtures: a `stripe fixtures` file in the repository; webhook: the URL `stripe listen` forwards to, and its events. */
type Options = { fixtures?: Json; webhook?: Json; events?: Json };
type Outputs = { fixtures: Record<string, string>; webhookSecret?: string };
type Context = ServiceContext<Options, Outputs>;

// The key travels in the environment, never in arguments. `listen` and `--print-secret` share the device
// name so both see the same webhook signing secret.
const cliEnv = (ctx: Pick<Context, 'inputs' | 'project'>) => ({ STRIPE_API_KEY: ctx.inputs.secretKey, STRIPE_DEVICE_NAME: ctx.project, STRIPE_CLI_TELEMETRY_OPTOUT: '1' });
/** T without its undefined values: a key that may hold undefined becomes optional. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };
const defined = <T extends object>(values: T) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Defined<T>;
const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.split('\n').map(line => line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
  .filter(match => match !== null).map(([, key, value]) => [key, value.startsWith('"') ? String(JSON.parse(value)) : value]));

// `stripe fixtures` exports ids only through the file's top-level `env` map, which it merges into an
// existing ./.env in its working directory (ctx.run works in ctx.dir).
async function fixtures(ctx: Context) {
  const env = join(ctx.dir, '.env');
  await copyFile(join(ctx.source, relative(ctx.options.fixtures, 'stripe fixtures')), join(ctx.dir, FIXTURES));
  await writeFile(env, '', { mode: 0o600 });
  await ctx.run(CLI, ['fixtures', FIXTURES], { env: cliEnv(ctx) });
  return parseEnv(await readFile(env, 'utf8'));
}

/** The first JSON object in a CLI's output, or null. */
function firstObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, string = false, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (string) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') string = false; }
    else if (char === '"') string = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)); } catch { return null; } }
  }
  return null;
}

// `stripe sandbox create` proves work to Stripe and returns a claimable sandbox's keys, valid for 7 days unless
// claimed. It runs against an empty config: with a key already configured it does nothing, and when provisioning
// fails it falls back to a browser login, so anything but the expected JSON object is a failure.
async function createSandbox({ inputs, docker, tempDir }: Parameters<ServiceProvision['run']>[0]) {
  const { email } = inputs;
  if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email)) fail('Email does not have the expected format.');
  let stdout: string | undefined;
  try {
    ({ stdout } = await docker(['run', '--rm', '--env', 'STRIPE_CLI_TELEMETRY_OPTOUT=1', '--volume', `${tempDir}:/cfg`,
      CLI, '--config', '/cfg/config.toml', 'sandbox', 'create', '--email', email, '--non-interactive'], { timeoutMs: SANDBOX_TIMEOUT }));
  } catch { fail(SANDBOX_FAILED); }
  const sandbox = firstObject(String(stdout ?? '')) as Record<string, unknown> | null;
  const text = (name: string) => typeof sandbox?.[name] === 'string' ? sandbox[name] as string : '';
  if (!SECRET_KEY.test(text('secret_key')) || !Object.entries(SANDBOX).every(([name, pattern]) => pattern.test(text(name)))) fail(SANDBOX_FAILED);
  return { values: { secretKey: text('secret_key'), publishableKey: text('publishable_key') },
    details: { expiresAt: text('expires_at'), claimUrl: text('claim_url'), account: text('account_id') } };
}

const webhook = (options: Options) => options.webhook ? optionText(options.webhook, 'stripe.webhook') : undefined;
const events = (options: Options) => {
  const names = options.events ?? EVENTS;
  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === 'string')) throw new Error('stripe.events must list webhook event names.');
  return names;
};

async function webhookSecret(ctx: Context) {
  const { stdout } = await ctx.run(CLI, ['listen', '--print-secret'], { env: cliEnv(ctx) });
  const secret = stdout.match(/\bwhsec_\w+/)?.[0];
  if (!secret) throw new Error('Stripe CLI did not print a webhook signing secret');
  return secret;
}

export default {
  id: 'stripe', title: 'Stripe', fidelity: 'official-sandbox',
  detect: { packages: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'], env: [/^STRIPE_/] },
  inputs: [
    { name: 'secretKey', label: 'Stripe test secret key', secret: true, pattern: SECRET_KEY },
    { name: 'publishableKey', label: 'Stripe test publishable key', pattern: /^pk_test_/, optional: true },
  ],
  // Only on the user's explicit action: the email goes to Stripe, which needs no account or key for it.
  provision: { inputs: [{ name: 'email', label: 'Email', default: 'git-email' }], run: createSandbox },
  // Settings the Stripe API cannot make; the user saves them once in the sandbox's Dashboard.
  checklist: [
    { id: 'customer-portal', title: 'Default customer portal configuration', url: 'https://dashboard.stripe.com/test/settings/billing/portal' },
  ],
  setup: async ctx => defined({
    fixtures: ctx.options.fixtures ? await fixtures(ctx) : {},
    webhookSecret: ctx.options.webhook ? await webhookSecret(ctx) : undefined,
  }),
  containers: ctx => {
    const url = webhook(ctx.options);
    return url ? [{ name: 'listen', image: CLI, env: cliEnv(ctx), command: ['listen', '--skip-update', '--events', events(ctx.options).join(','), '--forward-to', url] }] : [];
  },
  env: ({ inputs, outputs }) => defined({
    ...outputs.fixtures,
    STRIPE_SECRET_KEY: inputs.secretKey, STRIPE_WEBHOOK_SECRET: outputs.webhookSecret, STRIPE_PUBLISHABLE_KEY: inputs.publishableKey,
  }),
} satisfies TwinService<Options, Outputs>;
