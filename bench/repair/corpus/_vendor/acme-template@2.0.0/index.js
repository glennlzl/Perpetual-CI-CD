const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Compiles a template with {{name}} placeholders (nested names such as {{user.name}} too) into a function of its data.
 * A missing value throws `Missing value for "<name>"`, unless strict is false, when it renders as empty text.
 */
export function compile(template, { strict = true } = {}) {
  if (typeof template !== 'string') throw new TypeError('compile() takes a template string.');
  return data => template.replace(PLACEHOLDER, (_match, name) => {
    const value = name.split('.').reduce((object, key) => object == null ? undefined : object[key], data);
    if (value === undefined || value === null) {
      if (strict) throw new Error(`Missing value for "${name}"`);
      return '';
    }
    return String(value);
  });
}
