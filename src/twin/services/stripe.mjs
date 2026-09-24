import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relative } from '../paths.mjs';

// Official Stripe sandbox: the user's test key, `stripe fixtures`, and `stripe listen` forwarding to the twin.
export const CLI = 'stripe/stripe-cli:v1.51.1';
// Since v1.51.0, `listen --forward-to` requires explicit events and rejects `*`.
export const EVENTS = ['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.created',
  'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed',
  'payment_intent.succeeded', 'payment_intent.payment_failed'];
const FIXTURES = 'fixtures.json';

// The key travels in the environment, never in arguments. `listen` and `--print-secret` share the device
// name so both see the same webhook signing secret.
const cliEnv = ctx => ({ STRIPE_API_KEY: ctx.inputs.secretKey, STRIPE_DEVICE_NAME: ctx.project, STRIPE_CLI_TELEMETRY_OPTOUT: '1' });
const defined = values => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
const parseEnv = text => Object.fromEntries(text.split('\n').map(line => line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
  .filter(Boolean).map(([, key, value]) => [key, value.startsWith('"') ? JSON.parse(value) : value]));

// `stripe fixtures` exports ids only through the file's top-level `env` map, which it merges into an
// existing ./.env in its working directory (ctx.run works in ctx.dir).
async function fixtures(ctx) {
  const env = join(ctx.dir, '.env');
  await copyFile(join(ctx.source, relative(ctx.options.fixtures, 'stripe fixtures')), join(ctx.dir, FIXTURES));
  await writeFile(env, '', { mode: 0o600 });
  await ctx.run(CLI, ['fixtures', FIXTURES], { env: cliEnv(ctx) });
  return parseEnv(await readFile(env, 'utf8'));
}

async function webhookSecret(ctx) {
  const { stdout } = await ctx.run(CLI, ['listen', '--print-secret'], { env: cliEnv(ctx) });
  const secret = stdout.match(/\bwhsec_\w+/)?.[0];
  if (!secret) throw new Error('Stripe CLI did not print a webhook signing secret');
  return secret;
}

export default {
  id: 'stripe', title: 'Stripe', fidelity: 'official-sandbox',
  detect: { packages: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'], env: [/^STRIPE_/] },
  inputs: [
    { name: 'secretKey', label: 'Stripe test secret key', secret: true, pattern: /^(sk|rk)_test_/ },
    { name: 'publishableKey', label: 'Stripe test publishable key', pattern: /^pk_test_/, optional: true },
  ],
  // Settings the Stripe API cannot make; the user saves them once in the sandbox's Dashboard.
  checklist: [
    { id: 'customer-portal', title: 'Default customer portal configuration', url: 'https://dashboard.stripe.com/test/settings/billing/portal' },
  ],
  setup: async ctx => defined({
    fixtures: ctx.options.fixtures ? await fixtures(ctx) : {},
    webhookSecret: ctx.options.webhook ? await webhookSecret(ctx) : undefined,
  }),
  containers: ctx => ctx.options.webhook ? [{
    name: 'listen', image: CLI, env: cliEnv(ctx),
    command: ['listen', '--skip-update', '--events', (ctx.options.events ?? EVENTS).join(','), '--forward-to', ctx.options.webhook],
  }] : [],
  env: ({ inputs, outputs }) => defined({
    ...outputs.fixtures,
    STRIPE_SECRET_KEY: inputs.secretKey, STRIPE_WEBHOOK_SECRET: outputs.webhookSecret, STRIPE_PUBLISHABLE_KEY: inputs.publishableKey,
  }),
};
