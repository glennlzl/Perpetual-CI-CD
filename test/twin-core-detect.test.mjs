import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTwinConfig } from '../src/twin/config.mjs';
import { detectTwinConfig, envNames } from '../src/twin/detect.mjs';
import { services } from './fixtures/twin/services.mjs';

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

test('Environment files contribute names only', () => {
  const text = '# comment\nDATABASE_URL=postgres://user:secret@host/db\nexport SMTP_HOST="mail"\n  PAYMENTS_KEY=\nnot a line\nDATABASE_URL=again\n';
  assert.deepEqual(envNames(text), ['DATABASE_URL', 'SMTP_HOST', 'PAYMENTS_KEY']);
});

test('A detected service supersedes the services it includes', () => {
  const platform = { id: 'platform', title: 'Platform', fidelity: 'official-sandbox', detect: { files: ['platform/config.toml'] }, includes: ['database', 'mail'], env: () => ({}) };
  const withPlatform = { ...services, platform };
  const evidence = { files: ['app/platform/config.toml'], packages: ['pg', 'payments-sdk'], env: ['SMTP_HOST'] };
  assert.deepEqual(detectTwinConfig(evidence, { services: withPlatform }).services, { payments: {}, platform: { directory: 'app/platform' } });
  // Without the including service, the included ones are proposed as usual.
  assert.deepEqual(Object.keys(detectTwinConfig({ ...evidence, files: [] }, { services: withPlatform }).services), ['database', 'mail', 'payments']);
});
