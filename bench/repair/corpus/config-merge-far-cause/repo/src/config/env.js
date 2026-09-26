// The environment's configuration layer: APP_* variables.

const PREFIX = 'APP_';

/** A variable's text as a setting: true and false, a number, or the text itself. */
export function parseValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text;
}

/** A part of a variable name as a settings key: FREE_FROM is freeFrom. */
const keyOf = part => part.toLowerCase().replace(/_([a-z\d])/g, (_match, char) => char.toUpperCase());

/**
 * The layer of APP_* variables: double underscores separate levels and single underscores join words, so
 * APP_SERVER__PORT=8080 sets server.port and APP_REGIONS__US__SHIPPING__FREE_FROM=7500 sets
 * regions.us.shipping.freeFrom. Other variables are ignored.
 */
export function fromEnvironment(variables) {
  const layer = {};
  for (const [name, text] of Object.entries(variables)) {
    if (!name.startsWith(PREFIX) || typeof text !== 'string') continue;
    const path = name.slice(PREFIX.length).split('__').map(keyOf);
    if (path.some(part => !part)) continue;
    let target = layer;
    for (const part of path.slice(0, -1)) {
      if (typeof target[part] !== 'object' || target[part] === null) target[part] = {};
      target = target[part];
    }
    target[path.at(-1)] = parseValue(text);
  }
  return layer;
}
