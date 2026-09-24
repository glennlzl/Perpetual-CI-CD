import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRemote, normalizeGitHubRuns, diagnoseFailure, redact } from '../src/providers.mjs';
test('GitHub remote parser rejects non-GitHub and user-supplied command material',()=>{
  assert.equal(parseGitHubRemote('git@github.com:acme/storefront.git'),'acme/storefront');
  assert.equal(parseGitHubRemote('https://github.com/acme/storefront.git'),'acme/storefront');
  assert.equal(parseGitHubRemote('https://evil.com/acme/storefront'),null);
  assert.equal(parseGitHubRemote('$(cat ~/.env)'),null);
});
test('old successful SHA and skipped run never count as current commit success',()=>{
  const runs=normalizeGitHubRuns([{id:1,head_sha:'old',conclusion:'success',status:'completed'},{id:2,head_sha:'new',conclusion:'skipped',status:'completed'}],'new');
  assert.equal(runs[0].matchesCommit,false); assert.equal(runs[1].conclusion,'skipped');
});
test('missing credentials are classified as configuration, not a code failure',()=>{
  assert.equal(diagnoseFailure('Error: VERCEL_TOKEN is required').category,'configuration');
  assert.equal(diagnoseFailure('ERR_PNPM_OUTDATED_LOCKFILE').category,'dependency');
});
test('redacts common credential strings before persistence',()=>{
  const input='Authorization: Bearer abc123\nAPI_KEY=abcdef\nhttps://u:pass@example.com';
  const result=redact(input);assert.ok(!result.includes('abc123'));assert.ok(!result.includes('abcdef'));assert.ok(!result.includes('u:pass'));
});
test('redaction handles long ordinary source without corrupting it',()=>{
  const source='a'.repeat(220000);assert.equal(redact(source),source);
});
test('redacts JSON credential fields and Basic authorization payloads',()=>{
  const result=redact('{"API_KEY":"sensitive-value"}\nAuthorization: Basic abcDEF123==');
  assert.ok(!result.includes('sensitive-value'));assert.ok(!result.includes('abcDEF123'));
});
