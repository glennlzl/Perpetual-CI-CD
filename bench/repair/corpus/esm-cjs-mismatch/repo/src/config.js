const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { merge } = require('./merge.js');

const DEFAULTS = join(__dirname, '..', 'defaults.json');

/** Overrides from environment variables: APP__SERVER__PORT=9000 sets server.port to 9000. Numbers and booleans are parsed. */
function fromEnvironment(env) {
  const result = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('APP__')) continue;
    const path = key.slice(5).toLowerCase().split('__');
    let target = result;
    for (const part of path.slice(0, -1)) target = target[part] ??= {};
    target[path.at(-1)] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return result;
}

/** The configuration: defaults.json next to the package, deep-merged with overrides from the environment. */
export function loadConfig({ env = process.env } = {}) {
  const defaults = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
  return merge(defaults, fromEnvironment(env));
}
