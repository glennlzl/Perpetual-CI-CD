import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { superviseWorker, workerTimeoutMs } from '../../browser/runtime.mjs';
import { validateRunCredentials } from '../../browser/run-credentials.mjs';
import { HOST as TWIN_HOST } from '../../twin/compose.mjs';

const require = createRequire(import.meta.url);
/** The pinned Playwright: its CLI runs journeys, the test MCP server and init-agents. */
export const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');
export const PLAYWRIGHT_VERSION = require('@playwright/test/package.json').version;
const fixture = new URL('./fixture.mjs', import.meta.url).href, reporter = fileURLToPath(new URL('./reporter.mjs', import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Writes what a journey's `playwright test` process needs into a private workspace: 'perpetual' resolving to the
 * generic fixture, the approved case snapshot and a generated config. Returns the config's path. The spec is
 * `journey.spec.mjs` in the workspace unless `projects` place the tests elsewhere.
 */
export async function writeJourneyWorkspace(workspace, { item, targetUrl, timeoutSeconds, projects, video = true }) {
  const shim = join(workspace, 'node_modules', 'perpetual');
  await mkdir(shim, { recursive: true, mode: 0o700 });
  await writeFile(join(shim, 'package.json'), JSON.stringify({ name: 'perpetual', type: 'module', exports: './index.mjs' }));
  await writeFile(join(shim, 'index.mjs'), `export * from ${JSON.stringify(fixture)};\n`);
  await writeFile(join(workspace, 'case.json'), JSON.stringify(item));
  const config = {
    ...(projects ? { projects } : { testDir: workspace, testMatch: 'journey.spec.mjs' }), outputDir: join(workspace, 'output'), reporter: [[reporter]],
    timeout: timeoutSeconds * 1000, workers: 1, retries: 0,
    use: {
      baseURL: new URL(targetUrl).origin, viewport: VIEWPORT, video: video ? { mode: 'on', size: VIEWPORT } : 'off', trace: 'off', screenshot: 'off',
      actionTimeout: 10000, navigationTimeout: 20000, serviceWorkers: 'block', acceptDownloads: false, headless: true,
      // Like the browser-use runner, the twin's host name resolves to loopback.
      launchOptions: { args: [`--host-resolver-rules=MAP ${TWIN_HOST} 127.0.0.1`] },
    },
  };
  const path = join(workspace, 'playwright.config.mjs');
  await writeFile(path, `export default ${JSON.stringify(config)};\n`);
  return path;
}

/**
 * The fixture's and reporter's environment for one spec. The account reaches only this environment, never a file;
 * without events the fixture reports nothing and streams no frames.
 */
export function journeyEnvironment(values, workspace, { hash, targetUrl, allowedOrigins = [], credentials, videoDir, checkTimeoutMs = 10000, events = true }) {
  const childEnv = { FORCE_COLOR: '0' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH']) if (typeof values[key] === 'string') childEnv[key] = values[key];
  return Object.assign(childEnv, {
    ...(events ? { PERPETUAL_EVENT_CHANNEL: `@${randomBytes(16).toString('hex')}@` } : {}),
    PERPETUAL_CASE: join(workspace, 'case.json'), PERPETUAL_SPEC_HASH: hash, PERPETUAL_CHECK_TIMEOUT_MS: String(checkTimeoutMs),
    PERPETUAL_TARGET_URL: targetUrl, PERPETUAL_ALLOWED_ORIGINS: JSON.stringify(allowedOrigins),
    ...(videoDir ? { PERPETUAL_VIDEO_DIR: videoDir } : {}),
    ...(credentials ? { PERPETUAL_ACCOUNT_USERNAME: credentials.username, PERPETUAL_ACCOUNT_PASSWORD: credentials.password } : {}),
  });
}

/**
 * Runs one approved journey spec as its own `playwright test` process, in place of the browser-use worker.
 * A private workspace holds the approved case snapshot, the spec and a generated config.
 */
export function createPlaywrightRuntime({ env = process.env, checkTimeoutMs = 10000 } = {}) {
  let preflight = null, checkedAt = 0;
  return {
    async capabilities() {
      if (!preflight || Date.now() - checkedAt > 15000) {
        const { chromium } = await import('@playwright/test');
        preflight = { runtimeInstalled: true, browserInstalled: await access(chromium.executablePath()).then(() => true, () => false) };
        checkedAt = Date.now();
      }
      return preflight;
    },
    start(input, onEvent, { timeoutMs = workerTimeoutMs(input), cleanupGraceMs = 40000 } = {}) {
      const credentials = validateRunCredentials(input.credentials);
      if (input.mode !== 'run' || !input.case?.id || typeof input.spec?.code !== 'string' || !/^[a-f0-9]{64}$/.test(input.spec.hash || '')) throw new Error('A Playwright journey needs its approved case and spec.');
      let job = null, cancelled = false;
      const promise = (async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'perpetual-playwright-'));
        try {
          const config = await writeJourneyWorkspace(workspace, { item: input.case, targetUrl: input.targetUrl, timeoutSeconds: input.timeoutSeconds });
          await writeFile(join(workspace, 'journey.spec.mjs'), input.spec.code);
          const childEnv = journeyEnvironment(typeof env === 'function' ? env() : env, workspace, { hash: input.spec.hash, targetUrl: input.targetUrl, allowedOrigins: input.allowedOrigins, credentials, videoDir: input.videoDir, checkTimeoutMs });
          if (cancelled) throw new Error('Browser operation cancelled.');
          // Playwright finishes the test, its recordings and its reporter on SIGINT.
          job = superviseWorker({ command: process.execPath, args: [PLAYWRIGHT_CLI, 'test', '--config', config], cwd: workspace, env: childEnv, onEvent, timeoutMs, cleanupGraceMs, stopSignal: 'SIGINT', secrets: [credentials?.password], unavailable: 'Playwright is unavailable. Run npm install.' });
          await job.promise;
        } finally { await rm(workspace, { recursive: true, force: true }).catch(() => {}); }
      })();
      return { promise, cancel() { cancelled = true; job?.cancel(); } };
    },
  };
}
