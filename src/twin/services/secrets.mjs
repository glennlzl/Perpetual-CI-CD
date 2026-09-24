import { randomBytes } from 'node:crypto';

// Internal secrets that several apps of one product share, such as a gateway key
// or a webhook signing secret. Generated per twin; rebuilding rotates them. Names
// must read as secrets so the core redacts them wherever they appear.
const NAME = /^[A-Z][A-Z0-9_]{0,63}(?:SECRET|KEY|TOKEN|PASSWORD)$/;

export default {
  id: 'secrets', title: 'Generated secrets', fidelity: 'actual',
  detect: {},
  setup: async ({ options }) => {
    const names = options.names ?? [];
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !NAME.test(name))) throw new Error('secrets.names must list variable names ending in SECRET, KEY, TOKEN or PASSWORD.');
    return Object.fromEntries(names.map(name => [name, randomBytes(32).toString('hex')]));
  },
  env: ({ outputs }) => ({ ...outputs }),
};
