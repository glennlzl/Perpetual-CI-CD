import type { Json } from '../config.ts';
import { optionText } from '../options.ts';
import type { TwinService } from '../registry.ts';

const IMAGE = 'axllent/mailpit:v1.31.2';

type Options = { user?: Json; password?: Json };

export default {
  id: 'mailpit', title: 'Mailpit', fidelity: 'actual',
  detect: { packages: ['nodemailer', 'aiosmtplib'], env: [/^SMTP_/] },
  describe: {
    summary: 'Mailpit, an SMTP server that keeps every message it receives, with a web view and API.',
    options: { user: 'SMTP user the app sends as; any is accepted.', password: 'SMTP password the app sends; any is accepted.' },
    provides: ['SMTP_HOST', 'SMTP_PORT', 'MAILPIT_URL'],
    // As env gives them.
    optionProvides: options => [...(options.user ? ['SMTP_USER'] : []), ...(options.password ? ['SMTP_PASSWORD'] : [])],
    ports: ['smtp', 'web'],
    notes: ['SMTP_USER and SMTP_PASSWORD are provided only when user and password are set.'],
  },
  validate: options => { for (const name of ['user', 'password'] as const) optionText(options[name], `mailpit.${name}`); },
  containers: () => [{
    name: 'mailpit', image: IMAGE, ports: { smtp: 1025, web: 8025 },
    // Accept any SMTP credentials, so apps that always authenticate can send.
    env: { MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' },
    health: { command: ['/mailpit', 'readyz'] },
  }],
  env: ctx => ({
    SMTP_HOST: ctx.host, SMTP_PORT: String(ctx.port('smtp')), MAILPIT_URL: ctx.url('web'),
    ...(ctx.options.user && { SMTP_USER: optionText(ctx.options.user, 'mailpit.user') }),
    ...(ctx.options.password && { SMTP_PASSWORD: optionText(ctx.options.password, 'mailpit.password') }),
  }),
} satisfies TwinService<Options>;
