import { randomBytes } from 'node:crypto';

const IMAGE = 'mongo:8.0.32-noble';
const PORT = 27017;
const DEFAULT_USER = 'root'; // the root user in the official image's documentation
const AUTH_DATABASE = 'admin'; // where the image creates its root user

const user = options => options.user ?? DEFAULT_USER;

export default {
  id: 'mongodb', title: 'MongoDB', fidelity: 'actual',
  detect: { packages: ['mongodb', 'mongoose', 'pymongo', 'motor'], env: [/^MONGO(DB)?_(URI|URL)$/] },
  setup: async ({ options }) => ({ password: options.password ?? randomBytes(24).toString('hex') }),
  containers: ({ options, outputs }) => [{
    name: 'mongodb', image: IMAGE, ports: { mongodb: PORT },
    env: { MONGO_INITDB_ROOT_USERNAME: user(options), MONGO_INITDB_ROOT_PASSWORD: outputs.password },
    health: { command: ['mongosh', '--quiet', '--eval', "db.adminCommand('ping').ok"] },
  }],
  env: ctx => {
    const { options, outputs } = ctx;
    const database = options.database ? `/${encodeURIComponent(options.database)}?authSource=${AUTH_DATABASE}` : '';
    const uri = `mongodb://${encodeURIComponent(user(options))}:${encodeURIComponent(outputs.password)}@${ctx.host}:${ctx.port('mongodb')}${database}`;
    return { MONGODB_URI: uri, MONGO_URL: uri };
  },
};
