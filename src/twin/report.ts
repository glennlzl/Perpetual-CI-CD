// What a repository's twin would run, for a person or an agent deciding whether to create it: the config detection
// proposes, each detected service with its provenance, the evidence that found it and the inputs a user supplies, and
// the variables the apps read that no service provides. Names and paths only, never values; nothing runs.
import { repositoryFacts, unwiredVariables } from '../environments/evidence.ts';
import type { WorkList } from '../environments/evidence.ts';
import { repositoryDetection } from '../environments/plans.ts';
import type { Scan } from '../scanner.ts';
import { fileMatches, matches } from './detect.ts';
import type { DetectedConfig } from './detect.ts';
import { services as registry } from './registry.ts';
import type { Fidelity, Pattern, TwinServices } from './registry.ts';

/** A detected service as the report shows it. */
export interface ReportedService {
  id: string; title: string; fidelity: Fidelity; summary?: string;
  /** What in the repository found it: matching file paths, dependency names and example variable names. */
  evidence: { files: string[]; packages: string[]; env: string[] };
  /** Inputs the user supplies once, and whether Perpetual can create them when the user asks. */
  inputs: { name: string; label: string; optional: boolean }[]; provision: boolean;
  /** The standard variables it gives every app. */
  provides: string[];
}
export interface TwinReport { repo: Scan['repo']; config: DetectedConfig; services: ReportedService[]; unwired: WorkList }

const matching = (patterns: Pattern[] | undefined, values: string[] | undefined, test: (pattern: Pattern, value: string) => boolean) =>
  (values ?? []).filter(value => (patterns ?? []).some(pattern => test(pattern, value))).sort();

/** The report for a scanned repository: the twin config detection proposes, its services and the apps' unwired variables. */
export async function twinReport(scan: Scan, services: TwinServices = registry): Promise<TwinReport> {
  const { evidence, config } = await repositoryDetection(scan);
  const reported = Object.keys(config.services).filter(id => Object.hasOwn(services, id)).map((id): ReportedService => {
    const service = services[id], detect = service.detect ?? {};
    return {
      id, title: service.title, fidelity: service.fidelity, ...(service.describe ? { summary: service.describe.summary } : {}),
      evidence: { files: matching(detect.files, evidence.files, fileMatches), packages: matching(detect.packages, evidence.packages, matches), env: matching(detect.env, evidence.env, matches) },
      inputs: (service.inputs ?? []).map(input => ({ name: input.name, label: input.label ?? input.name, optional: input.optional === true })),
      provision: Boolean(service.provision), provides: service.describe?.provides ?? [],
    };
  });
  const draft = JSON.stringify(config), packages = scan.services.map(({ path, framework }) => ({ path, ...(framework ? { framework } : {}) }));
  // The repository is both the snapshot and the checkout whose example env files name the variables.
  const facts = await repositoryFacts({ source: scan.repo.path, checkout: scan.repo.path, packages, draft, services });
  return { repo: scan.repo, config, services: reported, unwired: unwiredVariables(facts, draft) };
}
