import test from 'node:test';
import assert from 'node:assert/strict';
import secrets from '../src/twin/services/secrets.ts';
import type { ServiceContext } from '../src/twin/registry.ts';

// Secrets reads only its options and outputs, so the rest of its context is left out.
const context = ({ options = {}, outputs = {} }: { options?: object; outputs?: object }) => ({ options, outputs }) as ServiceContext<never, never>;

test('generated secrets are random per twin, shared by name and must read as secrets', async () => {
  const names = ['GATEWAY_INTERNAL_KEY', 'WEBHOOK_SECRET'];
  const one = await secrets.setup(context({ options: { names } })), two = await secrets.setup(context({ options: { names } }));
  assert.deepEqual(Object.keys(one), names);
  for (const name of names) { assert.match(one[name], /^[0-9a-f]{64}$/); assert.notEqual(one[name], two[name]); }
  assert.deepEqual(secrets.env(context({ outputs: one })), one);
  assert.deepEqual(await secrets.setup(context({ options: {} })), {});
  for (const bad of [['SIGNING_SALT'], ['lower_secret'], 'WEBHOOK_SECRET', [1]]) await assert.rejects(secrets.setup(context({ options: { names: bad } })), /SECRET, KEY, TOKEN or PASSWORD/);
});
