import { posix } from 'node:path';

// Imported by service files too, so it depends on nothing else in the twin core.

/** A normalized repository-relative path; anything that leaves the repository is rejected. */
export function relative(value, where) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a path inside the repository.`);
  const path = posix.normalize(value.trim().replaceAll('\\', '/')).replace(/\/+$/, '') || '.';
  if (path.startsWith('/') || path === '..' || path.startsWith('../')) throw new Error(`${where} must stay inside the repository.`);
  return path;
}
