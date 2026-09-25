import { randomBytes } from 'node:crypto';
import type { Json } from '../config.ts';
import { optionText } from '../options.ts';
import type { ServiceContext, TwinService } from '../registry.ts';

const IMAGE = 'postgres:18.6-alpine';
const PORT = 5432;
const DEFAULT_USER = 'postgres'; // the official image's default role and database

type Options = { user?: Json; database?: Json; password?: Json };
type Outputs = { password: string };

const settings = ({ options, outputs }: Pick<ServiceContext<Options, Outputs>, 'options' | 'outputs'>) => {
  const user = optionText(options.user, 'postgres.user');
  return { user: user ?? DEFAULT_USER, database: optionText(options.database, 'postgres.database') ?? user ?? DEFAULT_USER, password: outputs.password };
};

export default {
  id: 'postgres', title: 'PostgreSQL', fidelity: 'actual',
  detect: { packages: ['pg', 'postgres', 'pg-promise', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'], env: [/^POSTGRES_/, /^PG(HOST|PORT|USER|PASSWORD|DATABASE)$/] },
  setup: async ({ options }) => ({ password: optionText(options.password, 'postgres.password') ?? randomBytes(24).toString('hex') }),
  containers: ctx => {
    const { user, database, password } = settings(ctx);
    return [{
      name: 'postgres', image: IMAGE, ports: { postgres: PORT },
      env: { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database },
      // TCP, not the socket: the entrypoint's temporary init server listens on the socket only.
      health: { command: ['pg_isready', '-h', '127.0.0.1', '-U', user, '-d', database] },
    }];
  },
  env: ctx => {
    const { user, database, password } = settings(ctx), port = ctx.port('postgres');
    return {
      DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${ctx.host}:${port}/${encodeURIComponent(database)}`,
      POSTGRES_HOST: ctx.host, POSTGRES_PORT: String(port), POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database,
    };
  },
} satisfies TwinService<Options, Outputs>;
