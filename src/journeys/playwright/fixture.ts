// The generic journey fixture, which an approved spec imports as 'perpetual'. The spec performs a reviewed
// journey's actions; the reviewed checks come from the approved case snapshot at run time, so a spec can
// neither write nor weaken them. Events reach the controller through ./reporter.ts.
import { test as base, type Page, type Request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OPERATORS, STEPS, approvedCase, checkText, navigationAllowed, numberAfter, paymentAllowed, sameOrigin, stripeLive } from './checks.ts';
import type { ApprovedCase, Captures, Check, Evaluation, EvaluatedCheck, FixtureEvent, Reading, TextCheck } from './checks.ts';
import type { RunCredentials } from '../../browser/run-credentials.ts';

/** What a spec calls on its `journey` fixture. */
export type JourneyFixture = { milestone(id: string, actions: () => Promise<void>): Promise<void>; signIn(): Promise<void> };
/** A check's result on the page; final means waiting longer cannot change it. */
type Observation = Evaluation & { final?: true };
/** Why no reviewed check can judge the page any more, once a navigation was refused. */
type Guard = { refused: string | null };
/** A control run's document: the journey's actions in it, their count when the fixture last signed in, and whether it signs in now. */
type Held = { actions: number; signedAt: number; signingIn: boolean };

