// Local provider marks in public/assets/providers. Colored marks keep their
// source colors; only monochrome marks invert on dark surfaces.
const ASSETS = { github: 'github', vercel: 'vercel', railway: 'railway', supabase: 'supabase', langgraph: 'langgraph', composio: 'composio', 'trigger.dev': 'triggerdotdev', 'next.js': 'nextdotjs', hono: 'hono' };
const COLORED = new Set(['supabase', 'hono', 'langgraph', 'triggerdotdev']);

export const providerAsset = provider => ASSETS[String(provider || '').toLowerCase()];
export const monochromeAsset = asset => !COLORED.has(asset);
