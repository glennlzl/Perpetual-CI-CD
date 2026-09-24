import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../src/server.mjs';

test('browser API uses controller session and source/stage scope, keeps provider key private, and persists without Docker',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-api-')),repo=join(dataDir,'repo');await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  let app=await startServer({port:0,repo,dataDir});t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  let token=(await(await fetch(app.url+'/api/session')).json()).token;
  async function request(path,body,headers={}){const response=await fetch(app.url+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json','X-Perpetual-Token':token}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}
  assert.equal((await request('/api/scan',{path:repo})).status,200);
  const stage=(await request('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'})).body.pipeline.stages.find(item=>item.name==='Beta').id;
  const query=new URLSearchParams({repoPath:repo,stageId:stage}),context={repoPath:repo,stageId:stage};
  assert.equal((await request(`/api/browser?${query}`,undefined,{Origin:'https://other.example'})).status,403);
  for(const operation of ['model','config','cases','discover','run','stop'])assert.equal((await request(`/api/browser/${operation}`,context,{'X-Perpetual-Token':'wrong'})).status,403);
  assert.equal((await request('/api/browser/config',{...context,stageId:'production',config:{targetUrl:'http://localhost:3000'}})).status,400);
  assert.equal((await request('/api/browser/config',{...context,repoPath:'/not-active',config:{targetUrl:'http://localhost:3000'}})).status,409);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:app.url}})).status,400);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000',externalOrigins:['https://checkout.stripe.com/pay']}})).status,400);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000',authEndpoints:['http://elsewhere.test/auth']}})).status,400);
  const journeyConfig=await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000',journeyTimeoutSeconds:600,externalOrigins:['https://checkout.stripe.com'],authEndpoints:['http://localhost:55888/auth/v1/token']}});
  assert.equal(journeyConfig.status,200);assert.deepEqual([journeyConfig.body.config.journeyTimeoutSeconds,journeyConfig.body.config.externalOrigins,journeyConfig.body.config.authEndpoints],[600,['https://checkout.stripe.com'],['http://localhost:55888/auth/v1/token']]);
  assert.equal((await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000'}})).status,200);
  const invalidAccount=await request('/api/browser/run',{...context,credentials:{username:'private-login-fixture-only'}});
  assert.equal(invalidAccount.status,400);assert.match(invalidAccount.body.error,/test account/i);
  assert.equal(JSON.stringify(invalidAccount).includes('private-login-fixture-only'),false);
  const key='private-openrouter-fixture-only';
  const configured=await request('/api/browser/model',{...context,apiKey:key});assert.equal(configured.status,200);assert.equal(configured.body.capabilities.model,'openai/gpt-5.4-mini');assert.equal(JSON.stringify(configured).includes(key),false);
  let view=await request(`/api/browser?${query}`);assert.equal(view.body.config.targetUrl,'http://localhost:3000/');assert.equal(view.body.capabilities.keyConfigured,true);assert.equal(JSON.stringify(view).includes(key),false);
  assert.equal((await request(`/api/browser/runs/00000000-0000-0000-0000-000000000000/frame?${query}`)).status,404);
  const recording=`/api/browser/runs/00000000-0000-0000-0000-000000000000/video?${new URLSearchParams({...context,caseId:'x',file:`page@${'0'.repeat(32)}.webm`})}`;
  assert.equal((await request(recording)).status,404);
  assert.equal((await request(recording,undefined,{Origin:'https://other.example'})).status,403);
  const original={id:'checkout',name:'Complete checkout',goal:'Buy a product',expectedOutcomes:['Order saved'],needsReview:true,selected:false};
  const saved=await request('/api/browser/cases',{...context,cases:[original]});assert.equal(saved.status,200);
  const baseCases=saved.body.cases;
  const newer=await request('/api/browser/cases',{...context,cases:[...baseCases,{...original,id:'refund',name:'Complete refund'}],baseCases});assert.equal(newer.status,200);
  const stale=await request('/api/browser/cases',{...context,cases:[{...baseCases[0],needsReview:false}],baseCases});assert.equal(stale.status,409);assert.match(stale.body.error,/changed/i);
  assert.deepEqual((await request(`/api/browser?${query}`)).body.cases,newer.body.cases);
  await app.close();app=await startServer({port:0,repo,dataDir});token=(await(await fetch(app.url+'/api/session')).json()).token;
  view=await request(`/api/browser?${query}`);assert.equal(view.body.capabilities.keyConfigured,true);assert.equal(view.body.config.targetUrl,'http://localhost:3000/');assert.deepEqual(view.body.runs,[]);assert.deepEqual(view.body.cases,newer.body.cases);
});

