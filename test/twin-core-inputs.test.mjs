import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwinInputs, missingInputs } from '../src/twin/inputs.mjs';
import { services } from './fixtures/twin/services.mjs';

const KEY = 'pk_test_stored_987';

test('Inputs are validated, stored privately and shown only as set or not', async t => {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'perpetual-inputs-')), 'data');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createTwinInputs({ dataDir, services });
  const empty = [{ id: 'payments', title: 'Payments', inputs: [{ name: 'PAYMENTS_KEY', label: 'Payments test key', secret: true, help: 'A test-mode key.', set: false }] }];
  assert.deepEqual(await store.view(), empty);
  assert.deepEqual(await store.values(), { payments: {} });

  await assert.rejects(store.set('payments', { PAYMENTS_KEY: 'pk_live_real_key' }), error => !error.message.includes('pk_live') && /Payments test key does not have the expected format/.test(error.message));
  await assert.rejects(store.set('payments', { OTHER: 'x' }), /payments has no input named OTHER/);
  await assert.rejects(store.set('storage', { KEY: 'x' }), /Unknown service "storage"/);

  const view = await store.set('payments', { PAYMENTS_KEY: KEY });
  assert.equal(view[0].inputs[0].set, true);
  assert.equal(JSON.stringify(view).includes(KEY), false);
  assert.equal(JSON.stringify(await store.view()).includes(KEY), false);
  assert.deepEqual(await store.values(), { payments: { PAYMENTS_KEY: KEY } });
  const file = join(dataDir, 'twin-inputs.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { payments: { PAYMENTS_KEY: KEY } });

  await store.set('payments', { PAYMENTS_KEY: '' });
  assert.deepEqual(await store.view(), empty);
});

test('Missing inputs lists absent and malformed values', () => {
  assert.deepEqual(missingInputs(services.payments), ['PAYMENTS_KEY']);
  assert.deepEqual(missingInputs(services.payments, { PAYMENTS_KEY: 'sk_other' }), ['PAYMENTS_KEY']);
  assert.deepEqual(missingInputs(services.payments, { PAYMENTS_KEY: KEY }), []);
  assert.deepEqual(missingInputs(services.mail, {}), []);
});
