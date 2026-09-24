import { setTimeout as delay } from 'node:timers/promises';

// A gate's work on the controller: rebuild the stage's twin through the environments manager,
// then run its reviewed, selected journeys through the browser manager.

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const WORKING = ['queued', 'creating', 'preparing', 'destroying'];
// A twin that has yet to copy the source; a gate may move the source in place.
const COPYING = ['queued', 'creating'];
const RUNNING = ['queued', 'running'];
// An environment that still holds resources; the same rule stage removal applies.
const owned = item => item.status !== 'destroyed' && !(item.status === 'failed' && (!item.sandboxId || item.cleanedAt));
export const reviewedJourneys = cases => (cases || []).filter(item => item.selected && !item.needsReview);

// Settles with the promise, or rejects once the controller shuts down.
function untilStopped(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(conflict('The controller is shutting down.'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
// The timer ends with the controller, so shutdown never waits out a poll interval.
const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(error => { throw error?.name === 'AbortError' ? conflict('The controller is shutting down.') : error; });

/** Remembers each ready environment's browser preparation, which the environments manager runs after readiness. */
export function createReadiness() {
  const entries = new Map();
  function entry(id) {
    let value = entries.get(id);
    if (!value) { let resolve; value = { promise: new Promise(done => { resolve = done; }) }; value.resolve = resolve; entries.set(id, value); }
    return value;
  }
  return { done: id => entry(id).resolve(), wait: id => entry(id).promise, forget: id => { entries.delete(id); } };
}

/**
 * checkout(gate) -> the stage context with the source at gate.sha (409: not now).
 * readiness: createReadiness(), resolved by the environments manager's onReady hook.
 */
export function createGateSteps({ environments, browser, checkout, readiness, signal, interval = 2000 }) {
  return {
    async prepare(gate) {
      const stage = { key: gate.key, stageId: gate.stageId };
      // A person's run or environment operation on this stage finishes first, and every twin of the
      // pipeline finishes copying the source before the source can move.
      if (browser.isActive(stage) || environments.summaries(gate.key).some(item => (item.stageId === gate.stageId ? WORKING : COPYING).includes(item.status))) throw conflict('This stage is busy.');
      return checkout(gate);
    },
    journeys: context => reviewedJourneys(browser.summary(context).cases).length,
    async rebuild(context) {
      for (const item of environments.summaries(context.key).filter(item => item.stageId === context.stageId && owned(item))) {
        await environments.destroy(context, item.id);
        const result = await environments.awaitIdle(item.id);
        if (result.status !== 'destroyed') throw new Error(result.error || 'The previous twin could not be deleted.');
      }
      const { environment } = await environments.create(context);
      try {
        const twin = await environments.awaitIdle(environment.id);
        if (twin.status !== 'ready') throw new Error(twin.error || 'The twin did not become ready.');
        // Browser preparation points an automatic application URL at the new twin.
        await untilStopped(readiness.wait(environment.id), signal);
        return twin;
      } finally { readiness.forget(environment.id); }
    },
    async run(context, twin) {
      const { config } = await browser.view(context);
      if (!config.targetUrl || environments.resolveTarget(config.targetUrl)?.id !== twin.id) throw new Error('Set the application URL to the rebuilt twin.');
      const { run } = await browser.run(context, {});
      for (;;) {
        const { run: current } = await browser.runProgress(context, run.id);
        if (!RUNNING.includes(current.status)) return current;
        await pause(interval, signal);
      }
    },
  };
}
