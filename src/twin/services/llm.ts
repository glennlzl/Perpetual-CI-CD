import type { Json } from '../config.ts';
import type { TwinService } from '../registry.ts';

// Where the caller takes the inputs from, in preference order: the app's own dev env values
// the user supplied, else Perpetual's App Settings OpenRouter key and model.
const SOURCES = ['app', 'settings'];
type Options = { source?: Json };
const INPUTS = [
  { name: 'OPENAI_BASE_URL', label: 'Base URL', pattern: /^https?:\/\/\S+$/ },
  { name: 'OPENAI_API_KEY', label: 'API key', pattern: /^\S+$/, secret: true },
  { name: 'OPENAI_MODEL', label: 'Model', pattern: /^\S+$/ },
];

const source = ({ source = SOURCES.at(-1)! }: Options) => {
  if (typeof source !== 'string' || !SOURCES.includes(source)) throw new Error(`llm source must be one of: ${SOURCES.join(', ')}`);
  return source;
};

export default {
  id: 'llm', title: 'LLM', fidelity: 'actual',
  detect: { packages: ['openai', '@ai-sdk/openai', '@ai-sdk/openai-compatible', '@openrouter/ai-sdk-provider', 'langchain-openai'], env: [/^OPENAI_/, /^OPENROUTER_/] },
  describe: {
    summary: 'A real model through an OpenAI-compatible API, for the app\'s AI features.',
    options: { source: 'settings (default): App Settings\' OpenRouter key and model; app: the app\'s own development values, which the user enters as its inputs.' },
    provides: INPUTS.map(({ name }) => name),
    notes: ['Map an app variable with another name explicitly, such as an OpenRouter key variable to {{llm.OPENAI_API_KEY}}.'],
  },
  validate: options => { source(options); },
  inputs: INPUTS,
  setup: async ({ options }) => ({ source: source(options) }),
  env: ({ inputs }) => Object.fromEntries(INPUTS.map(({ name }) => [name, inputs[name]])),
} satisfies TwinService<Options, { source: string }>;
