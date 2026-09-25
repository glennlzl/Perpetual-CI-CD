import type { Json } from '../config.ts';
import { optionObjects } from '../options.ts';
import type { Pattern, TwinService } from '../registry.ts';

// vercel-labs/emulate publishes no image; its CLI runs from npm on a pinned Node image.
const PACKAGE = 'emulate@0.11.2';
const IMAGE = 'node:22.23.3-bookworm-slim';
const BASE_PORT = 4000;
const SEED = 'EMULATE_SEED'; // the seed travels in the environment and is written inside the container
const SEED_FILE = '/tmp/emulate-seed.json';

// Vendors with no official simulation or test mode, and how a repository shows it uses them.
export const emulated: Record<string, { packages: string[]; env: Pattern[] }> = {
  github: { packages: ['octokit', '@octokit/rest', '@octokit/app'], env: [/^(AUTH_)?GITHUB_(ID|SECRET|CLIENT_ID|CLIENT_SECRET|APP_ID|PRIVATE_KEY)$/] },
  google: { packages: ['googleapis', 'google-auth-library'], env: [/^(AUTH_)?GOOGLE_(ID|SECRET|CLIENT_ID|CLIENT_SECRET)$/] },
  aws: { packages: ['aws-sdk', '@aws-sdk/client-s3', '@aws-sdk/client-sqs', 'boto3'], env: [/^AWS_/] },
  linear: { packages: ['@linear/sdk'], env: [/^LINEAR_/] },
  vercel: { packages: ['@vercel/sdk', '@vercel/blob'], env: [/^VERCEL_(TOKEN|TEAM_ID|PROJECT_ID)$/, /^BLOB_READ_WRITE_TOKEN$/] },
  apple: { packages: ['apple-signin-auth'], env: [/^(AUTH_)?APPLE_/] },
};

// Vendors that offer an official simulation or test mode: use it, never emulate.
export const official: Record<string, string> = {
  stripe: 'the Stripe sandbox (test keys and stripe listen)',
  twilio: 'Twilio test credentials',
  clerk: 'a Clerk development instance',
  okta: 'an Okta developer org',
  auth0: 'an Auth0 development tenant',
  microsoft: 'a Microsoft Entra ID developer tenant',
  mongoatlas: 'the mongodb service',
  resend: 'Resend test addresses',
  slack: 'a Slack development workspace',
};

/** services: the emulated vendors to run; seed: each one's emulate seed, by vendor. */
type Options = { services?: Json; seed?: Json };

const seeds = (options: Options) => optionObjects(options.seed, 'emulate seed');
const selected = (options: Options) => {
  const services = Array.isArray(options.services) ? options.services : [];
  for (const name of [...services, ...Object.keys(seeds(options))]) {
    if (typeof name === 'string' && Object.hasOwn(official, name)) throw new Error(`emulate does not replace ${name}: use ${official[name]}`);
  }
  if (!services.length || !services.every((name): name is string => typeof name === 'string' && Object.hasOwn(emulated, name))) {
    throw new Error(`emulate services must be chosen from: ${Object.keys(emulated).join(', ')}`);
  }
  return [...new Set(services)];
};
const ports = (services: string[]) => Object.fromEntries(services.map((name, index) => [name, BASE_PORT + index]));
const probe = (list: number[]) => `Promise.all(${JSON.stringify(list)}.map(port => fetch('http://127.0.0.1:' + port))).then(() => process.exit(0), () => process.exit(1))`;

export default {
  id: 'emulate', title: 'Emulate', fidelity: 'emulate',
  detect: { packages: Object.values(emulated).flatMap(({ packages }) => packages), env: Object.values(emulated).flatMap(({ env }) => env) },
  // Each service listens on its container port and advertises the twin address, so OAuth redirects reach it.
  containers: ctx => {
    const services = selected(ctx.options), published = ports(services), seed = seeds(ctx.options);
    for (const [name, port] of Object.entries(published)) seed[name] = { ...seed[name], port, baseUrl: ctx.url(name) };
    return [{
      name: 'emulate', image: IMAGE, ports: published, env: { [SEED]: JSON.stringify(seed) },
      command: ['sh', '-c', `printf '%s' "$${SEED}" > ${SEED_FILE} && exec npx --yes ${PACKAGE} start --service ${services.join(',')} --seed ${SEED_FILE}`],
      health: { command: ['node', '-e', probe(Object.values(published))] },
    }];
  },
  // emulate documents <SERVICE>_EMULATOR_URL, e.g. GITHUB_EMULATOR_URL.
  env: ctx => Object.fromEntries(selected(ctx.options).map(name => [`${name.toUpperCase()}_EMULATOR_URL`, ctx.url(name)])),
} satisfies TwinService<Options>;
