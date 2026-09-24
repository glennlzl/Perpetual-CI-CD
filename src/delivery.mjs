const PROVIDERS = new Map([
  ['github', 'GitHub'],
  ['vercel', 'Vercel'],
  ['railway', 'Railway'],
]);

function knownProvider(value) {
  return typeof value === 'string' ? PROVIDERS.get(value.trim().toLowerCase()) : undefined;
}

export function withDeliveryGraph(scan) {
  if (scan == null) return scan;
  const nodes = Array.isArray(scan.nodes) ? scan.nodes : [];
  const source = nodes.filter(node => node?.kind === 'repository');
  const buildDeploy = [];
  const hasGitHub = (Array.isArray(scan.workflows) && scan.workflows.length > 0) ||
    nodes.some(node => node?.kind === 'workflow' || node?.kind === 'job') ||
    source.some(node => knownProvider(node.provider) === 'GitHub');
  if (hasGitHub) buildDeploy.push({ id: 'github-actions', kind: 'github-actions', provider: 'GitHub', label: 'GitHub' });

  const deployments = nodes.filter(node => node?.kind === 'deployment');
  const seen = new Set();
  const groups = new Map();
  // Running a workflow never replaces a deployment target: retain each target once.
  for (const deployment of deployments) {
    const identity = typeof deployment.id === 'string' ? deployment.id : deployment;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const provider = knownProvider(deployment.provider);
    if (!provider) {
      buildDeploy.push(deployment);
      continue;
    }
    let group = groups.get(provider);
    if (!group) {
      group = { id: `deployment-provider:${encodeURIComponent(provider.toLowerCase())}`, kind: 'deployment-group', provider, label: provider, deployments: [] };
      groups.set(provider, group);
      buildDeploy.push(group);
    }
    group.deployments.push(deployment);
  }

  // Application packages stay in the scan. Only workflow runners and discovered
  // deployment targets belong to Build & Deploy; an unbound service is neither.
  return { ...scan, delivery: { version: 1, source, buildDeploy } };
}
