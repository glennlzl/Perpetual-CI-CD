// Journey gates as the pipeline shows them, read from GET /api/gate. States and commits come
// from the controller's gate records only; nothing here infers a result.
export const GATE_LABELS = { queued: 'Queued', rebuilding: 'Running', running: 'Running', passed: 'Passed', failed: 'Failed', 'needs-release': 'Needs release', released: 'Released' };
const TONES = { queued: 'idle', rebuilding: 'working', running: 'working', passed: 'passed', released: 'passed', failed: 'failed', 'needs-release': 'blocked' };
const short = sha => String(sha || '').slice(0, 7);

export const gateActive = gate => ['rebuilding', 'running'].includes(gate?.status);
export const gatePending = gate => gate?.status === 'queued' || gateActive(gate);
/** Only a gate that needs release offers Release; a failed gate never does. */
export const canRelease = gate => gate?.status === 'needs-release';

export function gateBadge(gate) {
  if (!gate || !GATE_LABELS[gate.status]) return null;
  return { label: GATE_LABELS[gate.status], tone: TONES[gate.status], sha: short(gate.sha), hint: [gate.reason, gate.statusError].filter(Boolean).join(' ') };
}

/** Production is Ready only for a commit every Sandbox gate passed or released. */
export const productionStatus = production => production?.status === 'ready' ? { kind: 'passed', text: 'Ready', sha: short(production.sha) } : null;

/** The commit a gate view reports for the same checkout when the controller moved the managed source there, else null. */
export const sourceMoved = (view, repo) => (view && repo?.path && view.repoPath === repo.path && view.sha && view.sha !== repo.sha ? view.sha : null);

// Unchanged stage gates keep their identity, so memoized stage cards skip unrelated polls.
export function shareGates(previous, next) {
  if (!previous || !next) return next;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (same(previous, next)) return previous;
  const stages = Object.fromEntries(Object.entries(next.stages || {}).map(([id, gate]) => [id, same(previous.stages?.[id], gate) ? previous.stages[id] : gate]));
  return { ...next, stages, production: same(previous.production, next.production) ? previous.production : next.production };
}

// Run now and Release refresh every gate view at once.
const listeners = new Set();
export const gateChanges = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  notify() { listeners.forEach(listener => listener()); },
};

/** Polls the gate view while the page is visible; a failed read shows no gates rather than stale ones. */
export function createGatePoller({ controller, onChange, interval = 3000, document = globalThis.document, timers = globalThis }) {
  let timer, stopped = false, loading = false, again = false;
  const schedule = () => { timers.clearTimeout(timer); if (!stopped && !document?.hidden) timer = timers.setTimeout(poll, interval); };
  async function poll() {
    if (stopped || document?.hidden) return;
    if (loading) { again = true; return; }
    loading = true;
    let next = null;
    try { next = await controller('/api/gate'); } catch { next = null; }
    loading = false;
    if (stopped) return;
    onChange(next);
    if (again) { again = false; void poll(); return; }
    schedule();
  }
  const visibility = () => { if (!document.hidden && !stopped) { timers.clearTimeout(timer); void poll(); } };
  document?.addEventListener?.('visibilitychange', visibility);
  void poll();
  return {
    refresh() { timers.clearTimeout(timer); void poll(); },
    stop() { stopped = true; timers.clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); },
  };
}
