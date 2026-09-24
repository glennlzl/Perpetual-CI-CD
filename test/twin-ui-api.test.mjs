import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

const EXAMPLE_SECRET = 'example-password-in-env-file';
const PRIVATE_KEY = 'tr_dev_private_value';
const STRIPE_KEY = 'sk_test_saved_value_123';
const unset = { apiKey: '', model: '', baseUrl: 'https://openrouter.ai/api/v1' };
const configured = { apiKey: 'sk-or-v1-test-only', model: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' };

// A repository whose dependencies, env example and Supabase directory need services;
// a private .env is never evidence.
async function repository(dir) {
  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'worker'), { recursive: true });
  await mkdir(join(repo, 'supabase'));
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { stripe: '^17.0.0', pg: '^8.0.0' }, devDependencies: { openai: '^4.0.0' } }));
  await writeFile(join(repo, '.env.example'), `SMTP_HOST=mail\nREDIS_URL=redis://user:${EXAMPLE_SECRET}@localhost:6379\n`);
  await writeFile(join(repo, 'worker', 'requirements.txt'), '# worker\n-r base.txt\npymongo==4.8.0\n');
  await writeFile(join(repo, 'supabase', 'config.toml'), 'project_id = "fixture"\n');
  await writeFile(join(repo, '.env'), `TRIGGER_SECRET_KEY=${PRIVATE_KEY}\n`);
  return repo;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-twin-ui-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const repo = await repository(dir);
  let app, token;
  async function request(path, { method = 'GET', body, withToken = true } = {}) {
    const response = await fetch(app.url + path, { method, headers: body ? { 'Content-Type': 'application/json', ...(withToken ? { 'X-Perpetual-Token': token } : {}) } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  }
  async function start(settings) {
    await writeFile(join(dataDir, 'browser-model.json'), JSON.stringify(settings), { mode: 0o600 });
    app = await startServer({ port: 0, dataDir, repo });
    token = (await request('/api/session')).body.token;
  }
  await start(unset);
  assert.equal((await request('/api/scan', { method: 'POST', body: { path: repo } })).status, 200);
  const added = await request('/api/pipeline/action', { method: 'POST', body: { repoPath: repo, action: 'add-stage', name: 'Beta' } });
  const beta = added.body.pipeline.stages.find(stage => stage.name === 'Beta').id;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const services = async (query = {}) => request(`/api/twin/services?${new URLSearchParams({ repoPath: repo, stageId: beta, ...query })}`);
  const scope = new URLSearchParams({ repoPath: repo, stageId: beta });
  const savePlan = async edit => request('/api/environments/plan', { method: 'POST', body: { repoPath: repo, stageId: beta, plan: edit((await request(`/api/environments?${scope}`)).body.plan) } });
  return { dataDir, repo, request, services, savePlan, restart: async settings => { await app.close(); await start(settings); } };
}

const byId = services => Object.fromEntries(services.map(service => [service.id, service]));

test('Services lists the stage twin config with only missing inputs and never file values', async t => {
  const f = await fixture(t);
  const result = await f.services();
  assert.equal(result.status, 200);
  const services = byId(result.body.services);
  for (const id of ['redis', 'mongodb', 'mailpit', 'llm', 'supabase', 'stripe']) assert.ok(services[id], id);
  assert.equal(services['trigger-dev'], undefined);
  assert.equal(services.postgres, undefined, 'Supabase includes PostgreSQL.');
  assert.deepEqual(services.stripe, { id: 'stripe', title: 'Stripe', fidelity: 'official-sandbox', blocked: true, missing: [{ name: 'secretKey', label: 'Stripe test secret key', secret: true }] });
  assert.deepEqual(services.mailpit, { id: 'mailpit', title: 'Mailpit', fidelity: 'actual', blocked: false, missing: [] });
  assert.equal(services.supabase.fidelity, 'official-sandbox');
  // The LLM takes App Settings by default; without a model there it is blocked with nothing to connect here.
  assert.deepEqual(services.llm, { id: 'llm', title: 'LLM', fidelity: 'actual', source: 'settings', blocked: true, missing: [] });
  assert.ok(!result.text.includes(EXAMPLE_SECRET) && !result.text.includes(PRIVATE_KEY));

  // The stage's saved config, not a fresh detection, decides the list.
  assert.equal((await f.savePlan(plan => ({ ...plan, services: { mailpit: {}, llm: { source: 'app' } } }))).status, 200);
  const edited = (await f.services()).body.services;
  assert.deepEqual(edited.map(service => service.id), ['mailpit', 'llm']);
  // With the app's own values chosen, the LLM connects its inputs here.
  assert.deepEqual(edited[1].missing.map(input => [input.name, input.secret]), [['OPENAI_BASE_URL', false], ['OPENAI_API_KEY', true], ['OPENAI_MODEL', false]]);
  assert.equal(edited[1].source, undefined);

  assert.equal((await f.services({ repoPath: join(f.repo, 'other') })).status, 409);
  const production = await f.services({ stageId: 'production' });
  assert.equal(production.status, 400);
  assert.match(production.body.error, /Choose a Sandbox stage/);
});

test('The LLM is not blocked once App Settings has a model', async t => {
  const f = await fixture(t);
  await f.restart(configured);
  const { llm } = byId((await f.services()).body.services);
  assert.deepEqual(llm, { id: 'llm', title: 'LLM', fidelity: 'actual', source: 'settings', blocked: false, missing: [] });
});

test('Inputs are saved with the session token, validated by the service and shown only as set', async t => {
  const f = await fixture(t);
  const empty = (await f.request('/api/twin/inputs')).body.services.find(service => service.id === 'stripe');
  assert.deepEqual(empty.inputs.map(input => [input.name, input.set]), [['secretKey', false], ['publishableKey', false]]);

  const body = { service: 'stripe', inputs: { secretKey: STRIPE_KEY } };
  assert.equal((await f.request('/api/twin/inputs', { method: 'PUT', body, withToken: false })).status, 403);
  assert.equal((await f.request('/api/twin/inputs', { method: 'POST', body })).status, 404);
  const invalid = await f.request('/api/twin/inputs', { method: 'PUT', body: { service: 'stripe', inputs: { secretKey: 'sk_live_real_value' } } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'Stripe test secret key does not have the expected format.');
  assert.equal((await f.request('/api/twin/inputs', { method: 'PUT', body: { service: 'unknown', inputs: {} } })).status, 400);

  const saved = await f.request('/api/twin/inputs', { method: 'PUT', body });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.services.find(service => service.id === 'stripe').inputs[0].set, true);
  const view = await f.request('/api/twin/inputs');
  const services = await f.services();
  for (const text of [saved.text, view.text, services.text]) assert.equal(text.includes(STRIPE_KEY), false);
  assert.deepEqual([byId(services.body.services).stripe.blocked, byId(services.body.services).stripe.missing], [false, []]);
  assert.equal((await stat(join(f.dataDir, 'twin-inputs.json'))).mode & 0o777, 0o600);
});
