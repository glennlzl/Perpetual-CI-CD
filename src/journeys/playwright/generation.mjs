// Generates the actions of a reviewed journey's spec with Playwright's own generator agent (`playwright init-agents
// --loop=opencode`), run headlessly by OpenCode against OpenRouter. Perpetual writes no agent loop or MCP client: it
// prepares a private workspace, runs the harness, and accepts only code that validateJourneySpec accepts.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { browserError, superviseWorker } from '../../browser/runtime.mjs';
import { PLAYWRIGHT_CLI, PLAYWRIGHT_VERSION, journeyEnvironment, writeJourneyWorkspace } from './runtime.mjs';
import { specHash, validateJourneySpec } from './specs.mjs';

const exec = promisify(execFile);
export const OPENCODE_VERSION = '1.18.32', GENERATOR_AGENT = 'playwright-test-generator';
export const SEED = 'seed.spec.mjs', PLAN = 'specs/plan.md', TESTS = 'tests', TARGET = `${TESTS}/journey.spec.mjs`;
// The test MCP server exits before its Playwright worker finishes teardown, so OpenCode can exit first.
const TAIL = 4000, MAX_SPEC = 256 * 1024, SETTLE_MS = 10000;
export const CANCELLED = 'Code generation cancelled.';

// The workspace the caller owns holds three folders:
// - project: OpenCode's project and the test MCP server's root, its own git root with opencode.json, .opencode,
//   specs/plan.md and tests. generator_write_test writes only inside a Playwright project's testDir under this root,
//   and the only one is tests, which no project loads.
// - run: what the seed's Playwright process loads (config, `perpetual` shim, case snapshot and seed). It is outside
//   the root and read-only, so no file the generator writes runs beside the account or changes an import.
// - home: the harness's HOME, so OpenCode reads none of the user's global config, plugins, skills or instructions.
const workspaceFolders = workspace => ({ project: join(workspace, 'project'), run: join(workspace, 'run'), home: join(workspace, 'home') });

/** The default harness: OpenCode runs Playwright's generator agent once in the workspace. model is `openrouter/<id>`. */
export const opencodeHarness = ({ model, prompt }) => ({ command: 'npx', args: ['-y', `opencode-ai@${OPENCODE_VERSION}`, 'run', '--agent', GENERATOR_AGENT, '--model', model, prompt] });

/** The seed opens the application, as every journey starts, and signs in when the twin has a test account. */
export const seedSpec = signIn => `import { test } from 'perpetual';

// The fixture opens the application; a generated test starts the same way.
test('seed', async ({ page, journey }) => {
${signIn ? '  await journey.signIn();\n' : ''}});
`;

const MAX_REJECTED = 20000;
const line = value => String(value).replace(/\s+/g, ' ').trim();
/** The code rules of a generated spec: the grammar validateJourneySpec accepts, in the generator's terms. */
export function generationRules(item, { signIn }) {
  return [
    "Write JavaScript. The file starts with `import { test } from 'perpetual';` and imports nothing else.",
    `It contains exactly one \`test(${JSON.stringify(line(item.name))}, async ({ page, journey }) => { … });\`, with no \`test.describe\`, hooks or other statements.`,
    "Wrap the actions of each numbered step in `await journey.milestone('<milestone id>', async () => { … });`, one call per step, in order, with the literal milestone id.",
    ...(signIn ? ['Start the first milestone with `await journey.signIn();`, as the seed signs in. Never type the test account yourself.'] : []),
    'The test starts on the application URL, as the seed does.',
    'Write actions only: each statement in a milestone is one awaited Playwright action on `page`, its locators, `page.keyboard` or `page.mouse`, with literal arguments. No variables, `expect` or other assertions, waits for text, `evaluate`, requests, loops or conditions: Perpetual evaluates the reviewed checks itself.',
    'Prefer role, label or id locators from the log.',
  ];
}

/** specs/plan.md in the generator's test plan format: goal, numbered steps with their milestone ids, and the code rules. */
export function generationPlan(item, { signIn }) {
  const name = line(item.name);
  return [`# ${name}`, '', `**Seed:** \`${SEED}\``, '', `Goal: ${line(item.goal)}`, '', `### 1. ${name}`, '', `#### 1.1 ${name}`, '', '**Steps:**',
    ...item.steps.map((step, index) => `${index + 1}. ${line(step.title)} (milestone id: ${step.id})`), '',
    '**Code rules (required):**', ...generationRules(item, { signIn }).map(rule => `- ${rule}`), ''].join('\n');
}

