// The generic journey fixture, which an approved spec imports as 'perpetual'. The spec performs a reviewed
// journey's actions; the reviewed checks come from the approved case snapshot at run time, so a spec can
// neither write nor weaken them. Events reach the controller through ./reporter.mjs.
import { test as base } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OPERATORS, STEPS, checkText, navigationAllowed, numberAfter, paymentAllowed, sameOrigin, stripeLive } from './checks.mjs';

// A spec body runs in this worker process. The event channel and the account stay in this module: they leave the
// environment before any spec runs, so neither a spec nor the browser Playwright launches later can read them.
const env = { ...process.env }, write = process.stdout.write;
if (env.TEST_WORKER_INDEX !== undefined) for (const key of ['PERPETUAL_EVENT_CHANNEL', 'PERPETUAL_ACCOUNT_USERNAME', 'PERPETUAL_ACCOUNT_PASSWORD']) delete process.env[key];
const approved = JSON.parse(readFileSync(env.PERPETUAL_CASE, 'utf8'));
const allowed = new Set(JSON.parse(env.PERPETUAL_ALLOWED_ORIGINS || '[]'));
const account = env.PERPETUAL_ACCOUNT_USERNAME && env.PERPETUAL_ACCOUNT_PASSWORD ? { username: env.PERPETUAL_ACCOUNT_USERNAME, password: env.PERPETUAL_ACCOUNT_PASSWORD } : null;
const VIEWPORT = { width: 1280, height: 800 }, FRAME_MS = 333, POLL_MS = 200, SIGN_IN_MS = 20000;
// Fixed reasons a journey stops for review (the runner's navigation_not_allowed and payment_live_mode_rejected).
const NAVIGATION = 'Navigation is outside approved origins.', PAYMENT = 'Payment pages accept input only in Stripe test mode.';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Only lines carrying the run's channel token are events; anything else a worker prints is ignored. Without a
// channel, as while code is generated, nothing is reported.
const emit = event => { if (env.PERPETUAL_EVENT_CHANNEL) write.call(process.stdout, `${env.PERPETUAL_EVENT_CHANNEL}${JSON.stringify({ ...event, caseId: approved.id })}\n`); };
// The spec cannot be judged as written; the reporter makes the journey need review with this fixed reason.
function halt(error) { emit({ type: 'journey-stop', error }); return new Error(error); }
// Why a document may not load: a top-level page stays on the approved origins and off Stripe unless in test mode.
const refusal = (url, top) => !navigationAllowed(url, allowed) ? NAVIGATION : (top ? !paymentAllowed(url) : stripeLive(url)) ? PAYMENT : null;
const topLevel = request => { try { return !request.frame().parentFrame(); } catch { return false; } };

// The number shown right after a visible label: the nearest ancestor, then the nearest number, wins.
async function readNumber(page, label) {
  let nodes = page.getByText(label.trim()).filter({ visible: true });
  for (let depth = 0; depth < 4; depth++) {
    const found = (await nodes.allInnerTexts()).slice(0, 20).map((text, order) => ({ order, hit: numberAfter(text, label, depth > 0) })).filter(item => item.hit);
    if (found.length) return found.sort((a, b) => a.hit.gap - b.hit.gap || a.order - b.order)[0].hit.value;
    nodes = nodes.locator('xpath=..');
  }
  return null;
}

async function observe(page, check, captures) {
  if (check.type === 'url-contains') return { passed: page.url().includes(check.value) };
  if (check.type !== 'read-number' && check.type !== 'compare-number') return { passed: (await page.getByText(check.value).filter({ visible: true }).count() > 0) === (check.type === 'text-visible') };
  if (check.type === 'compare-number' && !Object.hasOwn(captures, check.than)) return { passed: false, final: true, error: 'The earlier value was not captured.' };
  const value = await readNumber(page, check.label);
  if (value === null) return { passed: false, error: 'No number follows this label on the current page.' };
  return check.type === 'read-number' ? { passed: true, observed: value } : { passed: OPERATORS[check.op](value, captures[check.than]), observed: value };
}

