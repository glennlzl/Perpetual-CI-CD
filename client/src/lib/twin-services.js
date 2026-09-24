// Twin service rows for a Sandbox stage. The controller reports the stage's twin
// services and whether each is blocked; Ready needs the stage's latest ready
// environment to report the service ready in its twin. Blocked always wins.
export const TWIN_STATUS = { ready: 'Ready', blocked: 'Blocked', 'not-started': 'Not started' };
export const TWIN_FIDELITY = { actual: 'Actual', 'official-sandbox': 'Official sandbox', emulate: 'Emulate' };
export const TWIN_SOURCE = { settings: 'App Settings' };

export function twinServiceRows(services = [], environment = null) {
  const running = new Set(environment?.status === 'ready' ? (environment.services || []).filter(item => item.status === 'ready').map(item => item.id) : []);
  return services.map(service => {
    const status = service.blocked ? 'blocked' : running.has(service.id) ? 'ready' : 'not-started';
    return { ...service, missing: service.missing || [], status, statusLabel: TWIN_STATUS[status], fidelityLabel: TWIN_FIDELITY[service.fidelity] || service.fidelity, sourceLabel: TWIN_SOURCE[service.source] || '' };
  });
}

/** The PUT /api/twin/inputs body for a service's missing inputs; null until each has a value. */
export function twinInputsRequest(service, values = {}) {
  const inputs = Object.fromEntries(service.missing.map(input => [input.name, String(values[input.name] ?? '').trim()]));
  const entered = Object.values(inputs);
  return entered.length && entered.every(Boolean) ? { service: service.id, inputs } : null;
}

// Inputs are shared by every stage, so one save refreshes every Services list.
let revision = 0;
const listeners = new Set();
export const twinInputsChanges = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  revision: () => revision,
  notify() { revision++; listeners.forEach(listener => listener()); },
};
