// Stands in for `opencode run --agent twin-author` in tests: no network, no model. It records what the controller gave it
// (never the key's value), then plays the scripted attempt: attempt n is the script's nth action, n counted from the log.
// Usage: node fake-twin-author.ts <script.json> <log.jsonl> <prompt> <model>
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One attempt: write twin.json as JSON or raw text, change another file, fail with the key in its output, stop with a
 * provider's `Error:` line as OpenCode reports one, hang, or hang ignoring SIGTERM. `stall` runs on after the rest,
 * printing its progress, until the attempt's time limit stops it.
 */
export type AuthorAction = { write?: unknown; raw?: string; touch?: string; fail?: boolean; error?: string; hang?: boolean; stubborn?: boolean; stall?: boolean };
type OpenCodeProject = { permission: unknown; snapshot: unknown; lsp: unknown; formatter: unknown; instructions: unknown; agent: Record<string, unknown>; provider: unknown };

const [script, log, prompt, model] = process.argv.slice(2), env = process.env;
const attempt = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
const action = (JSON.parse(readFileSync(script, 'utf8')) as AuthorAction[])[attempt] ?? {};
const opencode = JSON.parse(readFileSync('opencode.json', 'utf8')) as OpenCodeProject;
const mode = (file: string) => statSync(file).mode & 0o777;
const record = (extra: object) => appendFileSync(log, `${JSON.stringify({
  attempt, prompt, model, cwd: process.cwd(), workspaceMode: mode('..'), git: readFileSync('.git', 'utf8'),
  draft: readFileSync('twin.json', 'utf8'), feedback: existsSync('feedback.md') ? readFileSync('feedback.md', 'utf8') : null,
  instructions: readFileSync('TWIN.md', 'utf8'), evidence: readFileSync('EVIDENCE.md', 'utf8'), repo: readFileSync(join('repo', 'package.json'), 'utf8'),
  modes: { instructions: mode('TWIN.md'), evidence: mode('EVIDENCE.md'), opencode: mode('opencode.json'), repo: mode(join('repo', 'package.json')), git: mode('.git'), config: mode('twin.json'), ...(existsSync('feedback.md') ? { feedback: mode('feedback.md') } : {}) },
  opencode: { permission: opencode.permission, snapshot: opencode.snapshot, lsp: opencode.lsp, formatter: opencode.formatter, instructions: opencode.instructions, agent: opencode.agent, provider: opencode.provider },
  env: { key: Boolean(env.OPENROUTER_API_KEY), home: env.HOME, homeBeside: dirname(env.HOME ?? '') === dirname(process.cwd()), claude: env.OPENCODE_DISABLE_CLAUDE_CODE, autoupdate: env.OPENCODE_DISABLE_AUTOUPDATE,
    names: Object.keys(env).filter(name => !['PATH', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING'].includes(name)).sort() },
  ...extra,
})}\n`);

if (action.hang) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  record({ pids: [process.pid, child.pid] });
  setInterval(() => {}, 1000);
} else if (action.stubborn) {
  // Only a forced termination stops it, after which its cleanup cannot be confirmed.
  process.on('SIGTERM', () => {});
  record({ pids: [process.pid] });
  setInterval(() => {}, 1000);
} else {
  record({});
  if (action.fail) {
    process.stderr.write(`Provider rejected key ${env.OPENROUTER_API_KEY}\n`);
    process.exit(3);
  }
  if (action.error) {
    process.stdout.write(`✱ Grep "API_KEY" in repo · 3 matches\nError: ${action.error}\n`);
    process.exit(1);
  }
  if (action.touch) {
    if (existsSync(action.touch)) chmodSync(action.touch, 0o644);
    writeFileSync(action.touch, 'changed by the author\n');
  }
  if (action.raw !== undefined) writeFileSync('twin.json', action.raw);
  else if (action.write !== undefined) writeFileSync('twin.json', `${JSON.stringify(action.write, null, 2)}\n`);
  if (action.stall) {
    process.stdout.write(`✗ Grep "" failed with key ${env.OPENROUTER_API_KEY}\n→ Read repo/package.json\n`);
    setInterval(() => {}, 1000);
  }
}
