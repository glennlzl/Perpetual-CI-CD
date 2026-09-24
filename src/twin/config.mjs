import { relative } from './paths.mjs';
import { services as registry } from './registry.mjs';

// A twin config is data: { services: { <id>: options }, install?: { directory, command }, apps: { <id>: app }, fixtures: [...] }.
// Strings may reference {{<service>.<VARIABLE>}} (a variable a service provides), {{apps.<id>.url}} or
// {{services.<id>.url.<port>}} (a service's address on one of its named ports). Variable placeholders in service
// options decide the setup order; addresses come from port allocation before any setup, so they order nothing.

export const APPS = 'apps';
const SERVICES = 'services';
/** Service options named env are environments, like an app's. */
const ENV = 'env';
/** The optional install step apps share, e.g. one workspace install; no app may take its name. */
export const INSTALL = 'install';
const APP_URL = 'url';
export const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const FIELDS = { config: ['services', INSTALL, 'apps', 'fixtures'], install: ['directory', 'command'], app: ['directory', 'build', 'start', 'port', 'env'], fixture: ['service', 'sql', 'query', 'command'] };

export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const fail = message => { throw new Error(message); };

function fields(value, allowed, where) {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`${where} has unsupported field ${extra.join(', ')}; use ${allowed.join(', ')}.`);
}

