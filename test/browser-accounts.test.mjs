import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrowserManager} from '../src/browser/manager.mjs';
import {createEnvironmentUsage} from '../src/environments/usage.mjs';
import {createTwinRuntime} from '../src/twin/runtime.mjs';

// A twin whose service signs up two test accounts. The actual twin runtime writes its private
// state; only the Docker CLI is replaced. The browser manager reads the password from that state.
const auth={id:'auth',title:'Auth',fidelity:'actual',containers:()=>[{name:'auth',image:'auth/server:1.0',ports:{api:9999}}],env:ctx=>({AUTH_URL:ctx.url('api')}),
  accounts:async ctx=>ctx.options.users.map(id=>({id,label:`${id[0].toUpperCase()}${id.slice(1)}`,username:`${id}@example.test`,password:`pw-${id}-${Math.random().toString(36).slice(2)}`}))};
const journey=(id,name)=>({id,name,goal:`${name} and see it saved`,steps:[{id:'sign-in',title:'Sign in'},{id:'save',title:name}],expectedOutcomes:['It is saved'],assertions:[],selected:true,needsReview:false,isolation:'isolated'});
const journeys=[journey('create','Create a workspace'),journey('invite','Invite a teammate')];

async function fixture(t,{authEndpoints=[],service=auth}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-browser-accounts-')),source=join(dataDir,'source'),repo=join(dataDir,'repo');
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await mkdir(source);await mkdir(repo);await writeFile(join(repo,'app.js'),'export const page="Workspace";');
  const twin=createTwinRuntime({exec:async()=>({stdout:'',stderr:''}),services:{auth:service},isFree:async()=>true});
  const prepared=await twin.prepare({dataDir,id:'twin-beta',source,config:{services:{auth:{users:['owner','viewer']}},apps:{web:{start:'node server.js',port:3000}}}});
  const state=JSON.parse(await readFile(join(dataDir,'environments','twin-beta','twin','twin.json'),'utf8'));
  const passwords=Object.fromEntries(state.accounts.map(account=>[account.id,account.password]));
  const environment={id:'twin-beta',stageId:'beta',status:'ready',sandboxId:'twin-beta',apps:prepared.apps,services:prepared.services,accounts:prepared.accounts};
  const environments=[environment];
  const requests=[];
  // The worker names the account it signed in with, as its evidence might.
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),start(input,onEvent){
    requests.push(structuredClone(input));
    const seen=input.credentials?.username||'nobody';
    return {cancel(){},promise:delay(5).then(()=>{
      if(input.mode==='discover')onEvent({type:'discovery',summary:`Explored as ${seen}`,authenticated:!!input.credentials,cases:[{...journey('drafted','Archive a workspace'),selected:false,needsReview:true}]});
      else onEvent({type:'result',result:{caseId:input.case.id,stopCause:'none',agentCompleted:false,outcomes:[{outcomeIndex:0,status:'uncertain',evidence:`Signed in as ${seen}`}],assertions:[]}});
    })};
  }};
  const resolveEnvironment=url=>environments.find(item=>item.apps.some(app=>new URL(app.url).origin===new URL(url).origin))||null;
  const usage=createEnvironmentUsage();
  const manager=await createBrowserManager({dataDir,runtime,usage,resolveEnvironment});
  t.after(()=>manager.close());
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:repo,sha:'abc'},services:[]}};
  const web=prepared.apps[0].url;
  await manager.saveConfig(context,{targetUrl:`${web}/`,authEndpoints});
  await manager.saveCases(context,journeys);
  // A run releases its environment once its result is saved, so the next run on it waits for that too.
  const finished=async id=>{for(let i=0;i<400;i++){const report=await manager.runProgress(context,id);if(!['queued','running'].includes(report.run.status)&&!(report.run.environmentId&&usage.isBusy(report.run.environmentId)))return report;await delay(5);}throw new Error('Run did not finish.');};
  const run=async input=>{const response=await manager.run(context,input);return {response,report:await finished(response.run.id),request:requests.at(-1)};};
  return {dataDir,manager,context,requests,passwords,environment,environments,web,run,finished};
}
const hidesPasswords=(f,value,where)=>{const text=typeof value==='string'?value:JSON.stringify(value);for(const password of Object.values(f.passwords))assert.ok(!text.includes(password),where);};

test('the browser view offers the target twin\'s accounts by label and username, never a password',async t=>{
  const f=await fixture(t);
  const view=await f.manager.view(f.context);
  assert.deepEqual(view.accounts,[{id:'owner',label:'Owner',username:'owner@example.test'},{id:'viewer',label:'Viewer',username:'viewer@example.test'}]);
  hidesPasswords(f,view,'view');
  // A twin that is not ready offers nothing to sign in with.
  f.environment.status='failed';
  assert.deepEqual((await f.manager.view(f.context)).accounts,[]);
});

