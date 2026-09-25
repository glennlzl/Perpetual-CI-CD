import type { Environment, EnvironmentHealth } from './test-workspace.ts';

// Environment readiness heartbeat. A monitor check is reachability only; it is
// never presented as a business test result.
export function relativeAge(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function healthLabel(health: EnvironmentHealth | null | undefined, now = Date.now()) {
  if (!health) return '';
  const checked = Date.parse(String(health.checkedAt)), skipped = Date.parse(String(health.skippedInUseAt));
  if (skipped && !(checked >= skipped)) return 'In use';
  if (!checked) return '';
  return `${health.ok === false ? 'Check failed' : 'Checked'} ${relativeAge(now - checked)} ago`;
}

export const healthWarning = (health: EnvironmentHealth | null | undefined) => Boolean(health && (health.ok === false || (health.consecutiveFailures ?? 0) > 0));

// One beat per new monitor check, keyed by its checkedAt. The first check seen
// for an environment stays still. The baseline lives above the stage card, so
// remounting the badge never resets it and never swallows a beat.
export function createHealthBeats() {
  const baselines = new Map<string, string>();
  return (environment: Partial<Environment> | null | undefined) => {
    if (!environment?.id) return '';
    const checkedAt = environment.health?.checkedAt || '';
    if (!baselines.has(environment.id)) baselines.set(environment.id, checkedAt);
    return checkedAt && checkedAt !== baselines.get(environment.id) ? checkedAt : '';
  };
}
