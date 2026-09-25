import type { Json } from './config.ts';

// A twin config gives each service its options as JSON, checked only as an object; a service checks each field
// where it uses it, with these. Imported by service files, so it depends on nothing else in the twin core.

type Option = Json | undefined;

/** Text, a number or a boolean as text, like an app's env value; undefined when null or left out. */
export function optionText(value: Option, where: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') throw new Error(`${where} must be text.`);
  return String(value);
}

/** Variables of a service's own container: names to text, numbers or booleans; a null value is left out. */
export function optionEnv(value: Option, where: string): Record<string, string | number | boolean | null> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must map variable names to values.`);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (typeof item === 'object' && item !== null) throw new Error(`${where}.${name} must be text.`);
    return [name, item];
  }));
}

const isObject = (value: Json | undefined): value is { [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Names mapped to objects, e.g. a seed per vendor; empty when null or left out. */
export function optionObjects(value: Option, where: string): Record<string, { [key: string]: Json }> {
  if (value == null) return {};
  if (!isObject(value)) throw new Error(`${where} must map names to objects.`);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (!isObject(item)) throw new Error(`${where}.${name} must be an object.`);
    return [name, item];
  }));
}
