import test from 'node:test';
import assert from 'node:assert/strict';
import secrets from '../src/twin/services/secrets.mjs';

test('generated secrets are random per twin, shared by name and must read as secrets', async () => {
  const names = ['GATEWAY_INTERNAL_KEY', 'WEBHOOK_SECRET'];
  const one = await secrets.setup({ options: { names } }), two = await secrets.setup({ options: { names } });
  assert.deepEqual(Object.keys(one), names);
  for (const name of names) { assert.match(one[name], /^[0-9a-f]{64}$/); assert.notEqual(one[name], two[name]); }
  assert.deepEqual(secrets.env({ outputs: one }), one);
  assert.deepEqual(await secrets.setup({ options: {} }), {});
  for (const bad of [['SIGNING_SALT'], ['lower_secret'], 'WEBHOOK_SECRET', [1]]) await assert.rejects(secrets.setup({ options: { names: bad } }), /SECRET, KEY, TOKEN or PASSWORD/);
});
