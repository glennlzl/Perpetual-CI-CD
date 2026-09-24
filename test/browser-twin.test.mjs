import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrowserManager} from '../src/browser/manager.mjs';

// A twin environment as the twin runtime reports it: app URLs on host.docker.internal and
// each service's status, with a blocked service's missing inputs.
const WEB='http://host.docker.internal:43100',API='http://host.docker.internal:43101';
const twin={id:'twin-beta',stageId:'beta',status:'ready',apps:[{id:'service-api',url:API},{id:'service-web',url:WEB}],
  services:[{id:'postgres',fidelity:'actual',status:'ready'},{id:'stripe',fidelity:'official-sandbox',status:'blocked',missing:['secretKey']}]};
const journey={id:'upgrade',name:'Upgrade the plan',goal:'Sign in, pay for the Pro plan and see it active',steps:[{id:'open',title:'Open billing'},{id:'pay',title:'Pay for the Pro plan'}],
  expectedOutcomes:['The Pro plan is active'],assertions:[{type:'text-visible',value:'Pro'}],selected:true,needsReview:false};

async function fixture(t,{environments=[twin],events=()=>[]}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-twin-'));
  await mkdir(join(dataDir,'repo'));await writeFile(join(dataDir,'repo','app.js'),'export const page="Billing";');
  const requests=[];
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(input,onEvent){
    requests.push(structuredClone(input));
    return {cancel(){},promise:delay(5).then(()=>{for(const event of events(input))onEvent(event);})};
  }};
  const resolveEnvironment=url=>environments.find(item=>item.apps.some(app=>app.url===new URL(url).origin))||null;
  const manager=await createBrowserManager({dataDir,runtime,resolveEnvironment});
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context=stageId=>({key:'repo',stageId,controllerOrigin:'http://127.0.0.1:4317',
    scan:{repo:{path:join(dataDir,'repo'),sha:'abc'},services:[{id:'service:web',framework:'Next.js'},{id:'service:api',framework:'Hono'}]}});
  return {manager,context,requests};
}
async function settled(read){for(let i=0;i<200;i++){const value=await read();if(value)return value;await delay(5);}throw new Error('Operation did not settle.');}
const prepared=(f,context)=>settled(()=>{const {preparation}=f.manager.summary(context);return preparation&&!['preparing','discovering'].includes(preparation.status)&&preparation;});
const finished=(f,context,id)=>settled(async()=>{const report=await f.manager.runProgress(context,id);return !['queued','running'].includes(report.run.status)&&report;});
const discovered=()=>[{type:'discovery',summary:'Billing observed',cases:[{...journey,id:'drafted',selected:false,needsReview:true}]}];

test('a twin stage targets its web app by default and keeps an explicit target',async t=>{
  const single={...twin,id:'twin-gamma',stageId:'gamma',apps:[{id:'app',url:'http://host.docker.internal:43200'}],services:[]};
  const f=await fixture(t,{environments:[twin,single],events:discovered});
  const beta=f.context('beta');
  await f.manager.prepareEnvironment(beta,twin);
  assert.equal((await prepared(f,beta)).status,'completed');
  assert.equal((await f.manager.view(beta)).config.targetUrl,`${WEB}/`);
  // Discovery may open every app of the twin; unavailable services only matter to runs.
  assert.deepEqual(f.requests[0],{...f.requests[0],mode:'discover',targetUrl:`${WEB}/`,allowedOrigins:[WEB,API]});
  assert.equal('unavailableServices' in f.requests[0],false);
  // Without a recognized web frontend, the twin's only app is the target.
  const gamma=f.context('gamma');
  await f.manager.prepareEnvironment(gamma,single);
  await prepared(f,gamma);
  assert.equal((await f.manager.view(gamma)).config.targetUrl,'http://host.docker.internal:43200/');
  // A target the user chose survives a new twin.
  const chosen=f.context('chosen');
  await f.manager.saveConfig(chosen,{targetUrl:'https://preview.example/billing'});
  await f.manager.prepareEnvironment(chosen,{...twin,id:'twin-chosen',stageId:'chosen'});
  await prepared(f,chosen);
  assert.equal((await f.manager.view(chosen)).config.targetUrl,'https://preview.example/billing');
  assert.equal(f.requests.at(-1).targetUrl,'https://preview.example/billing');
});

test('a twin with several apps and no web frontend asks for the application URL',async t=>{
  const f=await fixture(t,{events:discovered});
  const beta={...f.context('beta'),scan:{...f.context('beta').scan,services:[]}};
  await f.manager.prepareEnvironment(beta,twin);
  const preparation=await prepared(f,beta);
  assert.equal(preparation.status,'needs_setup');
  assert.match(preparation.error,/Choose the application URL/);
  assert.equal((await f.manager.view(beta)).config.targetUrl,'');
  assert.equal(f.requests.length,0);
});

test('a twin run allows its apps and turns an unavailable service into an integration blocker',async t=>{
  const events=input=>input.mode!=='run'?[]:[
    {type:'journey-step',caseId:journey.id,stepId:'open',status:'running'},
    {type:'journey-step',caseId:journey.id,stepId:'open',status:'completed',evidence:'Billing page shows the Free plan'},
    {type:'journey-step',caseId:journey.id,stepId:'pay',status:'running'},
    {type:'journey-step',caseId:journey.id,stepId:'pay',status:'blocked',evidence:'Checkout needs Stripe, which is unavailable'},
    {type:'result',result:{caseId:journey.id,stopCause:'none',agentCompleted:false,outcomes:[{outcomeIndex:0,status:'uncertain',evidence:'Payment was not possible'}],
      assertions:[{...journey.assertions[0],passed:false}],blockers:[{stepId:'pay',kind:'integration',evidence:'Stripe is unavailable: secretKey is missing'}]}},
  ];
  const f=await fixture(t,{events});
  const beta=f.context('beta');
  await f.manager.saveConfig(beta,{targetUrl:`${WEB}/billing`,externalOrigins:['https://checkout.stripe.com']});
  await f.manager.saveCases(beta,[journey]);
  const {run}=await f.manager.run(beta,{});
  const report=await finished(f,beta,run.id);
  assert.deepEqual(f.requests[0].allowedOrigins,[WEB,API,'https://checkout.stripe.com']);
  assert.deepEqual(f.requests[0].unavailableServices,[{id:'stripe',title:'Stripe',missing:['secretKey']}]);
  assert.equal(report.run.status,'blocked');
  assert.equal(report.results[0].status,'blocked');
  assert.equal(report.results[0].error,'Blocked at milestone: Pay for the Pro plan.');
  assert.deepEqual(report.results[0].blockers,[{stepId:'pay',kind:'integration',evidence:'Stripe is unavailable: secretKey is missing'}]);
});

test('a run outside a twin names no unavailable services',async t=>{
  const events=input=>[{type:'result',result:{caseId:input.case.id,stopCause:'none',outcomes:[],assertions:[]}}];
  const f=await fixture(t,{events});
  const beta=f.context('beta');
  await f.manager.saveConfig(beta,{targetUrl:'http://localhost:3000/'});
  await f.manager.saveCases(beta,[journey]);
  const {run}=await f.manager.run(beta,{});
  await finished(f,beta,run.id);
  assert.deepEqual(f.requests[0].allowedOrigins,['http://localhost:3000']);
  assert.equal('unavailableServices' in f.requests[0],false);
});
