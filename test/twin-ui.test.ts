import test from 'node:test';
import assert from 'node:assert/strict';
import { twinExpiryLabel, twinInputsChanges, twinInputsRequest, twinKeyFields, twinProvisionRequest, twinServiceRows } from '../client/src/lib/twin-services.ts';

const KEY = { name: 'secretKey', label: 'Payments test secret key', secret: true };
const services = [
  { id: 'database', title: 'Database', fidelity: 'actual', blocked: false, missing: [] },
  { id: 'payments', title: 'Payments', fidelity: 'official-sandbox', blocked: true, missing: [KEY] },
  { id: 'model', title: 'Model', fidelity: 'actual', source: 'settings', blocked: false, missing: [] },
  { id: 'sign-in', title: 'Sign-in', fidelity: 'emulate', blocked: false, missing: [] },
];
const summary = (rows: ReturnType<typeof twinServiceRows>) => rows.map(row => [row.id, row.statusLabel, row.fidelityLabel, row.sourceLabel]);

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
  assert.deepEqual(twinInputsRequest(both, { BASE_URL: 'https://example.test', API_KEY: 'k' })?.inputs, { BASE_URL: 'https://example.test', API_KEY: 'k' });
  assert.equal(twinInputsRequest(services[0], {}), null);
});

const PROVISION = { inputs: [{ name: 'email', label: 'Email', value: 'dev@example.test' }] };
const CLAIM = 'https://dashboard.stripe.com/onboard_sandbox/fixture';

test('an expiry label reads the UTC date, and anything else reads as nothing', () => {
  assert.equal(twinExpiryLabel('2026-10-01'), 'Expires Oct 1');
  assert.equal(twinExpiryLabel('2026-12-31'), 'Expires Dec 31');
  for (const value of [undefined, '', '2026-13-01', 'Oct 1', '2026-10-01T00:00:00Z', 20261001]) assert.equal(twinExpiryLabel(value), '', String(value));
});

test('a provisioned service shows its expiry and claim link and connects keys to replace its sandbox', () => {
  const [blocked, provisioned, own, unsafe] = twinServiceRows([
    { ...services[1], provision: PROVISION },
    { id: 'payments', title: 'Payments', fidelity: 'official-sandbox', blocked: false, missing: [], provision: PROVISION, provisioned: { expiresAt: '2026-10-01', claimUrl: CLAIM }, keys: [KEY] },
    { id: 'payments', title: 'Payments', fidelity: 'official-sandbox', blocked: false, missing: [], provision: PROVISION },
    { id: 'payments', title: 'Payments', fidelity: 'official-sandbox', blocked: false, missing: [], provisioned: { expiresAt: '2026-10-01', claimUrl: 'javascript:alert(1)' }, keys: [KEY] },
  ]);
  assert.deepEqual([blocked.connectable, blocked.expiresLabel, blocked.claimUrl], [true, '', '']);
  assert.deepEqual([provisioned.connectable, provisioned.expiresLabel, provisioned.claimUrl, provisioned.status], [true, 'Expires Oct 1', CLAIM, 'not-started']);
  assert.deepEqual([own.connectable, own.expiresLabel, own.claimUrl], [false, '', '']);
  assert.equal(unsafe.claimUrl, '');
  assert.equal(twinServiceRows(services).filter(row => row.connectable).map(row => row.id).join(), 'payments');

  assert.deepEqual(twinKeyFields(blocked), [KEY]);
  assert.deepEqual(twinKeyFields(provisioned), [KEY]);
  assert.deepEqual(twinKeyFields(own), []);
  assert.deepEqual(twinInputsRequest(provisioned, { secretKey: ' sk_test_claimed ' }), { service: 'payments', inputs: { secretKey: 'sk_test_claimed' } });
});

test('a provision request needs every provision input and trims it', () => {
  const service = { id: 'payments', provision: PROVISION };
  assert.equal(twinProvisionRequest(service, {}), null);
  assert.equal(twinProvisionRequest(service, { email: '  ' }), null);
  assert.deepEqual(twinProvisionRequest(service, { email: ' owner@example.test\n', other: 'ignored' }), { service: 'payments', inputs: { email: 'owner@example.test' } });
  assert.equal(twinProvisionRequest(services[1], { email: 'owner@example.test' }), null, 'A service without a provision creates nothing.');
});

test('a saved input notifies every open Services list', () => {
  const calls: number[] = [];
  const before = twinInputsChanges.revision();
  const stop = twinInputsChanges.subscribe(() => calls.push(twinInputsChanges.revision()));
  twinInputsChanges.notify();
  stop();
  twinInputsChanges.notify();
  assert.deepEqual(calls, [before + 1]);
  assert.equal(twinInputsChanges.revision(), before + 2);
});