export const generatePrompt = `Generate the test for the scenario in \`${PLAN}\` with the seed \`${SEED}\`, and write it with generator_write_test to \`${TARGET}\`. Follow the plan's code rules exactly.`;
/** A repair names only what validation rejected and the rules; the harness starts a new session for it. */
export const repairPrompt = (error, file, rules) => [`The test in \`${file}\` is invalid: ${error}`, '', 'Rules:', ...rules.map(rule => `- ${rule}`), '',
  `Set up the page with generator_setup_page for \`${PLAN}\` and \`${SEED}\`, then write the corrected test with generator_write_test to \`${file}\`.`].join('\n');

const pick = (values, keys) => Object.fromEntries(keys.filter(key => typeof values[key] === 'string').map(key => [key, values[key]]));
const fingerprint = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));

// The project is its own git root, so neither instructions nor files above it belong to it.
async function prepare({ project, run, home, item, targetUrl, timeoutSeconds, model, signIn, values, userHome, signal }) {
  const seedDir = join(run, 'seed');
  for (const dir of [join(project, 'specs'), join(project, TESTS), seedDir, home]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = await writeJourneyWorkspace(run, { item, targetUrl, timeoutSeconds, video: false, projects: [
    { name: 'seed', testDir: seedDir, testMatch: SEED },
    { name: TESTS, testDir: join(project, TESTS), testIgnore: '**' },
  ] });
  const seed = seedSpec(signIn);
  await writeFile(join(seedDir, SEED), seed);
  await writeFile(join(project, PLAN), generationPlan(item, { signIn }));
  const base = { FORCE_COLOR: '0', ...pick(values, ['PATH', 'TMPDIR', 'LANG']), HOME: home };
  const setup = async (command, args, failure) => {
    try { await exec(command, args, { cwd: project, env: base, timeout: 60000, signal, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(signal.aborted ? CANCELLED : failure); }
  };
  await setup('git', ['init', '--quiet'], 'Git is required to generate code.');
  // Playwright writes its OpenCode agents for the pinned version, and finds the seed in the config's first project.
  await setup(process.execPath, [PLAYWRIGHT_CLI, 'init-agents', '--loop=opencode', '--config', config], 'Playwright could not write its generator agent.');
  const file = join(project, 'opencode.json');
  const opencode = JSON.parse(await readFile(file, 'utf8')), agent = opencode.agent?.[GENERATOR_AGENT];
  if (!agent?.tools || !opencode.mcp?.['playwright-test']) throw new Error('Playwright could not write its generator agent.');
  // `opencode run --agent` runs a primary agent. It gets Playwright's tool list and nothing else, so no shell, edit or
  // web tool can read the harness environment, and files outside the project stay closed.
  Object.assign(agent, { mode: 'primary', model: `openrouter/${model}`, tools: { '*': false, ...agent.tools } });
  // The test MCP server is the pinned Playwright, headless, on the seed's config; npx would fetch another version.
  // OpenCode starts it with its own environment and this one on top: the user's HOME, where Playwright's browsers are,
  // and no model key.
  Object.assign(opencode.mcp['playwright-test'], {
    command: [process.execPath, PLAYWRIGHT_CLI, 'run-test-mcp-server', '--headless', '--config', config],
    environment: { HOME: userHome, OPENROUTER_API_KEY: '' },
  });
  Object.assign(opencode, { autoupdate: false, share: 'disabled', permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' }, provider: { openrouter: { models: { [model]: {} } } } });
  await writeFile(file, `${JSON.stringify(opencode, null, 2)}\n`);
  // Nothing writes these again: they are read-only, and an attempt's spec is accepted only while they are unchanged.
  const kept = [config, join(run, 'case.json'), join(run, 'node_modules', 'perpetual', 'package.json'), join(run, 'node_modules', 'perpetual', 'index.mjs'), join(seedDir, SEED),
    file, join(project, '.opencode', 'prompts', `${GENERATOR_AGENT}.md`), join(project, PLAN)];
  await Promise.all(kept.map(path => chmod(path, 0o444)));
  return { seed, kept: await fingerprint(kept) };
}

// Every test file the generator wrote, all in tests.
async function writtenSpecs(project) {
  const found = [];
  const walk = async (dir, depth) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (entry.isFile() && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) found.push(path);
    }
  };
  await walk(join(project, TESTS), 0);
  return found;
}

// The one spec an attempt wrote: its code once valid, else what validation rejected. A repair may leave the
// earlier file beside a new one; only files written since the attempt began count then.
async function readSpec(project, item, since) {
  let files = await writtenSpecs(project);
  if (files.length > 1) files = (await Promise.all(files.map(async file => (await lstat(file)).mtimeMs >= since ? file : null))).filter(Boolean);
  if (files.length !== 1) return { file: TARGET, error: files.length ? `Write one test file; found ${files.map(file => relative(project, file)).join(', ')}.` : 'No test file was written.' };
  const [path] = files, file = relative(project, path), info = await lstat(path);
  if (!info.isFile() || info.size > MAX_SPEC) return { file, error: 'Provide a spec of at most 200 KB.' };
  const code = await readFile(path, 'utf8');
  try { return { file, code: validateJourneySpec(code, item) }; } catch (error) { return { file, error: error.message, rejected: code }; }
}

/**
 * Generates a reviewed case's spec in a private workspace the caller owns and removes. The model key reaches only
 * OpenCode's environment and the test account only the harness's, and every captured output is redacted. Resolves
 * { code, provenance } with code validateJourneySpec accepts; after one invalid attempt the harness repairs once with
 * the validation error.
 */
export function generateJourneySpec({ workspace, item, targetUrl, allowedOrigins, timeoutSeconds, credentials, apiKey, model, harness = opencodeHarness, env = process.env, timeoutMs = 10 * 60 * 1000, cleanupGraceMs = 15000, onStep = () => {} }) {
  const abort = new AbortController(), secrets = [apiKey, credentials?.password].filter(Boolean);
  const hide = text => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text));
  let job = null;
  const attempt = async (prompt, { project, childEnv }) => {
    if (abort.signal.aborted) throw new Error(CANCELLED);
    const { command, args } = harness({ model: `openrouter/${model}`, prompt });
    const tails = { stdout: '', stderr: '' };
    job = superviseWorker({ command, args, cwd: project, env: childEnv, timeoutMs, cleanupGraceMs, settleMs: SETTLE_MS, secrets, unavailable: 'The code generator could not start. Install Node.js with npx.',
      // Redacted before clipping, so a clipped tail never keeps part of a secret.
      onOutput(chunk, stream) { tails[stream] = hide(tails[stream] + chunk).slice(-TAIL); } });
    try { await job.promise; }
    catch (error) {
      const incomplete = error.cleanupIncomplete ? { cleanupIncomplete: true } : {};
      if (abort.signal.aborted) throw Object.assign(new Error(CANCELLED), incomplete);
      const output = (tails.stderr.trim() || tails.stdout.trim()).split('\n').slice(-6).join(' ').slice(-500);
      const reason = error.timedOut ? 'Code generation exceeded its time limit.' : /exited before completing/.test(error.message) ? 'The code generator stopped.' : error.message;
      throw Object.assign(new Error(browserError(hide(`${reason}${output ? ` ${output}` : ''}`), childEnv, 800)), incomplete);
    } finally { job = null; }
  };
  const promise = (async () => {
    onStep('preparing');
    const values = typeof env === 'function' ? env() : env, signIn = Boolean(credentials), userHome = values.HOME || homedir();
    // Real paths, as the test MCP server compares its root and the config's test folders.
    const { project, run, home } = workspaceFolders(await realpath(workspace));
    const { seed, kept } = await prepare({ project, run, home, item, targetUrl, timeoutSeconds, model, signIn, values, userHome, signal: abort.signal });
    const intact = async () => { if (!isDeepStrictEqual(await fingerprint(Object.keys(kept)).catch(() => null), kept)) throw new Error('The code generation workspace changed.'); };
    const childEnv = {
      // The seed runs as a journey does, without reporting: its hash is the one the fixture accepts.
      ...journeyEnvironment(values, run, { hash: specHash(seed), targetUrl, allowedOrigins, credentials, events: false }),
      ...pick(values, ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']),
      // OpenCode reads config, plugins, skills and instructions from HOME and the XDG folders under it: the harness's
      // are this workspace's own. npx and OpenCode keep the user's npm settings and caches.
      HOME: home, XDG_CACHE_HOME: values.XDG_CACHE_HOME || join(userHome, '.cache'),
      npm_config_cache: join(userHome, '.npm'), npm_config_userconfig: join(userHome, '.npmrc'),
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENROUTER_API_KEY: apiKey,
    };
    onStep('generating');
    let since = Date.now();
    await attempt(generatePrompt, { project, childEnv });
    await intact();
    let result = await readSpec(project, item, since);
    if (result.error) {
      onStep('repairing');
      since = Date.now();
      await attempt(repairPrompt(result.error, result.file, generationRules(item, { signIn })), { project, childEnv });
      await intact();
      result = await readSpec(project, item, since);
      // The rejected code stays with the failure, so a person can see what the generator wrote.
      if (result.error) throw Object.assign(new Error(hide(`The generated code is invalid: ${result.error}`).slice(0, 800)), result.rejected ? { rejected: hide(result.rejected).slice(0, MAX_REJECTED) } : {});
    }
    return { code: result.code, provenance: { harness: `opencode@${OPENCODE_VERSION}`, generator: `${GENERATOR_AGENT}@${PLAYWRIGHT_VERSION}`, model: `openrouter/${model}` } };
  })();
  return { promise, cancel() { abort.abort(); job?.cancel(); } };
}
