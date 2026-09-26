const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A deep merge: objects merge key by key, and any other override value replaces the base value. Neither input changes. */
function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  return result;
}

module.exports = { merge };
