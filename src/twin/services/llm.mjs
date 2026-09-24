// Where the caller takes the inputs from, in preference order: the app's own dev env values
// the user supplied, else Perpetual's App Settings OpenRouter key and model.
const SOURCES = ['app', 'settings'];
const INPUTS = [
  { name: 'OPENAI_BASE_URL', label: 'Base URL', pattern: /^https?:\/\/\S+$/ },
  { name: 'OPENAI_API_KEY', label: 'API key', pattern: /^\S+$/, secret: true },
  { name: 'OPENAI_MODEL', label: 'Model', pattern: /^\S+$/ },
];

const source = ({ source = SOURCES.at(-1) }) => {
  if (!SOURCES.includes(source)) throw new Error(`llm source must be one of: ${SOURCES.join(', ')}`);
  return source;
};

export default {
  id: 'llm', title: 'LLM', fidelity: 'actual',
  detect: { packages: ['openai', '@ai-sdk/openai', '@ai-sdk/openai-compatible', '@openrouter/ai-sdk-provider', 'langchain-openai'], env: [/^OPENAI_/, /^OPENROUTER_/] },
  inputs: INPUTS,
  setup: async ({ options }) => ({ source: source(options) }),
  env: ({ inputs }) => Object.fromEntries(INPUTS.map(({ name }) => [name, inputs[name]])),
};
