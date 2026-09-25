import { randomBytes } from 'node:crypto';
import type { Json } from '../config.ts';
import { optionText } from '../options.ts';
import type { TwinService } from '../registry.ts';

const IMAGE = 'redis:8.10.2-alpine';
const PORT = 6379;
const PASSWORD = 'REDISCLI_AUTH'; // read by redis-cli, so the health check authenticates too

type Options = { password?: Json };
type Outputs = { password: string };

export default {
  id: 'redis', title: 'Redis', fidelity: 'actual',
  detect: { packages: ['redis', 'ioredis', 'bullmq', 'bull'], env: [/^REDIS_/] },
  setup: async ({ options }) => ({ password: optionText(options.password, 'redis.password') ?? randomBytes(24).toString('hex') }),
  // The password stays in the environment; the image's entrypoint still drops privileges.
  containers: ({ outputs }) => [{
    name: 'redis', image: IMAGE, ports: { redis: PORT }, env: { [PASSWORD]: outputs.password },
    command: ['sh', '-c', `exec docker-entrypoint.sh redis-server --requirepass "$${PASSWORD}"`],
    health: { command: 'redis-cli ping | grep -q PONG' },
  }],
  env: ctx => ({ REDIS_URL: `redis://:${encodeURIComponent(ctx.outputs.password)}@${ctx.host}:${ctx.port('redis')}` }),
} satisfies TwinService<Options, Outputs>;
