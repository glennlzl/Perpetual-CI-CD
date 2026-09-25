import { randomBytes } from 'node:crypto';
import type { Json } from '../config.ts';
import type { TwinService } from '../registry.ts';

// Internal secrets that several apps of one product share, such as a gateway key
// or a webhook signing secret. Generated per twin; rebuilding rotates them. Names
// must read as secrets so the core redacts them wherever they appear.
const NAME = /^[A-Z][A-Z0-9_]{0,63}(?:SECRET|KEY|TOKEN|PASSWORD)$/;

/** names are checked in setup, which returns a secret by name. */
type Options = { names?: Json };

function names(options: Options) {
  const list = options.names ?? [];
  if (!Array.isArray(list) || !list.every((name): name is string => typeof name === 'string' && NAME.test(name))) throw new Error('secrets.names must list variable names ending in SECRET, KEY, TOKEN or PASSWORD.');
  return list;
}

export default {
  id: 'secrets', title: 'Generated secrets', fidelity: 'actual',
  detect: {},
  describe: {
    summary: 'Random secrets the product generates for itself, such as a session secret or a key two of its apps share.',
    options: { names: 'Variable names ending in SECRET, KEY, TOKEN or PASSWORD; each gets a random value per twin.' },
    provides: [],
    optionProvides: options => { try { return names(options); } catch { return []; } },
    notes:['Provides each listed name, so an app variable of that name is filled.', 'Never for a vendor\'s credentials: those come from the vendor\'s service.'],
  },
  validate: options => { names(options); },
  setup: async ({ options }) => Object.fromEntries(names(options).map(name => [name, randomBytes(32).toString('hex')])),
  env: ({ outputs }) => ({ ...outputs }),
} satisfies TwinService<Options, Record<string, string>>;
