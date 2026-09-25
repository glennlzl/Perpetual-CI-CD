import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeliveryGraph } from '../src/delivery.ts';

test('Build holds the GitHub Actions runner and Production the configured deployment targets, grouped by known provider', () => {
  const railway = { id: 'railway:railway.toml', kind: 'deployment', provider: 'Railway', label: 'api deployment' };
  const vercel = { id: 'vercel:config:vercel.json', kind: 'deployment', provider: 'vercel', label: 'web deployment' };
  const other = { id: 'fly:fly.toml', kind: 'deployment', provider: 'Fly.io', label: 'worker deployment' };
  const repository = { id: 'repository', kind: 'repository', provider: 'GitHub', label: 'app' };
  // An application package is neither a runner nor a target, even when its provider is known.
  const scan = { workflows: [{ file: '.github/workflows/ci.yml' }], nodes: [repository, { id: 'package:web', kind: 'package', provider: 'Vercel', label: 'web' }, railway, vercel, other, { ...railway }] };
  const { delivery } = withDeliveryGraph(scan);
  assert.equal(delivery.version, 2);
  assert.deepEqual(delivery.source, [repository]);
  assert.deepEqual(delivery.build, [{ id: 'github-actions', kind: 'github-actions', provider: 'GitHub', label: 'GitHub Actions' }]);
  assert.deepEqual(delivery.production, [
    { id: 'deployment-provider:railway', kind: 'deployment-group', provider: 'Railway', label: 'Railway', deployments: [railway] },
    { id: 'deployment-provider:vercel', kind: 'deployment-group', provider: 'Vercel', label: 'Vercel', deployments: [vercel] },
    other,
  ], 'Each target appears once; an unknown provider keeps its own row.');
});

test('a repository without workflows or deployment targets has an empty Build and Production', () => {
  const { delivery } = withDeliveryGraph({ nodes: [{ id: 'repository', kind: 'repository', provider: null }, { id: 'package:api', kind: 'service' }] });
  assert.deepEqual([delivery.build, delivery.production], [[], []]);
});
