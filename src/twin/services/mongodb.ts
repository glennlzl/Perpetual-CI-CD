import { randomBytes } from 'node:crypto';
import type { Json } from '../config.ts';
import { optionText } from '../options.ts';
import type { TwinService } from '../registry.ts';

const IMAGE = 'mongo:8.0.32-noble';
const PORT = 27017;
const DEFAULT_USER = 'root'; // the root user in the official image's documentation
const AUTH_DATABASE = 'admin'; // where the image creates its root user

type Options = { user?: Json; password?: Json; database?: Json };
type Outputs = { password: string };

const user = (options: Options) => optionText(options.user, 'mongodb.user') ?? DEFAULT_USER;

export default {
  id: 'mongodb', title: 'MongoDB', fidelity: 'actual',
  detect: { packages: ['mongodb', 'mongoose', 'pymongo', 'motor'], env: [/^MONGO(DB)?_(URI|URL)$/] },
  setup: async ({ options }) => ({ password: optionText(options.password, 'mongodb.password') ?? randomBytes(24).toString('hex') }),
  containers: ({ options, outputs }) => [{
    name: 'mongodb', image: IMAGE, ports: { mongodb: PORT },
    env: { MONGO_INITDB_ROOT_USERNAME: user(options), MONGO_INITDB_ROOT_PASSWORD: outputs.password },
    health: { command: ['mongosh', '--quiet', '--eval', "db.adminCommand('ping').ok"] },
  }],
  env: ctx => {
    const { options, outputs } = ctx;
    const name = options.database ? optionText(options.database, 'mongodb.database') : undefined;
    const database = name ? `/${encodeURIComponent(name)}?authSource=${AUTH_DATABASE}` : '';
    const uri = `mongodb://${encodeURIComponent(user(options))}:${encodeURIComponent(outputs.password)}@${ctx.host}:${ctx.port('mongodb')}${database}`;
    return { MONGODB_URI: uri, MONGO_URL: uri };
  },
} satisfies TwinService<Options, Outputs>;
