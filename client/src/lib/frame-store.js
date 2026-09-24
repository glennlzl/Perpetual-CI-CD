const EMPTY = Object.freeze({ identity: '', url: '', error: '', receivedAt: 0, checkedAt: 0 });
const streaming = status => ['running', 'skipping', 'cancelling'].includes(status);
const modeOf = status => streaming(status) ? 'stream' : ['queued', 'pending'].includes(status) ? 'idle' : 'final';
export const frameIdentity = ({ repoPath = '', stageId = '', runId = '', caseId = '' }) => JSON.stringify([repoPath, stageId, runId, caseId]);

// One fetch loop per journey identity, shared by every viewport showing it. A loop
// runs only while someone watches a visible page; no frame is reused across identities.
// Under reduced motion a new journey revision refreshes no sooner than reducedFloor after the last frame.
export function createFrameStore({ load, hidden = () => false, reducedMotion = () => false, createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url), reducedInterval = 5000, reducedFloor = 2000 }) {
  const entries = new Map();
  function dispose(entry) {
    clearTimeout(entry.timer); entry.request?.abort(); entry.request = null;
    if (entry.snapshot.url) revokeUrl(entry.snapshot.url);
    entries.delete(entry.identity);
  }
  function schedule(entry) {
    clearTimeout(entry.timer); entry.timer = undefined;
    if (!entry.subscribers.size || entry.request || hidden() || ['idle', 'done'].includes(entry.mode)) return;
    if (entry.mode === 'final') return void capture(entry);
    const interval = !reducedMotion() ? Math.min(...[...entry.subscribers.values()].map(item => item.interval)) : entry.fetchedRevision !== entry.revision ? reducedFloor : reducedInterval;
    const wait = entry.fetchedAt + interval - Date.now();
    if (wait <= 0) return void capture(entry);
    entry.timer = setTimeout(() => schedule(entry), wait);
  }
  async function capture(entry) {
    const request = new AbortController(), mode = entry.mode, revision = entry.revision;
    entry.request = request;
    let url = '', error = '';
    try { const blob = await load(entry.source, request.signal); if (blob && !request.signal.aborted) url = createUrl(blob); }
    catch (failure) { error = failure?.message || 'Stream unavailable'; }
    if (entry.request !== request) { if (url) revokeUrl(url); return; }
    entry.request = null; entry.fetchedAt = Date.now(); entry.fetchedRevision = revision;
    if (mode === 'final' && entry.mode === 'final') entry.mode = 'done';
    const previous = entry.snapshot.url;
    entry.snapshot = { identity: entry.identity, url: url || previous, error, receivedAt: url ? entry.fetchedAt : entry.snapshot.receivedAt, checkedAt: entry.fetchedAt };
    if (url && previous) revokeUrl(previous);
    for (const { listener } of [...entry.subscribers.values()]) listener();
    schedule(entry);
  }
  function update(entry, { status, revision }) {
    if (revision !== undefined) entry.revision = revision;
    const mode = modeOf(status);
    // A terminal journey never streams again, even if a lagging view still reports it active.
    if (mode === 'final') { entry.terminal = true; if (entry.mode !== 'done') entry.mode = 'final'; }
    else if (!entry.terminal) entry.mode = mode;
  }
  return {
    subscribe(source, listener, { interval = 350, status, revision } = {}) {
      const identity = frameIdentity(source);
      let entry = entries.get(identity);
      if (!entry) { entry = { identity, source: { ...source }, subscribers: new Map(), snapshot: { ...EMPTY, identity }, mode: 'idle', terminal: false, revision, fetchedRevision: undefined, fetchedAt: -Infinity, request: null, timer: undefined }; entries.set(identity, entry); }
      const token = {};
      entry.subscribers.set(token, { listener, interval });
      update(entry, { status, revision });
      schedule(entry);
      return () => { entry.subscribers.delete(token); if (!entry.subscribers.size && entries.get(identity) === entry) dispose(entry); };
    },
    update(source, next) { const entry = entries.get(frameIdentity(source)); if (entry) { update(entry, next); schedule(entry); } },
    getSnapshot: source => entries.get(frameIdentity(source))?.snapshot || EMPTY,
    resume() { for (const entry of entries.values()) schedule(entry); },
    size: () => entries.size,
  };
}

export async function fetchJourneyFrame({ repoPath, stageId, runId, caseId }, signal) {
  const response = await fetch(`/api/browser/runs/${encodeURIComponent(runId)}/frame?${new URLSearchParams({ repoPath, stageId, caseId })}`, { headers: { Accept: 'image/jpeg' }, cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  if (response.status === 204) return null;
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Stream unavailable');
  return response.blob();
}

let shared;
export function sharedFrameStore() {
  if (shared) return shared;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  shared = createFrameStore({ load: fetchJourneyFrame, hidden: () => document.hidden, reducedMotion: () => motion.matches });
  document.addEventListener('visibilitychange', shared.resume);
  motion.addEventListener('change', shared.resume);
  return shared;
}
