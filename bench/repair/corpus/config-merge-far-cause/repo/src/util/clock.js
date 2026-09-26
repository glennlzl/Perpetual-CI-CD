/** The time source: the system clock, or an ISO time fixed for tests. */
export const createClock = fixed => ({ now: () => fixed ?? new Date().toISOString() });
