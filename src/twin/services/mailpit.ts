import type { Json } from '../config.ts';
import { optionText } from '../options.ts';
import type { TwinService } from '../registry.ts';

const IMAGE = 'axllent/mailpit:v1.31.2';

type Options = { user?: Json; password?: Json };

export default {
  id: 'mailpit', title: 'Mailpit', fidelity: 'actual',
  detect: { packages: ['nodemailer', 'aiosmtplib'], env: [/^SMTP_/] },
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