// A spec body runs in this worker process. The event channel and the account stay in this module: they leave the
// environment before any spec runs, so neither a spec nor the browser Playwright launches later can read them.
const env = { ...process.env }, write = process.stdout.write;
if (env.TEST_WORKER_INDEX !== undefined) for (const key of ['PERPETUAL_EVENT_CHANNEL', 'PERPETUAL_ACCOUNT_USERNAME', 'PERPETUAL_ACCOUNT_PASSWORD']) delete process.env[key];
// The runtime sets the case snapshot, the target URL and the allowed origins for every journey process.
const approved: ApprovedCase = approvedCase(JSON.parse(readFileSync(env.PERPETUAL_CASE!, 'utf8')));
const origins: unknown = JSON.parse(env.PERPETUAL_ALLOWED_ORIGINS || '[]');
if (!Array.isArray(origins) || !origins.every((origin): origin is string => typeof origin === 'string')) throw new Error('The allowed origins are unreadable.');
const allowed = new Set(origins);
const account = env.PERPETUAL_ACCOUNT_USERNAME && env.PERPETUAL_ACCOUNT_PASSWORD ? { username: env.PERPETUAL_ACCOUNT_USERNAME, password: env.PERPETUAL_ACCOUNT_PASSWORD } : null;
const VIEWPORT = { width: 1280, height: 800 }, FRAME_MS = 333, POLL_MS = 200, SIGN_IN_MS = 20000;
// A verification's control run blocks every request that could change state, on every origin, except while the
// fixture signs in, so later milestones are still reached. Each is answered without reaching the application, so the
// page stays judgeable: a document (a form's submission) with 204, which leaves its page as it was, anything else with
// 503. Once the journey acts after a page's WebSocket opened, what the page sends over it is dropped (holdSockets), while
// what the server sends still arrives. A reviewed check must then notice that nothing was kept.
const BLOCK_WRITES = env.PERPETUAL_BLOCK_WRITES === '1', READS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Fixed reasons a journey stops for review (the runner's navigation_not_allowed and payment_live_mode_rejected), and
// why a control run in which every check passed proves nothing; a page calls REPORT when a write may have got past.
const NAVIGATION = 'Navigation is outside approved origins.', PAYMENT = 'Payment pages accept input only in Stripe test mode.';
const UNGUARDED = 'The control run could not block everything the pages sent.', REPORT = '__perpetualUnguarded';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Only lines carrying the run's channel token are events; anything else a worker prints is ignored. Without a
// channel, as while code is generated, nothing is reported.
const emit = (event: FixtureEvent) => { if (env.PERPETUAL_EVENT_CHANNEL) write.call(process.stdout, `${env.PERPETUAL_EVENT_CHANNEL}${JSON.stringify({ ...event, caseId: approved.id })}\n`); };
// The spec cannot be judged as written; the reporter makes the journey need review with this fixed reason.
function halt(error: string) { emit({ type: 'journey-stop', error }); return new Error(error); }
// Why a document may not load: a top-level page stays on the approved origins and off Stripe unless in test mode.
const refusal = (url: string, top: boolean) => !navigationAllowed(url, allowed) ? NAVIGATION : (top ? !paymentAllowed(url) : stripeLive(url)) ? PAYMENT : null;
const topLevel = (request: Request) => { try { return !request.frame().parentFrame(); } catch { return false; } };

// The number shown right after a visible label: the nearest ancestor, then the nearest number, wins.
async function readNumber(page: Page, label: string) {
  let nodes = page.getByText(label.trim()).filter({ visible: true });
  for (let depth = 0; depth < 4; depth++) {
    const found = (await nodes.allInnerTexts()).slice(0, 20).map((text, order) => ({ order, hit: numberAfter(text, label, depth > 0) })).filter((item): item is { order: number; hit: Reading } => item.hit !== null);
    if (found.length) return found.sort((a, b) => a.hit.gap - b.hit.gap || a.order - b.order)[0].hit.value;
    nodes = nodes.locator('xpath=..');
  }
  return null;
}

async function observe(page: Page, check: Check, captures: Captures): Promise<Observation> {
  if (check.type === 'url-contains') return { passed: page.url().includes(check.value) };
  if (check.type !== 'read-number' && check.type !== 'compare-number') return { passed: (await page.getByText(check.value).filter({ visible: true }).count() > 0) === (check.type === 'text-visible') };
  if (check.type === 'compare-number' && !Object.hasOwn(captures, check.than)) return { passed: false, final: true, error: 'The earlier value was not captured.' };
  const value = await readNumber(page, check.label);
  if (value === null) return { passed: false, error: 'No number follows this label on the current page.' };
  return check.type === 'read-number' ? { passed: true, observed: value } : { passed: OPERATORS[check.op](value, captures[check.than]), observed: value };
}

// Why no reviewed check can judge the current page: a refused navigation, or no approved page to read.
function unjudged(page: Page | undefined, guard: Guard) {
  if (guard.refused) return guard.refused;
  if (!page) return 'Every page of the journey was closed.';
  if (page.url().startsWith('chrome-error:')) return 'The page could not be loaded.';
  return page.url() !== 'about:blank' && navigationAllowed(page.url(), allowed) ? null : 'The current page is outside approved origins.';
}

// Actions return before the page settles, so a check waits for its condition up to the check timeout. A page no check
// can judge stops the journey for review instead, at once after a refused navigation, else once the timeout passes.
async function verify<C extends Check>(page: () => Page | undefined, check: C, captures: Captures, timeout: number, guard: Guard): Promise<{ stop: string } | EvaluatedCheck<C>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const target = page(), reason = unjudged(target, guard), late = Date.now() >= deadline;
    if (reason && (guard.refused || late)) return { stop: reason };
    if (!reason) {
      let result: Observation;
      // Browser errors can contain page text; keep only a fixed reason. A page is judgeable only while it is open.
      try { result = await observe(target!, check, captures); } catch { result = { passed: false, error: 'The current page could not be checked.' }; }
      if (result.passed || result.final || late) {
        // A passed read-number check always observed its number.
        if (check.type === 'read-number' && result.passed) captures[check.name] = result.observed!;
        const { final: _final, ...evaluated } = result;
        return { ...check, ...evaluated };
      }
    }
    await wait(POLL_MS);
  }
}

// ~3 JPEG frames a second for the live view; the latest frame of a burst is always sent.
async function streamFrames(page: Page) {
  if (!env.PERPETUAL_EVENT_CHANNEL) return async () => {};
  let last = 0, pending: { data: Buffer; timestamp: number } | null = null, timer: NodeJS.Timeout | undefined;
  const send = () => {
    timer = undefined;
    if (!pending) return;
    const { data, timestamp } = pending; pending = null; last = Date.now();
    if (data.length <= 1_500_000) emit({ type: 'frame', data: data.toString('base64'), timestamp: Math.round(timestamp) });
  };
  try {
    await page.screencast.start({ size: VIEWPORT, quality: 55, onFrame(frame) { pending = frame; timer ??= setTimeout(send, Math.max(0, FRAME_MS - (Date.now() - last))); } });
  } catch { return async () => {}; }
  return async () => { await page.screencast.stop().catch(() => {}); clearTimeout(timer); send(); };
}

