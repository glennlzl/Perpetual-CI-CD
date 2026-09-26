// The Codex CLI (@openai/codex, the OpenAI track): OpenAI's own agent loop, tools, base instructions and compaction,
// run INSIDE the bench box as headless `codex exec --json` from its pinned Linux build, which prepare() copies in
// untimed (release.ts). Its one model provider is the gateway's Responses route through the relay
// (http://gateway:8080/api/v1/responses), keyed by the attempt's token. The token reaches only Codex's own process,
// over stdin: never argv, a file, a command's environment or a log. The product's prompt is the task, byte for byte;
// INSTRUCTIONS and the harness note are developer instructions beside Codex's own. Codex has no turn limit of its own,
// so the gateway's request limit stands in for limits.steps. Its JSONL events become the shared outcome (codex.ts).
import { egressEnvironment } from '../../../../src/repair/egress.ts';
import { gatewayEnvironment, type BenchBox } from '../../box.ts';
import { appendedInstructions, type Adapter, type AttemptOutcome } from '../../harness.ts';
import { CODEX, configToml, launchArgv, readEvents, readRun } from './codex.ts';
import { RELEASE, codexRelease, platformOf, tarAvailable } from './release.ts';

/** Bytes of Codex's stdout (its events) and of its stderr the bench keeps, from their start. */
const OUTPUT_LIMIT = 64 * 1024 * 1024;

async function must(box: BenchBox, argv: readonly string[], failure: string, options: Parameters<BenchBox['exec']>[1] = {}) {
  const result = await box.exec(argv, { timeoutMs: 60_000, ...options });
  if (result.exitCode !== 0) throw new Error(`${failure}: ${(result.stderr || result.stdout).trim().split('\n')[0] || `exit ${result.exitCode}`}`);
  return result;
}

export const adapter: Adapter = {
  key: 'codex', version: `${RELEASE.name}@${RELEASE.version}`, inBox: true, providers: { openai: 'responses' },
  async available() { return await tarAvailable() ? null : 'Install tar, which unpacks the pinned Codex release.'; },
  async prepare(box, signal) {
    const machine = (await must(box, ['uname', '-m'], 'Could not read the box\'s machine', { signal })).stdout.trim();
    const platform = platformOf(machine);
    if (!platform) throw new Error(`Codex ${RELEASE.version} has no Linux build for ${machine || 'this machine'}.`);
    const folder = await codexRelease(platform, { signal });
    await must(box, ['mkdir', '-p', '/opt/bench', CODEX.home], 'Could not create Codex\'s folders', { signal });
    await box.copyIn(folder, CODEX.root);
    const version = await must(box, ['env', `CODEX_HOME=${CODEX.home}`, CODEX.bin, '--version'], 'Codex does not start in the box', { signal });
    if (!version.stdout.includes(RELEASE.version)) throw new Error(`The box runs ${version.stdout.trim() || 'an unknown Codex'}, not Codex ${RELEASE.version}.`);
  },
  async runAttempt({ box, system, prompt, failing, model, gateway, limits, signal, log }): Promise<AttemptOutcome> {
    if (!gateway.boxUrl) throw new Error('Codex runs in the box and needs the gateway relay.');
    const config = configToml({ model: model.id, contextWindow: model.contextWindow, baseUrl: gateway.boxUrl, instructions: appendedInstructions('codex', system), proxy: egressEnvironment() });
    await must(box, ['sh', '-c', 'cat > "$1"', 'sh', `${CODEX.home}/config.toml`], 'Could not write Codex\'s config', { stdin: config, signal });
    // The box's own time limit stops Codex, and its events so far stay readable.
    const result = await box.exec(launchArgv(box.root, gatewayEnvironment()), { stdin: `${gateway.token}\n${prompt}`, timeoutMs: limits.timeMs, signal, limit: OUTPUT_LIMIT });
    const run = readRun(readEvents(result.stdout), failing, result);
    run.events.forEach(event => log(event));
    log({ type: 'attempt', end: run.end, steps: run.steps, turn: run.turn, usage: run.usage, reproduced: run.reproduced, exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated,
      ...(run.end === 'done' || run.end === 'idle' ? {} : { stderr: result.stderr.trim().slice(-2000) }) });
    return { reason: run.end, steps: run.steps, summary: run.summary, reproduced: run.reproduced, ...(run.error ? { error: run.error } : {}) };
  },
};
