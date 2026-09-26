// The service configuration: config/default.json, then the environment's config/<env>.json, then APP_* variables.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepMerge } from '../util/deep-merge.js';
import { fromEnvironment } from './env.js';
import { validateConfig } from './validate.js';

const CONFIG_DIR = join(import.meta.dirname, '..', '..', 'config');

/** A layer file of config/, or an empty layer when there is none. */
function readLayer(name) {
  const path = join(CONFIG_DIR, `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/**
 * The configuration for env (NODE_ENV, or development) and variables (process.env): each layer is deep-merged over
 * the ones before it, so a layer holds only the settings it changes.
 */
export function loadConfig({ env = process.env.NODE_ENV || 'development', variables = process.env } = {}) {
  if (!/^[a-z][\w-]*$/.test(env)) throw new Error(`Invalid environment name ${env}.`);
  return validateConfig(deepMerge(readLayer('default'), readLayer(env), fromEnvironment(variables)));
}
