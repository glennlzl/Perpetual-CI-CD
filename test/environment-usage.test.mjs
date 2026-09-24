import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../src/environments/usage.mjs';

const beta={key:'repo',stageId:'beta'},gamma={key:'repo',stageId:'gamma'};
test('one owned environment cannot be used by two stages; unrelated environments remain available',()=>{
  const usage=module.createEnvironmentUsage();
  const done=usage.acquire(beta,{environmentId:'one',operation:'browser test'});
  assert.throws(()=>usage.acquire(gamma,{environmentId:'one',operation:'reset'}),{statusCode:409});
  const other=usage.acquire(beta,{environmentId:'two',operation:'script'});
  assert.equal(usage.isBusy('one'),true);other();done();done();
  const next=usage.acquire(gamma,{environmentId:'one',operation:'reset'});next();
  assert.equal(usage.isBusy('one'),false);
});
test('removal reserves both its stage and environments against cross-stage activity',()=>{
  const usage=module.createEnvironmentUsage();
  const active=usage.acquire(gamma,{environmentId:'one',operation:'browser test'});
  assert.throws(()=>usage.beginRemoval(beta,['one']),{statusCode:409});active();
  const external=usage.acquire(beta,{operation:'external browser test'});
  assert.throws(()=>usage.beginRemoval(beta,['one']),{statusCode:409});external();
  const token=usage.beginRemoval(beta,['one']);
  assert.throws(()=>usage.acquire(beta,{operation:'create'}),{statusCode:409});
  assert.throws(()=>usage.acquire(gamma,{environmentId:'one',operation:'browser test'}),{statusCode:409});
  assert.throws(()=>usage.acquire(gamma,{environmentId:'one',operation:'destroy',removalToken:token}),{statusCode:409});
  const cleanup=usage.acquire(beta,{environmentId:'one',operation:'destroy',removalToken:token});cleanup();
  usage.endRemoval(token);const next=usage.acquire(beta,{environmentId:'one'});next();
});
test('shutdown stops admissions without silently releasing live work',()=>{
  const usage=module.createEnvironmentUsage();const done=usage.acquire(beta,{environmentId:'one'});
  usage.stopAdmissions();assert.equal(usage.isBusy('one'),true);
  assert.throws(()=>usage.acquire(gamma,{}),{statusCode:409});
  assert.throws(()=>usage.beginRemoval(gamma,[]),{statusCode:409});
  done();assert.equal(usage.isBusy('one'),false);
});
