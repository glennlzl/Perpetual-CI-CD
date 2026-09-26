// The bench's matrix and its scheduling: cells in an interleaved order (seed, then case, then model, then the
// frameworks), shuffled per seed with a fixed PRNG so a budget cut or provider latency drift falls on every framework
// alike; a worker pool; and resume, which skips cells whose key a results file already holds.

export interface Cell { framework: string; model: string; case: string; seed: number; key: string }
export const cellKey = ({ framework, model, case: name, seed }: Omit<Cell, 'key'>) => `${framework}|${model}|${name}|${seed}`;

/** mulberry32: a small deterministic PRNG in [0, 1). */
export function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6d2b79f5 >>> 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) { const other = Math.floor(random() * (index + 1)); [copy[index], copy[other]] = [copy[other], copy[index]]; }
  return copy;
}

/** Every cell, seed by seed; within a seed, (case, model) blocks in a shuffled order, each with its frameworks shuffled. */
export function matrix({ frameworks, models, cases, seeds, salt = 0 }: { frameworks: readonly string[]; models: readonly string[]; cases: readonly string[]; seeds: number; salt?: number }): Cell[] {
  const cells: Cell[] = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    const random = prng(seed * 7919 + salt);
    const blocks = shuffle(cases.flatMap(name => models.map(model => ({ name, model }))), random);
    for (const { name, model } of blocks) for (const framework of shuffle(frameworks, random)) cells.push({ framework, model, case: name, seed, key: cellKey({ framework, model, case: name, seed }) });
  }
  return cells;
}

/** The cells still to run: those whose key is not in done. */
export const remaining = (cells: readonly Cell[], done: ReadonlySet<string>) => cells.filter(cell => !done.has(cell.key));

/**
 * Runs work over items with at most concurrency at a time, in order. A stopped signal or a failure starts nothing more;
 * the pool waits for the work in flight, so its boxes are removed, then throws the first failure.
 */
export async function pool<T>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0, failed = false;
  const worker = async () => { while (next < items.length && !signal?.aborted && !failed) { const index = next++; await work(items[index], index).catch(error => { failed = true; throw error; }); } };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
