// Results files: appended scrubbed, read back tolerantly, and folder names safe for any model id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_KEY } from '../fake-upstream.ts';
import { createGateway } from '../gateway.ts';
import { appendRecord, cellFolder, readRecords, writeArtifact, type AttemptRecord } from '../results.ts';

test('records and artifacts pass the gateway\'s scrub, so the key never reaches a results file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-results-'));
  const gateway = await createGateway({ key: FAKE_KEY, budget: 1, upstream: 'http://127.0.0.1:9/api/v1' });
  t.after(async () => { await gateway.stop(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'results.jsonl');
  const record = { key: 'aisdk|m|c|1', framework: 'aisdk', case: 'c', status: 'judged', error: `upstream said ${FAKE_KEY}`, summary: 'Authorization: Bearer abc.def' } as unknown as AttemptRecord;
  await appendRecord(file, record, gateway.scrub);
  await appendFile(file, '{"key": "torn');
  await writeArtifact(join(dir, 'attempts', 'x'), 'events.jsonl', `{"output":"${FAKE_KEY}"}`, gateway.scrub);
  const text = await readFile(file, 'utf8') + await readFile(join(dir, 'attempts', 'x', 'events.jsonl'), 'utf8');
  assert.ok(!text.includes(FAKE_KEY));
  assert.match(text, /"summary":"Authorization: \[REDACTED\]/, 'The product\'s redaction scrubs the header value.');
  const read = await readRecords(file);
  assert.deepEqual(read.map(item => item.key), ['aisdk|m|c|1'], 'A torn last line is skipped.');
  assert.deepEqual(await readRecords(join(dir, 'missing.jsonl')), []);
  assert.equal(cellFolder({ framework: 'openai-agents', model: 'openai/gpt-5.1:thinking', case: 'lock-drift', seed: 2 }), 'openai-agents__openai_gpt-5.1_thinking__lock-drift__s2');
});
