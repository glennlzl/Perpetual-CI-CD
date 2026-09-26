// The operations behind pi's own read, write, edit and bash tools, over a repair box: every file read, file write and
// command runs through box.exec (docker exec in the bench box), never on the host. A command gets the box's own
// environment, never the host environment pi hands its operations, and runs as `bash -c` in the directory pi names,
// with the product's run-tool timeouts: 300 s unless pi passes one, and at most 900 s. pi's bash tool keeps the tail
// of a long output and saves the whole of it to a log in the host's temp folder, naming that path to the model;
// relocate() moves the log into the box at that same path, where the model's reads go, and removes it from the host.
import { readFile as readHost, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from '@earendil-works/pi-coding-agent';
import type { BoxResult, RepairBox } from '../../../../src/repair/box.ts';

/** The largest file a read returns, the output a command keeps (its tail), a file operation's time, and command times. */
export const LIMITS = { readBytes: 32 * 1024 * 1024, outputBytes: 1024 * 1024, fileMs: 120_000, defaultSeconds: 300, maxSeconds: 900 };
/** What the attempt learns from the operations: each command's exit code, and each file a tool wrote. */
export interface OperationEvents { run?(command: string, exitCode: number): void; change?(path: string): void }
export interface BoxOperations {
  read: ReadOperations; write: WriteOperations; edit: EditOperations; bash: BashOperations;
  /** Moves a log pi's bash tool wrote to the host's temp folder into the box at the same path, and removes it here. */
  relocate(path: string | undefined): Promise<void>;
}

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const reason = (result: BoxResult) => (result.stderr || result.stdout).trim().split('\n')[0]?.slice(0, 300) || `exit ${result.exitCode}`;
/** The log a failed command's message names: the last "Full output" notice, which pi appends after the output. */
export const loggedOutput = (message: string) => [...message.matchAll(/Full output: ([^\n\]]+)\]/g)].at(-1)?.[1];
const PI_LOG = /^pi-bash-[0-9a-f]{16}\.log$/;

export function boxOperations(box: RepairBox, { signal, events = {} }: { signal?: AbortSignal; events?: OperationEvents } = {}): BoxOperations {
  const file = (script: string, path: string, options: { stdin?: string; limit?: number } = {}) => box.exec(['sh', '-c', script, 'sh', path], { signal, timeoutMs: LIMITS.fileMs, ...options });
  // As pi's local access() does: missing is ENOENT, and not readable (or writable, for edit) is EACCES.
  const access = (test: string) => async (path: string) => {
    const result = await file(`[ -e "$1" ] || exit 2; ${test} || exit 13`, path);
    if (result.exitCode === 2) throw failure('ENOENT', `ENOENT: no such file or directory, access '${path}'`);
    if (result.exitCode === 13) throw failure('EACCES', `EACCES: permission denied, access '${path}'`);
    if (result.exitCode !== 0) throw new Error(`Could not check ${path}: ${reason(result)}`);
  };
  async function readFile(path: string) {
    const result = await file('[ -e "$1" ] || exit 2; [ -d "$1" ] && exit 21; exec cat -- "$1"', path, { limit: LIMITS.readBytes });
    if (result.exitCode === 2) throw failure('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    if (result.exitCode === 21) throw failure('EISDIR', 'EISDIR: illegal operation on a directory, read');
    if (result.exitCode !== 0) throw new Error(`Could not read ${path}: ${reason(result)}`);
    if (result.truncated) throw new Error(`${path} is larger than ${LIMITS.readBytes / 1024 / 1024} MB; read parts of it with bash, such as sed -n or head.`);
    return Buffer.from(result.stdout, 'utf8');
  }
  async function writeFile(path: string, content: string) {
    const result = await file('[ -d "$1" ] && exit 21; cat > "$1"', path, { stdin: content });
    if (result.exitCode === 21) throw failure('EISDIR', `EISDIR: illegal operation on a directory, open '${path}'`);
    if (result.exitCode !== 0) throw new Error(`Could not write ${path}: ${reason(result)}`);
    events.change?.(path);
  }
  async function mkdir(path: string) {
    const result = await file('mkdir -p -- "$1"', path);
    if (result.exitCode !== 0) throw new Error(`Could not create ${path}: ${reason(result)}`);
  }
  const bash: BashOperations = {
    // options.env is the host environment pi builds for a local shell; the box keeps its own.
    async exec(command, cwd, { onData, signal: turn, timeout }) {
      const seconds = Math.min(typeof timeout === 'number' && timeout > 0 ? Math.ceil(timeout) : LIMITS.defaultSeconds, LIMITS.maxSeconds);
      const stop = turn && signal ? AbortSignal.any([turn, signal]) : turn ?? signal;
      let result: BoxResult;
      try { result = await box.exec(['bash', '-c', 'exec 2>&1; cd -- "$1" && eval "$2"', 'bash', cwd, command], { signal: stop, timeoutMs: seconds * 1000, limit: LIMITS.outputBytes, keep: 'tail' }); }
      catch (error) { if (stop?.aborted) throw new Error('aborted'); throw error; }
      const output = result.stdout + result.stderr;
      if (output) onData(Buffer.from(output, 'utf8'));
      events.run?.(command, result.exitCode);
      // pi's bash tool reads these messages: "timeout:N" becomes "Command timed out after N seconds".
      if (result.timedOut) throw new Error(`timeout:${seconds}`);
      return { exitCode: result.exitCode };
    },
  };
  return {
    read: { readFile, access: access('[ -r "$1" ]'), detectImageMimeType: async () => null },
    write: { writeFile, mkdir },
    edit: { readFile, writeFile, access: access('[ -r "$1" ] && [ -w "$1" ]') },
    bash,
    async relocate(path) {
      if (!path || dirname(path) !== tmpdir() || !PI_LOG.test(basename(path))) return;
      try { await box.exec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path], { stdin: await readHost(path, 'utf8'), signal, timeoutMs: LIMITS.fileMs }); }
      catch { /* then the model finds no log in the box, as with pi's own remote tools */ }
      finally { await rm(path, { force: true }); }
    },
  };
}
