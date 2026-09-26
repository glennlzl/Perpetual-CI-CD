import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanRepository } from '../src/scanner.ts';
import { twinReport } from '../src/twin/report.ts';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perpetual-twin-report-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = path.join(root, 'repo');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoPath, name)), { recursive: true });
    await writeFile(path.join(repoPath, name), content);
  }
  return repoPath;
}

test('the twin report names each supplied service with its provenance, evidence and inputs, and the variables no service provides', async t => {
  const repoPath = await fixture(t, {
    'package.json': JSON.stringify({ name: 'web', dependencies: { express: '5.0.0', pg: '8.0.0', stripe: '14.0.0', resend: '3.0.0' }, scripts: { start: 'node server.js' } }),
    'server.js': 'const mail = process.env.RESEND_API_KEY, stripe = process.env.STRIPE_SECRET_KEY, db = process.env.DATABASE_URL;\n',
    '.env.example': 'DATABASE_URL=\nSTRIPE_SECRET_KEY=\nRESEND_API_KEY=\n',
  });
  const report = await twinReport(await scanRepository(repoPath));
  assert.equal(report.repo.path, repoPath);
  assert.ok(Object.keys(report.config.apps).length, 'The app the twin starts.');
  const [postgres, stripe] = ['postgres', 'stripe'].map(id => report.services.find(service => service.id === id)!);
  assert.equal(postgres.fidelity, 'actual');
  assert.deepEqual(postgres.evidence, { files: [], packages: ['pg'], env: [] });
  assert.deepEqual(postgres.inputs, []);
  assert.ok(postgres.provides.includes('DATABASE_URL'));
  assert.equal(stripe.fidelity, 'official-sandbox');
  assert.deepEqual(stripe.evidence, { files: [], packages: ['stripe'], env: ['STRIPE_SECRET_KEY'] });
  assert.ok(stripe.inputs.length && stripe.inputs.every(input => input.name && input.label), 'Stripe takes the keys a person supplies.');
  assert.equal(stripe.provision, true, 'Perpetual can create a Stripe sandbox when asked.');
  assert.ok(!report.services.some(service => service.id === 'mailpit'), 'Resend is no twin service.');
  // DATABASE_URL and STRIPE_SECRET_KEY come from the services; Resend's key comes from nothing.
  assert.ok('apps' in report.unwired);
  assert.deepEqual(report.unwired.apps.map(app => app.unwired.map(({ name, example }) => ({ name, example }))), [[{ name: 'RESEND_API_KEY', example: '.env.example' }]]);
  assert.equal(report.unwired.apps[0].unwired[0].file, 'server.js');
});

test('a repository with no detected service reports none and no unwired variable of an app it has none of', async t => {
  const repoPath = await fixture(t, { 'README.md': '# Docs only\n' });
  const report = await twinReport(await scanRepository(repoPath));
  assert.deepEqual(report.services, []);
  assert.deepEqual(report.config.apps, {});
  assert.ok('apps' in report.unwired && report.unwired.apps.length === 0);
});
