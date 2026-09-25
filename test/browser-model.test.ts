import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,stat,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserModelSettings} from '../src/browser/model.ts';

test('OpenRouter key is persisted privately, omitted from view, and retained during model changes',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-model-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const model=await createBrowserModelSettings({dataDir,env:{}});
  assert.equal(model.view().keyConfigured,false);
  await model.save({apiKey:'openrouter-private-fixture'});
  assert.equal(model.environment().PERPETUAL_MODEL_API_KEY,'openrouter-private-fixture');
  assert.equal(model.environment().PERPETUAL_MODEL,'openai/gpt-5.4-mini');
  assert.equal(JSON.stringify(model.view()).includes('private-fixture'),false);
  assert.equal((await stat(join(dataDir,'browser-model.json'))).mode&0o777,0o600);
  await model.save({model:'anthropic/claude-sonnet-4.6'});
  assert.equal(model.environment().PERPETUAL_MODEL_API_KEY,'openrouter-private-fixture');
  await assert.rejects(model.save({model:'typesafe/jev-1'}),/decisions API/);
  await assert.rejects(model.save({baseUrl:'http://example.com'}),/HTTPS/);
  assert.equal(JSON.parse(await readFile(join(dataDir,'browser-model.json'),'utf8')).model,'anthropic/claude-sonnet-4.6');
  const restored=await createBrowserModelSettings({dataDir,env:{}});assert.equal(restored.environment().PERPETUAL_MODEL_API_KEY,'openrouter-private-fixture');
});

test('generic provider credentials require an explicit model while an empty install shows OpenRouter defaults',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-generic-model-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const generic=await createBrowserModelSettings({dataDir,env:{PERPETUAL_MODEL_API_KEY:'generic-private-fixture'}});
  assert.equal(generic.view().keyConfigured,true);
  assert.equal(generic.view().modelConfigured,false);
  assert.equal(generic.view().model,'');
  assert.equal(generic.environment().PERPETUAL_MODEL,'');
  assert.equal(generic.environment().PERPETUAL_MODEL_BASE_URL,'https://api.openai.com/v1');
  const empty=await createBrowserModelSettings({dataDir,env:{}});
  assert.equal(empty.view().model,'openai/gpt-5.4-mini');
  assert.equal(empty.view().baseUrl,'https://openrouter.ai/api/v1');
  assert.equal(empty.view().modelConfigured,false);
  const openRouter=await createBrowserModelSettings({dataDir,env:{OPENROUTER_API_KEY:'openrouter-private-fixture'}});
  assert.equal(openRouter.environment().PERPETUAL_MODEL,'openai/gpt-5.4-mini');
  assert.equal(openRouter.view().modelConfigured,true);
});

test('generic credentials do not inherit the OpenRouter model or endpoint when both keys exist',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-model-precedence-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const model=await createBrowserModelSettings({dataDir,env:{PERPETUAL_MODEL_API_KEY:'generic-fixture-only',OPENROUTER_API_KEY:'router-fixture-only'}});
  assert.equal(model.view().modelConfigured,false);
  assert.match(model.view().modelError!,/model ID/i);
  assert.equal(model.environment().PERPETUAL_MODEL,'');
  assert.equal(model.environment().PERPETUAL_MODEL_BASE_URL,'https://api.openai.com/v1');
  assert.doesNotMatch(JSON.stringify(model.view()),/generic-fixture-only|router-fixture-only/);
});

test('saved settings that are not text configure no model and show no value',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-model-invalid-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await writeFile(join(dataDir,'browser-model.json'),JSON.stringify({apiKey:12345,model:{id:'x'},baseUrl:['https://x']}));
  const model=await createBrowserModelSettings({dataDir,env:{}});
  assert.deepEqual(model.view(),{provider:'custom',model:'',baseUrl:'',keyConfigured:false,modelConfigured:false,modelError:'Configure a model API key to use the browser agent.'});
  assert.deepEqual(model.environment(),{PERPETUAL_MODEL_API_KEY:'',PERPETUAL_MODEL:'',PERPETUAL_MODEL_BASE_URL:''});
});
