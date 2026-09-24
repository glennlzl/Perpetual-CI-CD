import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { services } from '../src/twin/index.mjs';

const directory = new URL('../src/twin/services/', import.meta.url);
const FIDELITY = ['actual', 'official-sandbox', 'emulate'];
const list = (value, check) => value === undefined || (Array.isArray(value) && value.every(check));

test('Every service file is registered once under its file name', async () => {
  const files = (await readdir(directory)).filter(file => file.endsWith('.mjs')).sort();
  assert.deepEqual(files.map(file => file.slice(0, -4)), Object.keys(services).sort());
  for (const file of files) {
    const { default: service } = await import(new URL(file, directory));
    assert.equal(services[service.id], service, file);
  }
});

test('Every service follows the service interface', () => {
  for (const service of Object.values(services)) {
    assert.match(service.id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.equal(typeof service.title, 'string', service.id);
    assert.ok(FIDELITY.includes(service.fidelity), service.id);
    const { packages, env, files } = service.detect ?? {};
    assert.ok(list(packages, item => typeof item === 'string' || item instanceof RegExp), service.id);
    assert.ok(list(env, item => item instanceof RegExp), service.id);
    assert.ok(list(files, item => typeof item === 'string' || item instanceof RegExp), service.id);
    assert.ok(list(service.inputs, input => /^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name) && typeof input.label === 'string'), service.id);
    // An included service is another registered one that includes nothing back.
    assert.ok(list(service.includes, id => id !== service.id && Object.hasOwn(services, id) && !services[id].includes?.includes(service.id)), `${service.id}.includes`);
    assert.equal(typeof service.env, 'function', service.id);
    for (const hook of ['setup', 'containers', 'accounts', 'teardown']) assert.ok(service[hook] === undefined || typeof service[hook] === 'function', `${service.id}.${hook}`);
  }
});
