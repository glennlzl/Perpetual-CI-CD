import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceOptionErrors, validateTwinConfig } from '../src/twin/config.ts';
import { services as registry } from '../src/twin/registry.ts';
import { detectTwinConfig, envNames, nodeMajor } from '../src/twin/detect.ts';
import { APP_IMAGE } from '../src/twin/compose.ts';
import { services } from './fixtures/twin/services.ts';
import type { TwinService } from '../src/twin/registry.ts';

test('Detection proposes services from packages, variable names and files, and apps from the scan', () => {
  const proposal = detectTwinConfig({
    files: ['README.md', 'backend/db/schema.sql', 'db/schema.sql.bak'],
    packages: ['react', 'payments-sdk'],
    env: ['SMTP_HOST', 'UNRELATED'],
    apps: [{ id: 'service:Web App', directory: 'web', build: 'pnpm build', start: 'pnpm start', port: 3000 }, { id: 'api', directory: 'api', port: 8080 }],
  }, { services });
  assert.deepEqual(proposal, {
    services: { database: { directory: 'backend/db' }, mail: {}, payments: {} },
    apps: { 'service-web-app': { directory: 'web', build: 'pnpm build', start: 'pnpm start', port: 3000 } },
  });
  assert.deepEqual(validateTwinConfig(proposal, { services }).services, proposal.services);
  assert.deepEqual(detectTwinConfig({}, { services }), { services: {}, apps: {} });
  assert.deepEqual(detectTwinConfig({ files: ['db/schema.sql'] }, { services }).services, { database: { directory: 'db' } });
});

test('Detection keeps the install its apps share and leaves the install name to it', () => {
  const apps = [{ id: 'install', start: 'node a', port: 1 }, { id: 'web', directory: 'apps/web', start: 'npm run start', port: 3000 }];
  const proposal = detectTwinConfig({ apps, install: { directory: '.', command: 'npm ci' } }, { services });
  assert.deepEqual(proposal, { services: {}, apps: { web: { directory: 'apps/web', start: 'npm run start', port: 3000 } }, install: { directory: '.', command: 'npm ci' } });
  assert.deepEqual(validateTwinConfig(proposal, { services }).install, proposal.install);
  assert.deepEqual(Object.keys(detectTwinConfig({ apps }, { services }).apps), ['install', 'web']);
});

test('Every service a repository shows is proposed with options its own checks accept', () => {
  for (const service of Object.values(registry)) {
    const detect = service.detect ?? {};
    for (const evidence of [{ packages: (detect.packages ?? []).filter(pattern => typeof pattern === 'string').slice(0, 1) }, { files: (detect.files ?? []).filter(pattern => typeof pattern === 'string').slice(0, 1) }]) {
      if (!Object.values(evidence)[0].length) continue;
      const proposal = detectTwinConfig(evidence);
      assert.ok(Object.hasOwn(proposal.services, service.id), `${service.id} ${JSON.stringify(evidence)}`);
      assert.deepEqual(serviceOptionErrors(validateTwinConfig(proposal)), [], `${service.id} ${JSON.stringify(evidence)}`);
    }
  }
  // emulate runs the vendors the repository shows.
  assert.deepEqual(detectTwinConfig({ env: ['AWS_REGION'] }).services, { emulate: { services: ['aws'] } });
  assert.deepEqual(detectTwinConfig({ packages: ['googleapis', 'octokit'], env: ['LINEAR_API_KEY'] }).services, { emulate: { services: ['github', 'google', 'linear'] } });
});

test('Environment files contribute names only', () => {
  const text = '# comment\nDATABASE_URL=postgres://user:secret@host/db\nexport SMTP_HOST="mail"\n  PAYMENTS_KEY=\nnot a line\nDATABASE_URL=again\n';
  assert.deepEqual(envNames(text), ['DATABASE_URL', 'SMTP_HOST', 'PAYMENTS_KEY']);
});

test('A detected service supersedes the services it includes', () => {
  const platform = { id: 'platform', title: 'Platform', fidelity: 'official-sandbox', detect: { files: ['platform/config.toml'] }, includes: ['database', 'mail'], env: () => ({}) } satisfies TwinService;
  const withPlatform = { ...services, platform };
  const evidence = { files: ['app/platform/config.toml'], packages: ['pg', 'payments-sdk'], env: ['SMTP_HOST'] };
  assert.deepEqual(detectTwinConfig(evidence, { services: withPlatform }).services, { payments: {}, platform: { directory: 'app/platform' } });
  // Without the including service, the included ones are proposed as usual.
  assert.deepEqual(Object.keys(detectTwinConfig({ ...evidence, files: [] }, { services: withPlatform }).services), ['database', 'mail', 'payments']);
});

test('A Node.js range runs on the newest maintained major it admits, and a pinned version on its own', () => {
  const cases: [string, number | undefined][] = [
    // A range that admits a maintained LTS major gets the newest one, never an end-of-life major it also admits.
    ['>=18', 24], ['>=16', 24], ['>=14', 24], ['>=20', 24], ['^18.18.0 || ^19.8.0 || >= 20.0.0', 24], ['^20.19.0 || >=22.12.0', 24],
    ['^22.11.0 || ^24', 24], ['^22.11', 22], ['<23', 22], ['>=18 <24', 22], ['22.x', 22], ['v22.11.0', 22], ['24', 24],
    // One that admits none gets the current release when it admits it, never an end-of-life major below it.
    ['26.1.0', 26], ['>=25', 26], ['>24', 26], ['>=26', 26], ['>=25 <27', 26], ['^25 || ^26', 26], ['^25 || >=26', 26],
    // Else the newest released major it admits, one that was an LTS before an odd one, which runs only when pinned.
    ['^16 || ^18', 18], ['18 - 20', 20], ['~20.1', 20], ['20', 20], ['>=20 <22', 20], ['^25', 25], ['25.x', 25], ['>=21 <22', 21],
    // A range above every release gets the first major it admits.
    ['>=27', 27],
    // Nothing to read a major from, or none from 18.
    ['*', undefined], ['lts/*', undefined], ['node', undefined], ['^16', undefined], ['<18', undefined], ['>=18 <18', undefined], ['18 or later', undefined], [' ', undefined],
  ];
  assert.deepEqual(cases.map(([range]) => [range, nodeMajor(range)]), cases);
  for (const value of [undefined, 22, 'x'.repeat(201)]) assert.equal(nodeMajor(value), undefined, String(value));
  assert.equal(APP_IMAGE, `node:${nodeMajor('>=18')}-bookworm-slim`, 'A config without a major runs on the newest LTS too.');
});
