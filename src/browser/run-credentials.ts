/** A test account for one admitted execution. */
export type RunCredentials = { username: string; password: string };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Credentials belong to one admitted execution, never a saved case or config.
export function validateRunCredentials(value: unknown): RunCredentials | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || Object.keys(value).some(key => !['username', 'password'].includes(key))
    || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 320
    || typeof value.password !== 'string' || !value.password || value.password.length > 1024
    || /[\x00-\x1f\x7f]/.test(value.username + value.password)) {
    throw new Error('Provide a test account with a username and password.');
  }
  return { username: value.username, password: value.password };
}