test('journey specs are saved and approved through the stage API, and a run names the engine',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-specs-api-')),repo=join(dataDir,'repo');await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  const app=await startServer({port:0,repo,dataDir});t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const token=(await(await fetch(app.url+'/api/session')).json()).token;
  async function request(path,body,headers={}){const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':token,...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
  await request('/api/scan',{path:repo});
  const stageId=(await request('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'})).body.pipeline.stages.find(item=>item.name==='Beta').id,context={repoPath:repo,stageId};
  await request('/api/browser/config',{...context,config:{targetUrl:'http://localhost:3000'}});
  const item={id:'rename',name:'Rename',goal:'Rename the workspace',steps:[{id:'open',title:'Open Settings'},{id:'rename',title:'Rename it'}],expectedOutcomes:['Renamed'],assertions:[{type:'text-visible',value:'Renamed'}],needsReview:false,selected:true};
  assert.equal((await request('/api/browser/cases',{...context,cases:[item]})).status,200);
  const code="import { test } from 'perpetual';\ntest('Rename', async ({ journey }) => {\n  await journey.milestone('open', async () => {});\n  await journey.milestone('rename', async () => {});\n});\n";
  for(const operation of ['specs','specs/approve','specs/generate','specs/generate/cancel'])assert.equal((await request(`/api/browser/${operation}`,{...context,caseId:item.id,code},{'X-Perpetual-Token':'wrong'})).status,403);
  assert.equal((await request('/api/browser/specs',{...context,caseId:item.id,code:code.replace("'open'","'other'")})).status,400);
  const saved=await request('/api/browser/specs',{...context,caseId:item.id,code});
  assert.equal(saved.status,200);assert.equal(saved.body.spec.approved,false);
  assert.equal((await request('/api/browser/specs/approve',{...context,caseId:item.id,hash:'0'.repeat(64)})).status,409);
  assert.equal((await request('/api/browser/specs/approve',{...context,caseId:'missing',hash:saved.body.spec.hash})).status,404);
  // A draft is approved only after a passing Playwright run of exactly its code.
  const unverified=await request('/api/browser/specs/approve',{...context,caseId:item.id,hash:saved.body.spec.hash});
  assert.equal(unverified.status,409);assert.match(unverified.body.error,/approve it after it passes/);
  const view=await(await fetch(`${app.url}/api/browser?${new URLSearchParams(context)}`)).json();
  assert.deepEqual(view.specs,{[item.id]:{hash:saved.body.spec.hash,approved:false,stale:false}});assert.equal(JSON.stringify(view).includes('journey.milestone'),false,'The view never carries spec code.');
  // Generation needs a reviewed case, a model and the stage's ready twin; it never starts on its own.
  assert.equal((await request('/api/browser/specs/generate',{...context,caseId:'missing'})).status,404);
  const noModel=await request('/api/browser/specs/generate',{...context,caseId:item.id});
  assert.equal(noModel.status,400);assert.match(noModel.body.error,/OpenRouter API key/);
  assert.equal((await request('/api/browser/specs/generate/cancel',{...context,caseId:item.id})).status,404);
  const invalid=await request('/api/browser/run',{...context,engine:'selenium'});
  assert.equal(invalid.status,400);assert.match(invalid.body.error,/Browser Use or Playwright/);
});
