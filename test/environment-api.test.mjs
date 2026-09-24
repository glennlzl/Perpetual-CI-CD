import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {startServer} from '../src/server.mjs';

const plan = () => ({services: {mailpit: {}}, apps: {web: {directory: '.', start: 'node app.mjs', port: 3000, env: {MODE: 'test'}}}, fixtures: []});
const legacyPlan = () => ({version: 1, services: [{id: 'web', name: 'Fixture app', directory: '.', installCommand: '', startCommand: 'node app.mjs', port: 3000, readyPath: '/health', env: {MODE: 'test'}}]});
// Detected from each fixture repository's Express package and its dev script.
const detected = {services: {}, apps: {service: {directory: '.', build: 'npm install', start: 'npm run dev', port: 3000}}};

async function controller(t) {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-environment-api-'));
  const dataDir = join(directory, 'controller-data');
  const repos = [join(directory, 'source-a'), join(directory, 'source-b')];
  for (const [index, repo] of repos.entries()) {
    await mkdir(repo);
    await writeFile(join(repo, 'package.json'), JSON.stringify({name: `fixture-${index}`, scripts: {dev: 'node app.mjs'}, dependencies: {express: 'fixture-only'}}));
    await writeFile(join(repo, 'app.mjs'), "// Plan fixture; this file is never executed.\napp.get('/health', (req, res) => res.json({status: 'ok'}));\n");
  }
  let app;
  let token;
  t.after(async () => { try { await app?.close(); } finally { await rm(directory, {recursive: true, force: true}); } });
  async function request(path, {method = 'GET', body, headers = {}, session = true} = {}) {
    const response = await fetch(`${app.url}${path}`, {method, headers: {
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(session && method === 'POST' ? {'X-Perpetual-Token': token} : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    const text = await response.text();
    return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
  }
  async function start() {
    app = await startServer({port: 0, repo: repos[0], dataDir});
    assert.ok(![4317, 4318].includes(Number(new URL(app.url).port)));
    token = (await request('/api/session')).body.token;
  }
  async function scan(repo = repos[0]) {
    const result = await request('/api/scan', {method: 'POST', body: {path: repo}});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function stage(name, repo = repos[0]) {
    const result = await request('/api/pipeline/action', {method: 'POST', body: {repoPath: repo, action: 'add-stage', name}});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.pipeline.stages.find(item => item.name === name).id;
  }
  const query = (repoPath, stageId) => new URLSearchParams({repoPath, stageId}).toString();
  const view = (stageId, repoPath = repos[0]) => request(`/api/environments?${query(repoPath, stageId)}`);
  const post = (operation, stageId, body = {}, repoPath = repos[0]) => request(`/api/environments/${operation}`, {method: 'POST', body: {repoPath, stageId, ...body}});
  await start();
  await scan();
  const beta = await stage('Beta');
  const gamma = await stage('Gamma');
  return {request, view, post, scan, stage, query, repos, beta, gamma, dataDir,
    get token() { return token; }, get url() { return app.url; },
    async restart(editState) {
      await app.close();
      if (editState) {
        const file = join(dataDir, 'environments', 'state.json');
        const state = JSON.parse(await readFile(file, 'utf8'));
        await editState(state);
        await writeFile(file, JSON.stringify(state), {mode: 0o600});
      }
      await start();
    },
  };
}

test('environment API enforces same-origin session tokens before every mutation', async t => {
  const f = await controller(t);
  const initial = await f.view(f.beta);
  for (const operation of ['plan', 'create', 'destroy', 'logs']) {
    for (const token of [undefined, 'wrong-token']) {
      const denied = await f.request(`/api/environments/${operation}`, {method: 'POST', session: false, headers: token ? {'X-Perpetual-Token': token} : {}, body: {repoPath: f.repos[0], stageId: f.beta}});
      assert.equal(denied.status, 403, operation);
    }
  }
  const edited = plan(); edited.apps.web.port = 3100;
  const body = {repoPath: f.repos[0], stageId: f.beta, plan: edited};
  for (const headers of [{Origin: 'https://unrelated.example'}, {'Sec-Fetch-Site': 'cross-site'}]) {
    assert.equal((await f.request('/api/environments/plan', {method: 'POST', body, headers})).status, 403, JSON.stringify(headers));
  }
  // fetch normalizes Host; use the HTTP client to exercise an actual wrong host.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.url}/api/environments?${f.query(f.repos[0], f.beta)}`, {headers: {Host: 'unrelated.example'}}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request(`/api/environments?${f.query(f.repos[0], f.beta)}`, {headers: {Origin: 'https://unrelated.example'}})).status, 403);
  assert.equal((await f.request('/api/environments/plan', {method: 'POST', body, headers: {Origin: f.url}})).status, 200);
  const current = await f.view(f.beta);
  assert.equal(current.body.plan.apps.web.port, 3100);
  assert.deepEqual(current.body.environments, initial.body.environments);
});

test('environment plans are isolated by active source and Sandbox stage', async t => {
  const f = await controller(t);
  const edited = plan(); edited.apps.web.port = 3100;
  assert.equal((await f.post('plan', f.beta, {plan: edited})).status, 200);
  assert.deepEqual((await f.view(f.beta)).body.plan, edited);
  assert.deepEqual((await f.view(f.gamma)).body.plan, detected);
  assert.equal((await f.request('/api/environments')).status, 409);
  assert.equal((await f.view('production')).status, 400);
  assert.equal((await f.view('missing-stage')).status, 400);
  await f.scan(f.repos[1]);
  assert.equal((await f.view(f.beta)).status, 409);
  assert.equal((await f.post('plan', f.beta, {plan: edited})).status, 409);
  const betaB = await f.stage('Beta', f.repos[1]);
  assert.deepEqual((await f.view(betaB, f.repos[1])).body.plan, detected);
  await f.scan(f.repos[0]);
  assert.deepEqual((await f.view(f.beta)).body.plan, edited);
});

test('saved plans survive controller restart and the environment view exposes only environments and plan', async t => {
  const f = await controller(t);
  const edited = plan(); edited.apps.web.env.MODE = 'restart';
  assert.equal((await f.post('plan', f.beta, {plan: edited})).status, 200);
  const before = (await f.view(f.beta)).body;
  assert.deepEqual(Object.keys(before).sort(), ['environments', 'plan']);
  const oldToken = f.token;
  await f.restart();
  assert.notEqual(f.token, oldToken);
  assert.equal((await f.request('/api/environments/plan', {method: 'POST', headers: {'X-Perpetual-Token': oldToken}, body: {repoPath: f.repos[0], stageId: f.beta, plan: plan()}})).status, 403);
  assert.deepEqual((await f.view(f.beta)).body, before);
  const state = (await f.request('/api/state')).body;
  assert.equal(state.scan.repo.path, f.repos[0]);
  assert.equal(Object.hasOwn(state.capabilities, 'localSandbox'), false, 'Environments are Compose twins, not a Cua sandbox.');
});

test('invalid plans and environment requests are rejected before any environment work', async t => {
  const f = await controller(t);
  const initial = (await f.view(f.beta)).body;
  for (const mutate of [
    input => { input.apps.web.port = 0; },
    input => { input.apps.web.directory = '../outside'; },
    input => { input.apps.web.env['A-B'] = 'value'; },
    input => { input.services.unknown = {}; },
    input => { input.services.mailpit.webhook = '{{apps.missing.url}}'; },
    input => { input.services = [{id: 'web'}]; },
  ]) {
    const invalid = plan(); mutate(invalid);
    assert.equal((await f.post('plan', f.beta, {plan: invalid})).status, 400);
  }
  assert.deepEqual((await f.view(f.beta)).body.plan, initial.plan);
  for (const operation of ['destroy', 'logs']) assert.equal((await f.post(operation, f.beta, {id: randomUUID()})).status, 400, operation);
  // Scripted scenarios, fixture Twins, run evidence and the desktop view no longer exist.
  for (const operation of ['analyze', 'cases', 'run', 'schedule', 'schedule/stop', 'reset', 'snapshot', 'state', 'not-an-operation']) {
    assert.equal((await f.post(operation, f.beta, {id: randomUUID()})).status, 404, operation);
  }
  for (const path of [`runs/${randomUUID()}`, `artifacts/${randomUUID()}/evidence.json`, 'desktop']) {
    assert.equal((await f.request(`/api/environments/${path}?${f.query(f.repos[0], f.beta)}`)).status, 404, path);
  }
  assert.equal((await f.post('plan', f.beta, {plan: {services: {mailpit: {}}}})).status, 200);
  const create = await f.post('create', f.beta);
  assert.equal(create.status, 400);
  assert.match(create.body.error, /Add an app/);
  assert.deepEqual((await f.view(f.beta)).body.environments, []);
});

test('saved environments load without removed scenario, Twin and pre-twin plan state, stay scoped and never expose their plan', async t => {
  const f = await controller(t);
  const environmentId = randomUUID();
  const scope = createHash('sha256').update(`${f.repos[0]}\0${f.beta}`).digest('hex');
  const report = join(f.dataDir, 'environments', 'runs', randomUUID(), 'report.json');
  await mkdir(join(report, '..'), {recursive: true});
  await writeFile(report, JSON.stringify({results: []}));
  await f.restart(state => {
    state.plans[scope] = {...legacyPlan(), twins: [{id: 'mail', kind: 'mail'}]};
    state.environments.push({id: environmentId, scope, pipelineKey: f.repos[0], stageId: f.beta, repoPath: f.repos[0], status: 'failed', logs: 'Fixture preparation failed before Docker.',
      twinsToken: 'synthetic-secret-not-for-api', activeOperation: {operation: 'reset'}, desktopUrl: 'http://127.0.0.1:56080/', plan: {...legacyPlan(), twins: []}});
    Object.assign(state, {analyses: {[scope]: {mode: 'source'}}, cases: {[scope]: [{id: 'legacy-case'}]},
      runs: [{id: randomUUID(), scope, environmentId, status: 'running'}], schedules: [{id: randomUUID(), scope, environmentId, active: true}]});
  });
  const beta = (await f.view(f.beta)).body;
  assert.deepEqual(Object.keys(beta).sort(), ['environments', 'plan']);
  assert.deepEqual(beta.plan, detected, 'A pre-twin plan is replaced by a fresh detection.');
  assert.equal(beta.environments[0].id, environmentId);
  assert.equal(beta.environments[0].status, 'failed', 'A legacy active run does not change the environment.');
  for (const key of ['scope', 'plan', 'twinsToken', 'activeOperation', 'desktopUrl']) assert.equal(beta.environments[0][key], undefined, key);
  assert.ok(!JSON.stringify((await f.request('/api/state')).body).includes('synthetic-secret-not-for-api'));
  assert.deepEqual((await f.view(f.gamma)).body.environments, []);
  assert.equal((await f.post('logs', f.beta, {id: environmentId})).body.logs, 'Fixture preparation failed before Docker.');
  assert.equal((await f.post('logs', f.gamma, {id: environmentId})).status, 400);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'environments', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['environments', 'plans', 'version']);
  assert.ok(!JSON.stringify(saved).includes('synthetic-secret-not-for-api'));
  assert.ok(!JSON.stringify(saved).includes('twins'));
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {results: []}, 'Saved run evidence stays on disk.');
});
