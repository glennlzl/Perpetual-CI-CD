// Deep merge of configuration layers (src/config/load.js).

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Merges layers left to right into a new object. Plain objects merge key by key at every depth; arrays, scalars and
 * null replace what was there. Later layers win, and no layer is changed.
 */
export function deepMerge(...layers) {
  const result = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      result[key] = isPlainObject(value) && isPlainObject(result[key]) ? { ...result[key], ...value } : value;
    }
  }
  return result;
}