// A control run's script in each document, after Playwright's WebSocket mock and before the page's own scripts. It
// counts the journey's actions there (a click, a key press, typing or a selection), except while the fixture signs in.
// A socket drops what the page sends once the journey has acted since it opened, so its opening message and
// subscriptions still reach the application. What a socket that opened after an action since the fixture last signed
// in sends may be a write, so the page reports it.
function holdSockets(report: string) {
  type Send = Parameters<WebSocket['send']>;
  const state: Held = { actions: 0, signedAt: 0, signingIn: false }, opened = new WeakMap<WebSocket, number>(), Routed = globalThis.WebSocket;
  Object.defineProperty(globalThis, Symbol.for('perpetual.sockets'), { value: state });
  for (const type of ['pointerdown', 'keydown', 'input', 'change']) addEventListener(type, () => { if (!state.signingIn) state.actions++; }, true);
  globalThis.WebSocket = class WebSocket extends Routed {
    constructor(...args: ConstructorParameters<typeof Routed>) { super(...args); this.addEventListener('open', () => opened.set(this, state.actions)); }
    override send(...args: Send) {
      const at = opened.get(this);
      if (at !== undefined && !state.signingIn) { if (at !== state.actions) return; if (at > state.signedAt) (globalThis as unknown as Record<string, () => void>)[report]?.(); }
      super.send(...args);
    }
  };
}
// While the fixture signs in, a control run's page sends freely and its input is no journey action; a socket the page
// opens for the account is no write.
function signingInPage(on: boolean) {
  const state = (globalThis as unknown as Record<symbol, Held | undefined>)[Symbol.for('perpetual.sockets')];
  if (state) Object.assign(state, { signingIn: on, signedAt: state.actions });
}

// A sign-in form has one password field; its username is the type=email or autocomplete username/email field in
// the same form, else the nearest text field before the password (as integrations/browser-use/sign_in.py finds it).
type Control = HTMLInputElement | HTMLButtonElement;
function findForm(): { username?: HTMLInputElement; password?: HTMLInputElement; submit?: Control | null } {
  const nodes: Control[] = [];
  const walk = (root: Document | ShadowRoot) => root.querySelectorAll('*').forEach(node => { if (node.tagName === 'INPUT' || node.tagName === 'BUTTON') nodes.push(node as Control); if (node.shadowRoot) walk(node.shadowRoot); });
  walk(document);
  const up = (node: Node) => node.parentElement || (node.getRootNode() as { host?: Element }).host || null;
  const inside = (node: Node, box: Node | null) => { for (let at: Node | null = node; at; at = up(at)) if (at === box) return true; return false; };
  const kind = (node: Element) => (node.getAttribute('type') || 'text').toLowerCase();
  const shown = (node: Element) => node.getClientRects().length > 0 && node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const before = (node: Control, other: Control) => nodes.indexOf(node) < nodes.indexOf(other);
  const inputs = nodes.filter((node): node is HTMLInputElement => node.tagName === 'INPUT' && !node.disabled && !(node as HTMLInputElement).readOnly && shown(node));
  const passwords = inputs.filter(node => kind(node) === 'password');
  const names = inputs.filter(node => kind(node) === 'text' || kind(node) === 'email');
  const hinted = (node: Element) => kind(node) === 'email' || /\b(username|email)\b/i.test(node.getAttribute('autocomplete') || '');
  for (const password of passwords) {
    let member = (node: Control) => node.form === password.form;
    if (!password.form) {
      let box = up(password);
      while (box && !names.some(node => inside(node, box))) box = up(box);
      member = node => !!box && inside(node, box);
    }
    if (/new-password/i.test(password.getAttribute('autocomplete') || '') || passwords.filter(member).length !== 1) continue;
    const fields = names.filter(member), preferred = fields.filter(hinted);
    const username = preferred.filter(node => before(node, password)).pop() || preferred[0] || fields.filter(node => before(node, password)).pop();
    if (!username) continue;
    const submits = nodes.filter(node => member(node) && (node.tagName === 'BUTTON' ? node.type === 'submit' : ['submit', 'image'].includes(kind(node))) && shown(node));
    return { username, password, submit: submits.find(node => before(password, node)) || submits[0] || null };
  }
  return {};
}

