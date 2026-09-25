// Service definitions for the twin core tests, in the shape of src/twin/services/*.ts.
import type { Json } from '../../../src/twin/config.ts';
import type { TwinService, TwinServices } from '../../../src/twin/registry.ts';

export const database = {
  id: 'database', title: 'Database', fidelity: 'actual',
  detect: { packages: ['pg'], env: [/^DATABASE_/], files: ['db/schema.sql'] },
  containers: ctx => [{ name: 'database', image: 'postgres:17-alpine', env: { POSTGRES_PASSWORD: 'db-password-1' }, ports: { sql: 5432 },
    health: { command: ['pg_isready', '-U', 'postgres'] } }],
  env: ctx => ({ DATABASE_URL: `postgres://postgres:db-password-1@${ctx.host}:${ctx.port('sql')}/postgres` }),
} satisfies TwinService;

export const mail = {
  id: 'mail', title: 'Mail', fidelity: 'actual',
  detect: { packages: ['mailer'], env: [/^SMTP_/] },
  containers: () => [{ name: 'mail', image: 'mail/server:1.0', ports: { smtp: 1025, web: 8025 }, health: { http: { port: 'web', path: '/livez' } } }],
  env: ctx => ({ SMTP_HOST: ctx.host, SMTP_PORT: ctx.port('smtp'), MAIL_API_URL: ctx.url('web', '/api') }),
} satisfies TwinService;

export const payments = {
  id: 'payments', title: 'Payments', fidelity: 'official-sandbox',
  detect: { packages: [/^payments-sdk$/], env: [/^PAYMENTS_/] },
  inputs: [{ name: 'PAYMENTS_KEY', label: 'Payments test key', secret: true, pattern: /^pk_test_/, help: 'A test-mode key.' }],
  setup: async ctx => {
    const { stdout } = await ctx.run('payments/cli:1.0', ['listen', '--print-secret'], { env: { PAYMENTS_KEY: ctx.inputs.PAYMENTS_KEY } });
    return { webhookSecret: stdout.trim() };
  },
  containers: ctx => [{ name: 'listener', image: 'payments/cli:1.0', command: ['listen', '--forward-to', String(ctx.options.webhook)], env: { PAYMENTS_KEY: ctx.inputs.PAYMENTS_KEY } }],
  env: ctx => ({ PAYMENTS_KEY: ctx.inputs.PAYMENTS_KEY, PAYMENTS_WEBHOOK_SECRET: ctx.outputs.webhookSecret }),
  teardown: async ctx => { await ctx.run('payments/cli:1.0', ['logout']); },
} satisfies TwinService<{ webhook?: Json }, { webhookSecret: string }>;

export const jobs = {
  id: 'jobs', title: 'Jobs', fidelity: 'actual',
  detect: { packages: ['jobs-sdk'] },
  setup: async ctx => ({ projectRef: `${ctx.project}-${String(ctx.options.database).length}` }),
  containers: ctx => [{ name: 'worker', image: 'jobs/worker:2.0', env: { JOBS_DATABASE: String(ctx.options.database) }, ports: { api: 8030 } }],
  env: ctx => ({ JOBS_API_URL: ctx.url('api'), JOBS_PROJECT: ctx.outputs.projectRef }),
  teardown: async ctx => { await ctx.run('jobs/cli:2.0', ['delete', ctx.outputs.projectRef]); },
} satisfies TwinService<{ database?: Json }, { projectRef: string }>;

export const services: TwinServices = Object.fromEntries([database, mail, payments, jobs].map(service => [service.id, service]));
