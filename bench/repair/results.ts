// A run's results: one JSON line per attempt in <out>/results.jsonl, appended as each attempt is judged and read back
// tolerantly (a torn last line is skipped), plus per-attempt artifacts under <out>/attempts/<cell>. Everything written
// passes safe.ts: the product's redaction, then the gateway's scrub of the real key.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttemptUsage } from './gateway.ts';
import { safeJson, safeText, type Scrub } from './safe.ts';
import type { AttemptEnd } from './harness.ts';
import type { GuardResult, JudgeReason } from './judge.ts';
import type { Cell } from './schedule.ts';

/** The attempt's final reason: a gateway refusal first, then the runner's deadline, then the adapter's own. */
export type FinalReason = AttemptEnd | 'budget';
export interface DiffStats { bytes: number; files: number; added: number; removed: number; sha256: string }
export interface AttemptRecord {
  run: string; key: string; framework: string; frameworkVersion: string; model: string; case: string; seed: number; startedAt: string;
  /** judged; skipped for the budget; error when the runner itself failed (a box, Docker), which a resumed run retries. */
  status: 'judged' | 'skipped' | 'error'; skipped?: 'budget';
  reason: FinalReason | null; adapterReason: AttemptEnd | null; summary: string; error: string;
  adapterSteps: number; reproduced: boolean | null; frameworkCost: number | null;
  gateway: Omit<AttemptUsage, 'log' | 'attempt' | 'model' | 'cap'> | null;
  wallMs: number; setupMs: number; harnessPaths: string[];
  diff: DiffStats | null; rules: { rejected: string[]; holds: string[] }; guards: GuardResult[]; scriptsChanged: string[];
  judge: { reason: JudgeReason; detail: string; passed: boolean; ciPassed: boolean; steps: { name: string; exit: number; ms: number; timedOut: boolean }[]; ms: number } | null;
  success: boolean; passedWithoutDone: boolean;
}

export const resultPaths = (out: string) => ({
  results: join(out, 'results.jsonl'), boxes: join(out, 'boxes.json'), run: join(out, 'run.json'), report: join(out, 'report.md'),
  cases: join(out, 'cases'), attempts: join(out, 'attempts'), boxRoot: join(out, '.boxes'),
});
/** A cell's artifact folder name: its key with anything but word characters, dots and dashes replaced. */
export const cellFolder = (cell: Pick<Cell, 'framework' | 'model' | 'case' | 'seed'>) => [cell.framework, cell.model, cell.case, `s${cell.seed}`].map(part => String(part).replace(/[^\w.-]+/g, '_')).join('__');

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export async function appendRecord(file: string, record: AttemptRecord, scrub: Scrub) {
  await appendFile(file, `${await safeJson(record, scrub)}\n`, { mode: 0o600 });
}
/** The records of a results file, skipping lines that are not whole records; none when it does not exist. */
export async function readRecords(file: string): Promise<AttemptRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) && typeof parsed.key === 'string' && typeof parsed.framework === 'string' && typeof parsed.case === 'string' && typeof parsed.status === 'string' ? [parsed as unknown as AttemptRecord] : [];
    } catch { return []; }
  });
}
/** Writes an artifact under the attempt's folder: text redacted, or a JSON value redacted string by string; then scrubbed. */
export async function writeArtifact(folder: string, name: string, content: string | Buffer | { json: unknown }, scrub: Scrub) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const text = typeof content === 'string' || Buffer.isBuffer(content) ? await safeText(content, scrub) : await safeJson(content.json, scrub, 2);
  await writeFile(join(folder, name), text, { mode: 0o600 });
}