test('a run without an entered account signs in with the twin\'s first account, which only the worker receives',async t=>{
  const f=await fixture(t);
  const {response,report,request}=await f.run({});
  assert.deepEqual(request.credentials,{username:'owner@example.test',password:f.passwords.owner});
  // One account shares application state, so even independent journeys run one at a time.
  assert.deepEqual([response.run.effectiveConcurrency,response.run.concurrencyLimit],[1,'account']);
  // A twin account is generated test data, so evidence naming it is kept as reported.
  assert.equal(report.results[0].outcomes[0].evidence,'Signed in as owner@example.test');
  hidesPasswords(f,response,'run response');
  hidesPasswords(f,report,'run progress');
  hidesPasswords(f,f.manager.summary(f.context),'summary');
  hidesPasswords(f,await f.manager.view(f.context),'view');
  hidesPasswords(f,await readFile(join(f.dataDir,'browser','state.json'),'utf8'),'browser state');
});

test('a run can choose another twin account, an entered account or none, and refuses unknown or mixed choices',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.run({accountId:'viewer'})).request.credentials,{username:'viewer@example.test',password:f.passwords.viewer});
  const entered={username:'someone@example.test',password:'entered-password'};
  assert.deepEqual((await f.run({credentials:entered})).request.credentials,entered);
  const none=await f.run({accountId:null});
  assert.equal('credentials' in none.request,false);
  assert.deepEqual([none.response.run.effectiveConcurrency,none.response.run.concurrencyLimit],[2,null]);
  const runs=f.requests.length;
  await assert.rejects(f.manager.run(f.context,{accountId:'nobody'}),/Choose a test account of this environment/);
  await assert.rejects(f.manager.run(f.context,{accountId:'owner',credentials:entered}),/Choose one test account/);
  await assert.rejects(f.manager.run(f.context,{accountId:7}),/Choose one test account/);
  assert.equal(f.requests.length,runs,'A refused choice starts no worker.');
});

test('discovery explores signed in with the same twin account',async t=>{
  const f=await fixture(t,{authEndpoints:[]});
  await f.manager.saveConfig(f.context,{targetUrl:`${f.web}/`,authEndpoints:[`${f.web}/auth/v1/token`]});
  const {run}=await f.manager.discover(f.context,{});
  const report=await f.finished(run.id);
  const request=f.requests.at(-1);
  assert.equal(request.mode,'discover');
  assert.deepEqual(request.credentials,{username:'owner@example.test',password:f.passwords.owner});
  assert.deepEqual(request.authEndpoints,[`${f.web}/auth/v1/token`]);
  assert.equal(report.discovery.authenticated,true);
  assert.equal(report.discovery.summary,'Explored as owner@example.test');
  hidesPasswords(f,report,'discovery');
  hidesPasswords(f,await f.manager.view(f.context),'view');
});

test('discovery lets through the sign-in endpoint the twin publishes for its test account',async t=>{
  // A service whose accounts sign in against its own API, as Supabase does with /auth/v1/token.
  const signingIn={...auth,accounts:async ctx=>(await auth.accounts(ctx)).map(account=>({...account,authEndpoints:[ctx.url('api','/auth/v1/token')]}))};
  const f=await fixture(t,{service:signingIn});
  const {run}=await f.manager.discover(f.context,{});
  await f.finished(run.id);
  const request=f.requests.at(-1);
  assert.equal(request.authEndpoints.length,1,'the account endpoint is the only one; none is configured');
  assert.match(request.authEndpoints[0],/^http:\/\/host\.docker\.internal:\d+\/auth\/v1\/token$/);
  assert.equal(request.credentials.username,'owner@example.test');
  hidesPasswords(f,await f.manager.view(f.context),'view');
  // Runs may submit anyway, so they get no auth endpoint allowance.
  const {request:runRequest}=await f.run({caseIds:['create']});
  assert.equal(runRequest.authEndpoints,undefined);
});

test('outside a twin with accounts nothing is injected, and a listed account missing from the twin is an error',async t=>{
  const f=await fixture(t);
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/'});
  assert.deepEqual((await f.manager.view(f.context)).accounts,[]);
  assert.equal('credentials' in (await f.run({})).request,false);
  await assert.rejects(f.manager.run(f.context,{accountId:'owner'}),/Choose a test account of this environment/);
  // The environment still lists an account, but its twin state is gone.
  await f.manager.saveConfig(f.context,{targetUrl:`${f.web}/`});
  f.environments[0]={...f.environment,id:'twin-gone',sandboxId:'twin-gone'};
  const runs=f.requests.length;
  await assert.rejects(f.manager.run(f.context,{}),/test account is unavailable/);
  assert.equal(f.requests.length,runs);
});