function json(value, where) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${where}[${index}]`));
  if (!plain(value)) fail(`${where} must contain JSON values only.`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (RESERVED.has(key)) fail(`${where} uses the reserved key ${key}.`);
    return [key, json(item, `${where}.${key}`)];
  }));
}

function command(value, where) {
  if (typeof value !== 'string' || !value.trim()) fail(`${where} must be a non-empty command.`);
  return value.trim();
}


function parse(expression, where) {
  const parts = expression.split('.');
  if (parts[0] === APPS && parts.length === 3 && ID.test(parts[1]) && parts[2] === APP_URL) return { app: parts[1] };
  if (parts[0] === SERVICES && parts.length === 4 && ID.test(parts[1]) && parts[2] === APP_URL && ID.test(parts[3])) return { addressOf: parts[1], port: parts[3] };
  if (parts[0] !== APPS && parts.length === 2 && ID.test(parts[0]) && VARIABLE.test(parts[1])) return { service: parts[0], variable: parts[1] };
  return fail(`${where}: {{${expression}}} is not a placeholder; use {{<service>.<VARIABLE>}}, {{${APPS}.<id>.${APP_URL}}} or {{${SERVICES}.<id>.${APP_URL}.<port>}}.`);
}

/** The placeholder text of a service address reference, for messages. */
export const addressText = ref => `{{${SERVICES}.${ref.addressOf}.${APP_URL}.${ref.port}}}`;

/** Every placeholder referenced anywhere inside a JSON value, with where it appears. */
export function placeholders(value, where = 'value') {
  if (typeof value === 'string') return [...value.matchAll(PLACEHOLDER)].map(match => ({ ...parse(match[1], where), where }));
  if (Array.isArray(value)) return value.flatMap((item, index) => placeholders(item, `${where}[${index}]`));
  if (plain(value)) return Object.entries(value).flatMap(([key, item]) => placeholders(item, `${where}.${key}`));
  return [];
}

/** Replaces placeholders in every string; lookup(ref) returns the value or throws. */
export function resolvePlaceholders(value, lookup, where = 'value') {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_, expression) => String(lookup(parse(expression, where))));
  if (Array.isArray(value)) return value.map((item, index) => resolvePlaceholders(item, lookup, `${where}[${index}]`));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, lookup, `${where}.${key}`)]));
  return value;
}

/** Service options without the env entries that reference a blocked service: like an app's variables, they are left
 * out, while any other option that references a blocked service blocks its service. */
export function leaveOutBlocked(value, blocked, env = false) {
  if (Array.isArray(value)) return value.map(item => leaveOutBlocked(item, blocked));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => !env || !placeholders(item).some(ref => blocked(ref.service)))
    .map(([key, item]) => [key, leaveOutBlocked(item, blocked, key === ENV)]));
}

/** Service ids in the order their option placeholders imply; config order breaks ties. */
export function setupOrder(config) {
  const order = [], state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') fail(`Circular placeholders: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}.`);
    state.set(id, 'visiting');
    for (const ref of placeholders(config.services[id], `services.${id}`)) if (ref.service) visit(ref.service, [...path, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of Object.keys(config.services)) visit(id, []);
  return order;
}

export function validateTwinConfig(input, { services = registry } = {}) {
  if (!plain(input)) fail('A twin config must be an object with services, apps and fixtures.');
  fields(input, FIELDS.config, 'The twin config');
  const config = { services: {}, apps: {}, fixtures: [] };
  if (!plain(input.services ?? {})) fail('services must map service ids to options.');
  for (const [id, options] of Object.entries(input.services ?? {})) {
    if (!Object.hasOwn(services, id)) fail(`Unknown service "${id}"; supported services are ${Object.keys(services).join(', ') || 'none'}.`);
    if (options != null && !plain(options)) fail(`services.${id} must be an object of options.`);
    config.services[id] = json(options ?? {}, `services.${id}`);
  }
  if (input.install != null) {
    if (!plain(input.install)) fail(`${INSTALL} must be an object with directory and command.`);
    fields(input.install, FIELDS.install, INSTALL);
    config.install = { directory: relative(input.install.directory ?? '.', `${INSTALL}.directory`), command: command(input.install.command, `${INSTALL}.command`) };
  }
  if (!plain(input.apps ?? {})) fail('apps must map app ids to apps.');
  for (const [id, app] of Object.entries(input.apps ?? {})) {
    const where = `apps.${id}`;
    if (!ID.test(id)) fail(`App id "${id}" must use lowercase letters, digits and single hyphens.`);
    if (Object.hasOwn(config.services, id)) fail(`App "${id}" has the same id as a service; rename the app.`);
    if (config.install && id === INSTALL) fail(`App "${id}" has the same name as the install step; rename the app.`);
    if (!plain(app)) fail(`${where} must be an object.`);
    fields(app, FIELDS.app, where);
    if (!Number.isInteger(app.port) || app.port < 1 || app.port > 65535) fail(`${where}.port must be the port the app listens on (1-65535).`);
    if (app.env != null && !plain(app.env)) fail(`${where}.env must map variable names to values.`);
    const env = Object.fromEntries(Object.entries(app.env ?? {}).map(([name, value]) => {
      if (!VARIABLE.test(name)) fail(`${where}.env.${name} is not a valid variable name.`);
      if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`${where}.env.${name} must be text.`);
      return [name, String(value)];
    }));
    config.apps[id] = { directory: relative(app.directory ?? '.', `${where}.directory`),
      ...(app.build == null ? {} : { build: command(app.build, `${where}.build`) }), start: command(app.start, `${where}.start`), port: app.port, env };
  }
  if (!Array.isArray(input.fixtures ?? [])) fail('fixtures must be a list.');
  config.fixtures = (input.fixtures ?? []).map((fixture, index) => {
    const where = `fixtures[${index}]`;
    if (!plain(fixture)) fail(`${where} must be an object.`);
    fields(fixture, FIELDS.fixture, where);
    if (!Object.hasOwn(config.services, fixture.service)) fail(`${where}.service must be one of the configured services.`);
    // sql is a repository file; query is inline SQL kept with the twin config, so a twin needs no files in the product's repository.
    if (['sql', 'query', 'command'].filter(key => fixture[key] != null).length !== 1) fail(`${where} needs exactly one of sql, query or command.`);
    if (fixture.sql != null) return { service: fixture.service, sql: relative(fixture.sql, `${where}.sql`) };
    if (fixture.query != null) return { service: fixture.service, query: command(fixture.query, `${where}.query`) };
    return { service: fixture.service, command: command(fixture.command, `${where}.command`) };
  });
  const check = (value, where) => {
    for (const ref of placeholders(value, where)) {
      if (ref.app && !Object.hasOwn(config.apps, ref.app)) fail(`${ref.where} references {{${APPS}.${ref.app}.${APP_URL}}}, but no app "${ref.app}" is configured.`);
      if (ref.service && !Object.hasOwn(config.services, ref.service)) fail(`${ref.where} references {{${ref.service}.${ref.variable}}}, but service "${ref.service}" is not configured.`);
      if (ref.addressOf && !Object.hasOwn(config.services, ref.addressOf)) fail(`${ref.where} references ${addressText(ref)}, but service "${ref.addressOf}" is not configured.`);
    }
  };
  for (const [id, options] of Object.entries(config.services)) check(options, `services.${id}`);
  for (const [id, app] of Object.entries(config.apps)) check(app.env, `apps.${id}.env`);
  setupOrder(config);
  return config;
}
