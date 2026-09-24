// Turns one journey's `playwright test` process into the browser worker contract (src/browser/runtime.mjs):
// one JSON event per stdout line. The fixture's events arrive as worker output tagged with the run's channel
// token; Playwright's steps become the live action list; the test's end becomes the journey's result facts.
import { copyFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STEPS } from './checks.mjs';

// Journey actions by Playwright step title; reads, waits for state and the fixture's own calls are not actions.
const ACTIONS = [[/^Navigate\b/, 'navigate'], [/^Reload\b/, 'reload_page'], [/^Go back\b/, 'go_back'], [/^(?:Click|Double click|Tap|Check|Uncheck|Set checked|Drag)\b/, 'click'], [/^(?:Fill|Type|Press sequentially|Clear)\b/, 'input'], [/^Press\b/, 'send_keys'], [/^Select option\b/, 'select_option'], [/^Hover\b/, 'hover'], [/^Scroll\b/, 'scroll'], [/^Wait for (?:timeout|URL|navigation|load state)\b/i, 'wait']];
const FORWARDED = new Set(['frame', 'journey-step']);
const plain = value => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').replace(/^\s*Error:\s*/, '');

export default class JourneyReporter {
  constructor() {
    const env = process.env;
    this.channel = env.PERPETUAL_EVENT_CHANNEL;
    this.approved = JSON.parse(readFileSync(env.PERPETUAL_CASE, 'utf8'));
    this.videoDir = env.PERPETUAL_VIDEO_DIR;
    this.secrets = [env.PERPETUAL_ACCOUNT_PASSWORD].filter(Boolean);
    Object.assign(this, { buffer: '', actions: [], indexes: new Map(), running: null, checkFailed: false, assertions: [], stop: null, result: null, errors: [] });
  }
  // The event protocol owns stdout, so Playwright adds no reporter of its own.
  printsToStdio() { return true; }
  write(event) { process.stdout.write(`${JSON.stringify(event)}\n`); }
  safe(text) { return this.secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), plain(text).split('\n')[0].trim()).slice(0, 300); }
  sendActions() { this.write({ type: 'case', caseId: this.approved.id, actions: this.actions.slice(-150) }); }
  onBegin() { this.sendActions(); }
  onStdOut(chunk) {
    this.buffer += String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!this.channel || !line.startsWith(this.channel)) continue;
      let event; try { event = JSON.parse(line.slice(this.channel.length)); } catch { continue; }
      if (event?.caseId !== this.approved.id) continue;
      if (FORWARDED.has(event.type)) {
        if (event.type === 'journey-step') { this.running = event.status === 'running' ? event.stepId : null; this.checkFailed ||= event.status === 'failed'; }
        this.write(event);
      } else if (event.type === 'assertions' && Array.isArray(event.assertions)) this.assertions = event.assertions;
      else if (event.type === 'journey-stop' && typeof event.error === 'string') this.stop ||= event.error;
    }
  }
  // A step inside a fixture, a hook or the fixture's own checks is never a journey action; sign-in is one action.
  action(step) {
    for (let parent = step.parent; parent; parent = parent.parent) if (['fixture', 'hook'].includes(parent.category) || parent.category === 'test.step' && [STEPS.checks, STEPS.signIn].includes(parent.title)) return null;
    if (step.category === 'test.step') return step.title === STEPS.signIn ? 'sign_in_with_test_account' : null;
    return step.category === 'pw:api' ? ACTIONS.find(([pattern]) => pattern.test(step.title))?.[1] || null : null;
  }
  onStepBegin(_test, _result, step) {
    const type = this.action(step);
    if (!type) return;
    this.indexes.set(step, this.actions.length); this.actions.push({ type, status: 'running' }); this.sendActions();
  }
  onStepEnd(_test, _result, step) {
    const index = this.indexes.get(step);
    if (index === undefined) return;
    this.actions[index].status = step.error ? 'failed' : 'passed'; this.sendActions();
  }
  onError(error) { this.errors.push(error); }
  onTestEnd(_test, result) { this.result = result; }
  // Facts, never a verdict: the controller decides status from these, the milestones and the approved case.
  facts() {
    const { id: caseId, steps = [] } = this.approved, result = this.result;
    const base = { caseId, agentCompleted: false, outcomes: [], assertions: this.assertions };
    if (result?.status === 'passed') return { ...base, stopCause: 'none' };
    if (result?.status === 'timedOut') return { ...base, stopCause: 'deadline' };
    // A reviewed check that failed decides the journey; the error that stopped it adds nothing.
    if (this.checkFailed || this.assertions.some(item => item.passed === false)) return { ...base, stopCause: 'none' };
    const title = steps.find(step => step.id === this.running)?.title;
    const error = this.stop || this.safe((result?.errors || this.errors)[0]?.message) || 'The spec stopped before the journey ended.';
    return { ...base, stopCause: 'action', error: title ? `Action failed at “${title}”: ${error}` : error };
  }
  async onEnd(full) {
    for (const action of this.actions) if (action.status === 'running') action.status = 'cancelled';
    this.sendActions();
    // Each page's recording, including a skipped journey's, named as the controller serves it.
    const files = [];
    for (const attachment of this.videoDir ? this.result?.attachments || [] : []) {
      if (attachment.name !== 'video' || !attachment.path) continue;
      const name = `page@${randomBytes(16).toString('hex')}.webm`;
      try { if ((await stat(attachment.path)).size) { await copyFile(attachment.path, join(this.videoDir, name)); files.push(name); } } catch { /* An unfinished recording is left out, never an error. */ }
    }
    if (files.length) this.write({ type: 'video', caseId: this.approved.id, files });
    // Only the controller interrupts a journey, and it decides that journey's result itself.
    if (full.status === 'interrupted') return;
    this.write({ type: 'result', result: this.facts() });
    return { status: 'passed' };
  }
}