export const test = base.extend<{ journey: JourneyFixture }>({
  journey: async ({ page, context }, use, testInfo) => {
    if (createHash('sha256').update(readFileSync(testInfo.file)).digest('hex') !== env.PERPETUAL_SPEC_HASH) throw halt('The spec differs from its approved version.');
    const timeout = Number(env.PERPETUAL_CHECK_TIMEOUT_MS) || 10000, captures: Captures = {}, done: string[] = [];
    let running = false, broken = false, signingIn = false, forwarded = 0, sent = 0, unguarded = false;
    const current = () => page.isClosed() ? context.pages().filter(item => !item.isClosed()).at(-1) : page;
    const guard: Guard = { refused: null }, stop = (reason: string) => { broken = true; return halt(reason); };
    // A refused top-level document stops the journey for review; a refused frame only stays empty.
    const refuse = (url: string, top: boolean) => { const reason = refusal(url, top); if (reason && top) guard.refused ||= reason; return reason; };
    // Playwright's routes see only the first request of a redirect chain, so each page also pauses every document hop
    // over CDP. Routes still cover a popup's first request, which precedes its page's CDP session, keep live Stripe
    // resources out of every frame, and in a control run answer every write, a form's submission included.
    await context.route('**/*', route => {
      const request = route.request(), url = request.url(), navigation = request.isNavigationRequest();
      if (navigation ? refuse(url, topLevel(request)) : stripeLive(url)) return route.abort('blockedbyclient').catch(() => {});
      if (BLOCK_WRITES && !signingIn && !READS.has(request.method())) return route.fulfill({ status: navigation ? 204 : 503 }).catch(() => {});
      return route.continue().catch(() => {});
    });
    // Routes never see a WebSocket's messages, so a control run also routes every page's sockets to their server,
    // counting what holdSockets lets through; the page's script is added after the route's, so it sees routed sockets.
    if (BLOCK_WRITES) {
      await context.exposeFunction(REPORT, () => { unguarded = true; });
      await context.routeWebSocket('**/*', socket => {
        const server = socket.connectToServer();
        socket.onMessage(message => { forwarded++; server.send(message); });
      });
      await context.addInitScript(holdSockets, REPORT);
    }
    const watch = async (target: Page) => {
      // Neither kind of route reaches a worker's WebSocket, a page's WebSocketStream or anything a shared worker sends. A
      // socket message sent beyond those forwarded, or any shared worker, leaves a control run unable to vouch that
      // nothing was kept.
      if (BLOCK_WRITES) target.on('websocket', socket => socket.on('framesent', () => { if (++sent > forwarded) unguarded = true; }));
      const cdp = await context.newCDPSession(target), { targetInfo } = await cdp.send('Target.getTargetInfo');
      cdp.on('Fetch.requestPaused', ({ requestId, request, frameId }) => {
        const refused = refuse(request.url, frameId === targetInfo.targetId);
        cdp.send(refused ? 'Fetch.failRequest' : 'Fetch.continueRequest', refused ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
      if (!BLOCK_WRITES) return;
      cdp.on('Target.targetCreated', ({ targetInfo: created }) => { if (created.type === 'shared_worker') unguarded = true; });
      await cdp.send('Target.setDiscoverTargets', { discover: true });
    };
    const GUARD = 'The browser navigation guard could not be attached.';
    // A page the guard cannot watch is closed and stops the journey.
    context.on('page', target => { watch(target).catch(() => { if (target.isClosed()) return; guard.refused ||= GUARD; target.close().catch(() => {}); }); });
    try { await watch(page); } catch { throw halt(GUARD); }
    // An action that fails or ends after a refused navigation stops the journey with the refusal, never as page trouble.
    const acting = async (actions: () => Promise<unknown>) => {
      try { await actions(); } catch (error) { throw guard.refused ? stop(guard.refused) : error; }
      if (guard.refused) throw stop(guard.refused);
    };
    const stopFrames = await streamFrames(page);
    try {
      // The spec starts on the run's application URL, where discovery starts too.
      await acting(() => page.goto(env.PERPETUAL_TARGET_URL!));
      const milestone = async (id: string, actions: () => Promise<void>) => {
        const step = approved.steps?.[done.length];
        if (running || broken || step?.id !== id || typeof actions !== 'function') throw stop('The spec ran a milestone outside the reviewed order.');
        running = true; done.push(id);
        emit({ type: 'journey-step', stepId: id, status: 'running' });
        await acting(() => base.step(step.title, actions));
        const checks: EvaluatedCheck[] = [];
        let unjudgeable: string | null = null;
        await base.step(STEPS.checks, async () => {
          for (const check of step.checks || []) {
            const result = await verify(current, check, captures, timeout, guard);
            if ('stop' in result) { unjudgeable = result.stop; break; }
            checks.push(result); if (!result.passed) break;
          }
        });
        if (unjudgeable) throw stop(unjudgeable);
        const failed = checks.find(check => !check.passed);
        const evidence = failed ? `Reviewed check failed: ${checkText(failed, captures)}.` : checks.length ? `Reviewed checks passed: ${checks.map(check => checkText(check, captures)).join('; ')}.` : 'Actions completed; this milestone has no reviewed checks.';
        emit({ type: 'journey-step', stepId: id, status: failed ? 'failed' : 'completed', evidence: evidence.slice(0, 2000), ...(checks.length ? { checks } : {}) });
        if (failed) { broken = true; throw new Error(`Reviewed check failed at milestone: ${step.title}.`); }
        running = false;
      };
      const signIn = () => base.step(STEPS.signIn, async () => {
        if (!account) throw new Error('No test account is available for this run.');
        const hold = (on: boolean) => BLOCK_WRITES ? current()?.evaluate(signingInPage, on).catch(() => {}) : undefined;
        signingIn = true; await hold(true);
        try { await signInWith(account); } finally { signingIn = false; await hold(false); }
      });
      const signInWith = async (account: RunCredentials) => {
        const signing = current();
        if (!signing || !sameOrigin(signing.url(), env.PERPETUAL_TARGET_URL!)) throw new Error('The sign-in form is not on the application origin.');
        await signing.locator('input[type=password]').filter({ visible: true }).first().waitFor({ state: 'visible' });
        const form = await signing.mainFrame().evaluateHandle(findForm);
        try {
          const [username, password, submit] = await Promise.all(['username', 'password', 'submit'].map(name => form.getProperty(name).then(handle => handle.asElement())));
          if (!username || !password) throw new Error('The page has no sign-in form with one password field.');
          await username.fill(account.username); await password.fill(account.password);
          // Click waits until a control disabled before both fields held values is enabled.
          if (!submit || !await submit.click({ timeout: 3000 }).then(() => true, () => false)) await password.press('Enter', { timeout: 3000 }).catch(() => {});
        } finally { await form.dispose().catch(() => {}); }
        // Signed in once an approved page stays without a visible password field, so a brief transition does not count.
        const deadline = Date.now() + SIGN_IN_MS;
        for (let streak = 0; streak < 3;) {
          if (Date.now() >= deadline || signing.isClosed()) throw new Error('The test account did not sign in.');
          await wait(250);
          const gone = await signing.locator('input[type=password]').filter({ visible: true }).count().then(count => !count, () => false);
          streak = gone && navigationAllowed(signing.url(), allowed) ? streak + 1 : 0;
        }
      };
      await use({ milestone, signIn });
      // An action, a check or the deadline ended the journey early; its milestones were already reported. A valid
      // spec runs a milestone per reviewed step, so only a generator's seed, which opens the application and at most
      // signs in, finishes without one: nothing was judged, and nothing is reported.
      if (testInfo.status !== 'passed' || broken || !done.length && approved.steps?.length) return;
      if (running || done.length !== (approved.steps || []).length) throw halt('The spec did not run every reviewed milestone in order.');
      if (guard.refused) throw halt(guard.refused);
      const assertions: EvaluatedCheck<TextCheck>[] = [];
      for (const check of approved.assertions || []) {
        const result = await verify(current, check, captures, assertions.some(item => !item.passed) ? 0 : timeout, guard);
        if ('stop' in result) throw halt(result.stop);
        assertions.push(result);
      }
      emit({ type: 'assertions', assertions: assertions.map(({ type, value, passed }) => ({ type, value, passed })) });
      if (assertions.some(item => !item.passed)) throw new Error('A final assertion failed.');
      // Every check passed, but a write may have got past the block: the control run is inconclusive, not missed.
      if (unguarded) throw halt(UNGUARDED);
    } finally { await stopFrames(); }
  },
});