// Why no reviewed check can judge the current page: a refused navigation, or no approved page to read.
function unjudged(page, guard) {
  if (guard.refused) return guard.refused;
  if (!page) return 'Every page of the journey was closed.';
  if (page.url().startsWith('chrome-error:')) return 'The page could not be loaded.';
  return page.url() !== 'about:blank' && navigationAllowed(page.url(), allowed) ? null : 'The current page is outside approved origins.';
}

// Actions return before the page settles, so a check waits for its condition up to the check timeout. A page no check
// can judge stops the journey for review instead, at once after a refused navigation, else once the timeout passes.
async function verify(page, check, captures, timeout, guard) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const target = page(), reason = unjudged(target, guard), late = Date.now() >= deadline;
    if (reason && (guard.refused || late)) return { stop: reason };
    if (!reason) {
      let result;
      // Browser errors can contain page text; keep only a fixed reason.
      try { result = await observe(target, check, captures); } catch { result = { passed: false, error: 'The current page could not be checked.' }; }
      if (result.passed || result.final || late) {
        if (check.type === 'read-number' && result.passed) captures[check.name] = result.observed;
        const { final: _final, ...evaluated } = result;
        return { ...check, ...evaluated };
      }
    }
    await wait(POLL_MS);
  }
}

// ~3 JPEG frames a second for the live view; the latest frame of a burst is always sent.
async function streamFrames(page) {
  if (!env.PERPETUAL_EVENT_CHANNEL) return async () => {};
  let last = 0, pending = null, timer = null;
  const send = () => {
    timer = null;
    if (!pending) return;
    const { data, timestamp } = pending; pending = null; last = Date.now();
    if (data.length <= 1_500_000) emit({ type: 'frame', data: data.toString('base64'), timestamp: Math.round(timestamp) });
  };
  try {
    await page.screencast.start({ size: VIEWPORT, quality: 55, onFrame(frame) { pending = frame; timer ??= setTimeout(send, Math.max(0, FRAME_MS - (Date.now() - last))); } });
  } catch { return async () => {}; }
  return async () => { await page.screencast.stop().catch(() => {}); clearTimeout(timer); send(); };
}

