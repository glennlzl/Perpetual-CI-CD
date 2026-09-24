import test from 'node:test';
import assert from 'node:assert/strict';
import { twinInputsChanges, twinInputsRequest, twinServiceRows } from '../client/src/lib/twin-services.js';

const KEY = { name: 'secretKey', label: 'Payments test secret key', secret: true };
const services = [
  { id: 'database', title: 'Database', fidelity: 'actual', blocked: false, missing: [] },
  { id: 'payments', title: 'Payments', fidelity: 'official-sandbox', blocked: true, missing: [KEY] },
  { id: 'model', title: 'Model', fidelity: 'actual', source: 'settings', blocked: false, missing: [] },
  { id: 'sign-in', title: 'Sign-in', fidelity: 'emulate', blocked: false, missing: [] },
];
const summary = rows => rows.map(row => [row.id, row.statusLabel, row.fidelityLabel, row.sourceLabel]);

test('services are Not started until the stage twin reports them ready', () => {
  assert.deepEqual(summary(twinServiceRows(services)), [
    ['database', 'Not started', 'Actual', ''],
    ['payments', 'Blocked', 'Official sandbox', ''],
    ['model', 'Not started', 'Actual', 'App Settings'],
    ['sign-in', 'Not started', 'Emulate', ''],
  ]);
  // Environment readiness alone never marks a service ready.
  assert.deepEqual(twinServiceRows(services, { status: 'ready' }).map(row => row.status), ['not-started', 'blocked', 'not-started', 'not-started']);
});

test('a ready twin marks only its ready services, and blocked services stay Blocked', () => {
  const built = [{ id: 'database', status: 'ready' }, { id: 'payments', status: 'ready' }, { id: 'model', status: 'ready' }, { id: 'sign-in', status: 'blocked', missing: ['x'] }];
  assert.deepEqual(twinServiceRows(services, { status: 'ready', services: built }).map(row => row.status), ['ready', 'blocked', 'ready', 'not-started']);
  // A twin that is still starting or has failed runs nothing yet.
  for (const status of ['creating', 'failed', 'destroyed']) assert.deepEqual(twinServiceRows(services, { status, services: built }).map(row => row.status), ['not-started', 'blocked', 'not-started', 'not-started']);
  // An App Settings model that is not configured blocks without inputs to connect.
  const [model] = twinServiceRows([{ ...services[2], blocked: true }], { status: 'ready', services: built });
  assert.deepEqual([model.status, model.sourceLabel, model.missing], ['blocked', 'App Settings', []]);
});

test('an unknown fidelity keeps its own name and rows default to no missing inputs', () => {
  const [row] = twinServiceRows([{ id: 'queue', title: 'Queue', fidelity: 'local' }]);
  assert.equal(row.fidelityLabel, 'local');
  assert.deepEqual(row.missing, []);
  assert.equal(row.status, 'not-started');
});

test('an inputs request needs every missing input and trims pasted values', () => {
  const payments = services[1];
  assert.equal(twinInputsRequest(payments, {}), null);
  assert.equal(twinInputsRequest(payments, { secretKey: '   ' }), null);
  assert.deepEqual(twinInputsRequest(payments, { secretKey: ' sk_test_1 \n', other: 'ignored' }), { service: 'payments', inputs: { secretKey: 'sk_test_1' } });
  const both = { id: 'model', missing: [{ name: 'BASE_URL' }, { name: 'API_KEY', secret: true }] };
  assert.equal(twinInputsRequest(both, { API_KEY: 'k' }), null);
  assert.deepEqual(twinInputsRequest(both, { BASE_URL: 'https://example.test', API_KEY: 'k' }).inputs, { BASE_URL: 'https://example.test', API_KEY: 'k' });
  assert.equal(twinInputsRequest(services[0], {}), null);
});

test('a saved input notifies every open Services list', () => {
  const calls = [];
  const before = twinInputsChanges.revision();
  const stop = twinInputsChanges.subscribe(() => calls.push(twinInputsChanges.revision()));
  twinInputsChanges.notify();
  stop();
  twinInputsChanges.notify();
  assert.deepEqual(calls, [before + 1]);
  assert.equal(twinInputsChanges.revision(), before + 2);
});