// A sign-in form has one password field; its username is the type=email or autocomplete username/email field in
// the same form, else the nearest text field before the password (as integrations/browser-use/sign_in.py finds it).
function findForm() {
  const nodes = [];
  const walk = root => root.querySelectorAll('*').forEach(node => { if (node.tagName === 'INPUT' || node.tagName === 'BUTTON') nodes.push(node); if (node.shadowRoot) walk(node.shadowRoot); });
  walk(document);
  const up = node => node.parentElement || node.getRootNode().host || null;
  const inside = (node, box) => { for (let at = node; at; at = up(at)) if (at === box) return true; return false; };
  const kind = node => (node.getAttribute('type') || 'text').toLowerCase();
  const shown = node => node.getClientRects().length > 0 && node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const before = (node, other) => nodes.indexOf(node) < nodes.indexOf(other);
  const inputs = nodes.filter(node => node.tagName === 'INPUT' && !node.disabled && !node.readOnly && shown(node));
  const passwords = inputs.filter(node => kind(node) === 'password');
  const names = inputs.filter(node => kind(node) === 'text' || kind(node) === 'email');
  const hinted = node => kind(node) === 'email' || /\b(username|email)\b/i.test(node.getAttribute('autocomplete') || '');
  for (const password of passwords) {
    let member = node => node.form === password.form;
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

export const test = base.extend({
  journey: async ({ page, context }, use, testInfo) => {
    if (createHash('sha256').update(readFileSync(testInfo.file)).digest('hex') !== env.PERPETUAL_SPEC_HASH) throw halt('The spec differs from its approved version.');
    const timeout = Number(env.PERPETUAL_CHECK_TIMEOUT_MS) || 10000, captures = {}, done = [];
    let running = false, broken = false;
    const current = () => page.isClosed() ? context.pages().filter(item => !item.isClosed()).at(-1) : page;
    const guard = { refused: null }, stop = reason => { broken = true; return halt(reason); };
    // A refused top-level document stops the journey for review; a refused frame only stays empty.
    const refuse = (url, top) => { const reason = refusal(url, top); if (reason && top) guard.refused ||= reason; return reason; };
    // Playwright's routes see only the first request of a redirect chain, so each page also pauses every document hop
    // over CDP, as runner.py does. Routes still cover a popup's first request, which precedes its page's CDP session,
    // and keep live Stripe resources out of every frame.
    await context.route('**/*', route => {
      const request = route.request(), url = request.url();
      return ((request.isNavigationRequest() ? refuse(url, topLevel(request)) : stripeLive(url)) ? route.abort('blockedbyclient') : route.continue()).catch(() => {});
    });
    const watch = async target => {
      const cdp = await context.newCDPSession(target), { targetInfo } = await cdp.send('Target.getTargetInfo');
      cdp.on('Fetch.requestPaused', ({ requestId, request, frameId }) => {
        const refused = refuse(request.url, frameId === targetInfo.targetId);
        cdp.send(refused ? 'Fetch.failRequest' : 'Fetch.continueRequest', refused ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    };
    const GUARD = 'The browser navigation guard could not be attached.';
    // A page the guard cannot watch is closed and stops the journey.
    context.on('page', target => { watch(target).catch(() => { if (target.isClosed()) return; guard.refused ||= GUARD; target.close().catch(() => {}); }); });
    try { await watch(page); } catch { throw halt(GUARD); }
    // An action that fails or ends after a refused navigation stops the journey with the refusal, never as page trouble.
    const acting = async actions => {
      try { await actions(); } catch (error) { throw guard.refused ? stop(guard.refused) : error; }
      if (guard.refused) throw stop(guard.refused);
    };
    const stopFrames = await streamFrames(page);
    try {
      // Like a browser-use journey, the spec starts on the run's application URL.
      await acting(() => page.goto(env.PERPETUAL_TARGET_URL));
      const milestone = async (id, actions) => {
        const step = approved.steps?.[done.length];
        if (running || broken || step?.id !== id || typeof actions !== 'function') throw stop('The spec ran a milestone outside the reviewed order.');
        running = true; done.push(id);
        emit({ type: 'journey-step', stepId: id, status: 'running' });
        await acting(() => base.step(step.title, actions));
        const checks = [];
        let unjudgeable = null;
        await base.step(STEPS.checks, async () => {
          for (const check of step.checks || []) {
            const result = await verify(current, check, captures, timeout, guard);
            if (result.stop) { unjudgeable = result.stop; break; }
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
        const signing = current();
        if (!signing || !sameOrigin(signing.url(), env.PERPETUAL_TARGET_URL)) throw new Error('The sign-in form is not on the application origin.');
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
      });
      await use({ milestone, signIn });
      // An action, a check or the deadline ended the journey early; its milestones were already reported. A valid
      // spec runs a milestone per reviewed step, so only a generator's seed, which opens the application and at most
      // signs in, finishes without one: nothing was judged, and nothing is reported.
      if (testInfo.status !== 'passed' || broken || !done.length && approved.steps?.length) return;
      if (running || done.length !== (approved.steps || []).length) throw halt('The spec did not run every reviewed milestone in order.');
      if (guard.refused) throw halt(guard.refused);
      const assertions = [];
      for (const check of approved.assertions || []) {
        const result = await verify(current, check, captures, assertions.some(item => !item.passed) ? 0 : timeout, guard);
        if (result.stop) throw halt(result.stop);
        assertions.push(result);
      }
      emit({ type: 'assertions', assertions: assertions.map(({ type, value, passed }) => ({ type, value, passed })) });
      if (assertions.some(item => !item.passed)) throw new Error('A final assertion failed.');
    } finally { await stopFrames(); }
  },
});
