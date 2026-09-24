import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,readFile,readdir,access,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createBrowserManager} from '../src/browser/manager.mjs';
import {createPlaywrightRuntime} from '../src/journeys/playwright/runtime.mjs';
import {generatePrompt,opencodeHarness} from '../src/journeys/playwright/generation.mjs';
import {specHash,validateJourneySpec} from '../src/journeys/playwright/specs.mjs';

// Code generation with a fake harness in place of OpenCode: no network, no key, no model.
const fake=fileURLToPath(new URL('./fixtures/fake-opencode.mjs',import.meta.url));
const key='or-fixture-key-7731',password='pw-fixture-4821',model='openai/gpt-4.1-mini';
const journey={id:'rename',name:'Rename the display name',goal:'Change my display name and see it kept after a reload.',isolation:'shared',selected:true,needsReview:false,
  steps:[{id:'open-settings',title:'Sign in and open Settings',checks:[{type:'url-contains',value:'/settings'}]},{id:'save-name',title:'Save the display name',checks:[{type:'text-visible',value:'Saved'}]}],
  preconditions:['A test account'],expectedOutcomes:['Settings shows the new name.'],assertions:[]};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const lines=async file=>(await readFile(file,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(line=>JSON.parse(line));

async function setup(t,{mode='valid',target='http://localhost:3000/',environment:overrides={},playwright,timeoutMs=20000,events}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-generation-'));await mkdir(join(dataDir,'repo'));
  const log=join(dataDir,'harness.jsonl'),launches=[],state={mode};
  const environment={id:'twin-1',status:'ready',stageId:'beta',apps:[{id:'web',url:target}],accounts:[{id:'owner',label:'Owner',username:'tester@example.com'}],services:[],...overrides};
  playwright??={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(input,onEvent){launches.push(input);const promise=wait(10).then(()=>{for(const event of events(input))onEvent(event);});return {promise,cancel(){}};}};
  const runtime={capabilities:async()=>({runtimeInstalled:true,modelConfigured:true}),start(){throw new Error('The browser-use runtime must not start.');}};
  const options=()=>({dataDir,runtime,playwright,resolveEnvironment:url=>new URL(url).origin===new URL(target).origin?environment:null,twinAccount:async(_environment,accountId)=>accountId==='owner'?{username:'tester@example.com',password}:null,
    generation:{harness:({model:requested,prompt})=>({command:process.execPath,args:[fake,state.mode,log,prompt,requested]}),timeoutMs,cleanupGraceMs:1000}});
  const manager=await createBrowserManager(options());
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  await manager.saveModel(context,{apiKey:key,model});
  await manager.saveConfig(context,{targetUrl:target,journeyTimeoutSeconds:60});
  await manager.saveCases(context,[journey]);
  return {manager,context,dataDir,log,launches,state,environment,options};
}
// The generation's view once it is no longer running.
async function settled({manager,context},caseId=journey.id,seconds=30){
  for(const end=Date.now()+seconds*1000;Date.now()<end;await wait(50)){const spec=(await manager.view(context)).specs[caseId];if(spec?.generation?.status!=='running')return spec;}
  throw new Error('The generation did not finish.');
}
const userHome=process.env.HOME||homedir();
const secretFree=value=>!JSON.stringify(value).includes(key)&&!JSON.stringify(value).includes(password);

test('the default harness is OpenCode running Playwright’s generator agent against OpenRouter',()=>{
  assert.deepEqual(opencodeHarness({model:`openrouter/${model}`,prompt:'Go'}),{command:'npx',args:['-y','opencode-ai@1.18.32','run','--agent','playwright-test-generator','--model','openrouter/openai/gpt-4.1-mini','Go']});
});

test('a reviewed journey’s code is generated in a private workspace and saved as a draft',async t=>{
  const f=await setup(t);
  const started=await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal(started.specs[journey.id].generation.status,'running');
  assert.equal(f.manager.isActive(f.context),true);
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),{statusCode:409,message:'Code for this test is already being generated.'});
  await assert.rejects(f.manager.saveSpec(f.context,{caseId:journey.id,code:'x'}),{statusCode:409});
  await assert.rejects(f.manager.saveModel(f.context,{model:'openai/gpt-5.4-mini'}),{statusCode:409},'The model stays while code is generated.');
  const spec=await settled(f);
  const stored=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')),saved=Object.values(stored.specs)[0][journey.id];
  assert.deepEqual(spec,{hash:saved.hash,approved:false,stale:false,provenance:{harness:'opencode@1.18.32',generator:'playwright-test-generator@1.63.0',model:'openrouter/openai/gpt-4.1-mini'}});
  assert.equal(validateJourneySpec(saved.code,journey),saved.code);assert.equal(saved.hash,specHash(saved.code));assert.equal(saved.approvedAt,null);
  const [call,...more]=await lines(f.log);
  assert.equal(more.length,0,'One harness run.');
  assert.equal(call.prompt,generatePrompt);
  // The workspace: private, under the browser data dir. OpenCode's project is its own git root with Playwright's
  // generator agent as a primary agent with no other tools; what the seed's process loads is beside it, read-only.
  const workspace=dirname(call.cwd),run=join(workspace,'run');
  assert.equal(call.workspaceMode,0o700);assert.equal(dirname(workspace),join(await realpath(f.dataDir),'browser','generations'));assert.equal(call.cwd,join(workspace,'project'));
  assert.equal(call.git,true);assert.equal(call.prompts,true);
  assert.deepEqual(call.agent,{mode:'primary',model:'openrouter/openai/gpt-4.1-mini',allTools:false});
  assert.deepEqual(call.permission,{edit:'deny',bash:'deny',webfetch:'deny',external_directory:'deny'});
  assert.deepEqual(call.mcp.slice(0,3),[process.execPath,fileURLToPath(new URL('../node_modules/@playwright/test/cli.js',import.meta.url)),'run-test-mcp-server']);
  assert.deepEqual(call.mcp.slice(3),['--headless','--config',join(run,'playwright.config.mjs')]);
  // The only test folder under the project is where the spec is written; no project loads it.
  assert.deepEqual(call.config.projects,[{name:'seed',testDir:join(run,'seed'),testMatch:'seed.spec.mjs'},{name:'tests',testDir:join(call.cwd,'tests'),testIgnore:'**'}]);
  assert.deepEqual(call.modes,{config:0o444,seed:0o444,case:0o444,opencode:0o444,plan:0o444});
  // The fixture's environment as a run passes it, without an event channel; the key and account only in the environment.
  // OpenCode's HOME is the workspace's own; npx and OpenCode keep the user's caches.
  assert.deepEqual(call.env,{key:true,account:'tester@example.com',password:true,channel:null,caseFile:join(run,'case.json'),target:'http://localhost:3000/',
    home:join(workspace,'home'),xdg:null,cache:process.env.XDG_CACHE_HOME||join(userHome,'.cache'),npm:join(userHome,'.npm'),claude:'1'});
  // The test MCP server runs the seed with the user's HOME and without the model key.
  assert.deepEqual(call.mcpEnvironment,{HOME:userHome,OPENROUTER_API_KEY:''});
  assert.match(call.seed,/test\('seed', async \(\{ page, journey \}\) => \{\n  await journey\.signIn\(\);\n\}\);/);
  assert.match(call.plan,/^# Rename the display name\n\n\*\*Seed:\*\* `seed\.spec\.mjs`\n\nGoal: Change my display name and see it kept after a reload\.\n/);
  assert.match(call.plan,/\*\*Steps:\*\*\n1\. Sign in and open Settings \(milestone id: open-settings\)\n2\. Save the display name \(milestone id: save-name\)\n/);
  for(const rule of ["`import { test } from 'perpetual';`",'exactly one `test("Rename the display name", async ({ page, journey }) => { … });`',"`await journey.milestone('<milestone id>', async () => { … });`",'Start the first milestone with `await journey.signIn();`','No variables, `expect` or other assertions','Prefer role, label or id locators'])assert.ok(call.plan.includes(rule),rule);
  assert.deepEqual(await readdir(join(f.dataDir,'browser','generations')),[],'The workspace is removed.');
  assert.ok(secretFree(stored)&&secretFree(await f.manager.view(f.context))&&secretFree(f.manager.summary(f.context))&&secretFree(await lines(f.log)));
  // Opening the stage or restarting never generates again.
  await f.manager.close();
  const restarted=await createBrowserManager(f.options());t.after(()=>restarted.close());
  await restarted.view(f.context);restarted.summary(f.context);await wait(100);
  assert.equal((await lines(f.log)).length,1);
  assert.equal((await restarted.view(f.context)).specs[journey.id].generation,undefined);
});

test('a generated draft is approved only after a passing Playwright run of its exact code',async t=>{
  let result='passed';
  const events=input=>[...input.case.steps.flatMap(step=>[{type:'journey-step',caseId:input.case.id,stepId:step.id,status:'running'},{type:'journey-step',caseId:input.case.id,stepId:step.id,status:result==='passed'?'completed':'failed',evidence:'Reviewed checks evaluated.',checks:step.checks.map(check=>({...check,passed:result==='passed'}))}].slice(0,result==='passed'||step===input.case.steps[0]?2:0)),{type:'result',result:{caseId:input.case.id,stopCause:'none',assertions:[]}}];
  const f=await setup(t,{events});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const {hash}=await settled(f);
  const approve=()=>f.manager.approveSpec(f.context,{caseId:journey.id,hash});
  await assert.rejects(approve(),{statusCode:409});
  result='failed';
  assert.equal((await wait(0),await runToEnd(f,{engine:'playwright'},{manual:true})).run.status,'failed');
  await assert.rejects(approve(),{statusCode:409},'A failed run of this code approves nothing.');
  result='passed';
  const passed=await runToEnd(f,{engine:'playwright'},{manual:true});
  assert.equal(passed.run.status,'passed');assert.equal(f.launches.at(-1).spec.hash,hash);
  assert.equal((await approve()).spec.approved,true);
  const stored=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8'));
  assert.equal(Object.values(stored.specs)[0][journey.id].approvedRunId,passed.run.id);
  // Regenerating replaces the code with a new draft, which needs its own passing run.
  f.state.mode='repair';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const next=await settled(f);
  assert.notEqual(next.hash,hash);assert.deepEqual([next.approved,next.verified],[false,undefined]);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:next.hash}),{statusCode:409});
});
// A finished run releases its environment just after its status settles, so a run started right after it may see 409.
async function runToEnd({manager,context},input,options){
  let run;
  for(let i=0;!run;i++){try{({run}=await manager.run(context,input,options));}catch(error){if(error.statusCode!==409||i>=200)throw error;await wait(5);}}
  for(let i=0;i<400;i++){const report=await manager.runProgress(context,run.id);if(!['queued','running'].includes(report.run.status))return report;await wait(10);}
  throw new Error('The run did not finish.');
}

test('an invalid spec is repaired once with only its validation error and the rules',async t=>{
  const f=await setup(t,{mode:'repair'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const spec=await settled(f);
  assert.equal(spec.approved,false);assert.equal(spec.generation,undefined);
  const [first,repair]=await lines(f.log);
  assert.equal(first.prompt,generatePrompt);
  assert.match(repair.prompt,/^The test in `tests\/rename-the-display-name\.spec\.ts` is invalid: Line 8: expect\(\)\.toBeVisible is not an allowed journey action\.\n\nRules:\n- Write JavaScript\./);
  assert.match(repair.prompt,/write the corrected test with generator_write_test to `tests\/rename-the-display-name\.spec\.ts`\.$/);
  assert.ok(!repair.prompt.includes(journey.goal)&&!repair.prompt.includes('milestone id: open-settings'),'Only the error and the rules.');
});

test('a spec still invalid after its repair fails with the validation message and saves nothing',async t=>{
  const f=await setup(t,{mode:'invalid'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const failed=await settled(f);
  // What the generator wrote stays visible with the failure.
  assert.match(failed.generation.rejected,/expect\(/);
  assert.deepEqual({...failed,generation:{...failed.generation,rejected:undefined}},{generation:{status:'failed',error:'The generated code is invalid: Line 8: expect().toBeVisible is not an allowed journey action.',rejected:undefined}});
  assert.equal((await lines(f.log)).length,2);
  const stored=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8'));
  assert.deepEqual(Object.values(stored.specs).flatMap(Object.keys),[]);
  // A later generation starts over.
  f.state.mode='valid';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.equal((await settled(f)).approved,false);
});

test('a harness that stops reports its redacted output; the key and password appear nowhere',async t=>{
  const f=await setup(t,{mode:'fail'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const {generation}=await settled(f);
  assert.equal(generation.status,'failed');
  assert.equal(generation.error,'The code generator stopped. Provider rejected key [REDACTED] for [REDACTED]');
  assert.ok(secretFree(await f.manager.view(f.context))&&secretFree(await readFile(join(f.dataDir,'browser','state.json'),'utf8')));
});

test('cancelling or timing out kills the harness’s whole process tree',async t=>{
  const f=await setup(t,{mode:'hang',timeoutMs:60000});
  const pidsOf=async count=>{for(let i=0;i<200;i++){const found=(await lines(f.log)).filter(line=>line.pids);if(found.length>=count)return found.at(-1).pids;await wait(50);}throw new Error('The harness did not start.');};
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const pids=await pidsOf(1);
  assert.ok(pids.every(alive));
  // The generator holds the twin like a run.
  await assert.rejects(f.manager.run(f.context,{engine:'playwright'},{manual:true}),{statusCode:409});
  assert.equal((await f.manager.cancelSpecGeneration(f.context,{caseId:journey.id})).specs[journey.id].generation.step,'cancelling');
  assert.equal(await settled(f),undefined,'A cancelled generation leaves no state.');
  assert.ok(!pids.some(alive),'The harness and its child are gone.');
  assert.equal(f.manager.isActive(f.context),false);
  await f.manager.close();
  const short=await createBrowserManager({...f.options(),generation:{...f.options().generation,timeoutMs:1500}});t.after(()=>short.close());
  await short.generateSpec(f.context,{caseId:journey.id});
  const timed=await pidsOf(2);
  const {generation}=await settled({manager:short,context:f.context});
  assert.deepEqual(generation,{status:'failed',error:'Code generation exceeded its time limit.'});
  assert.ok(!timed.some(alive));
  await assert.rejects(short.cancelSpecGeneration(f.context,{caseId:journey.id}),{statusCode:404});
});

test('only a reviewed case with a model and this stage’s ready twin generates code',async t=>{
  const f=await setup(t);
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:'missing'}),{statusCode:404});
  await f.manager.saveCases(f.context,[{...journey,needsReview:true,selected:false}]);
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),/Review this test before generating its code\./);
  await f.manager.saveCases(f.context,[journey]);
  for(const overrides of [{status:'creating'},{stageId:'gamma'}]){
    Object.assign(f.environment,{status:'ready',stageId:'beta',...overrides});
    await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),{statusCode:409,message:'Set the application URL to this stage’s ready twin first.'},JSON.stringify(overrides));
  }
  Object.assign(f.environment,{status:'ready',stageId:'beta'});
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:4000/'});
  await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),/ready twin/,'A URL that is no twin.');
  assert.equal((await lines(f.log)).length,0,'No harness ran.');
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-generation-nomodel-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const bare=await createBrowserManager({...f.options(),dataDir});t.after(()=>bare.close());
  await bare.saveConfig(f.context,{targetUrl:'http://localhost:3000/'});await bare.saveCases(f.context,[journey]);
  if(!process.env.OPENROUTER_API_KEY&&!process.env.PERPETUAL_MODEL_API_KEY)await assert.rejects(bare.generateSpec(f.context,{caseId:journey.id}),/Add your OpenRouter API key in Settings first\./);
  // Deleting the case stops its generation.
  await f.manager.saveConfig(f.context,{targetUrl:'http://localhost:3000/'});
  f.state.mode='hang';
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  await f.manager.saveCases(f.context,[]);
  for(let i=0;i<200&&f.manager.isActive(f.context);i++)await wait(50);
  assert.equal(f.manager.isActive(f.context),false);
});

test('a spec is accepted only while the workspace the generator cannot write is unchanged',async t=>{
  const f=await setup(t,{mode:'tamper'});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  assert.deepEqual(await settled(f),{generation:{status:'failed',error:'The code generation workspace changed.'}});
  assert.equal((await lines(f.log)).length,1,'No repair run.');
  assert.deepEqual(Object.values(JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).specs).flatMap(Object.keys),[]);
});

// The generation workspace's seed, run by the pinned test MCP server as the generator's setup does, against a real app.
function application(){
  let signedIn=0;
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const url=new URL(req.url,'http://app'),session=/session=1/.test(req.headers.cookie||''),form=new URLSearchParams(body);
      const send=html=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><body>${html}</body>`);};
      if(url.pathname==='/login'&&req.method==='POST'){if(form.get('email')==='tester@example.com'&&form.get('password')===password){signedIn++;res.writeHead(303,{location:'/settings','set-cookie':'session=1; Path=/'});}else res.writeHead(303,{location:'/login'});return res.end();}
      if(url.pathname==='/login')return send('<form method=post action=/login><label>Email <input type=email name=email></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form>');
      if(!session){res.writeHead(303,{location:'/login'});return res.end();}
      send('<h1>Settings</h1><button>Save</button>');
    });
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({server,signedIn:()=>signedIn,url:`http://127.0.0.1:${server.address().port}/`})));
}

test('the test MCP server’s seed signs in with the twin account, and a generator can write no code that runs beside it',{timeout:120000},async t=>{
  const playwright=createPlaywrightRuntime();
  if(!(await playwright.capabilities()).browserInstalled)return t.skip('Chromium for Playwright is not installed.');
  const app=await application();t.after(()=>{app.server.closeAllConnections();app.server.close();});
  const f=await setup(t,{mode:'seed',target:app.url,playwright});
  await f.manager.generateSpec(f.context,{caseId:journey.id});
  const spec=await settled(f,journey.id,90);
  const [{generation}]=await lines(f.log);
  // Both setups paused on the signed-in page; nothing the generator wrote ran, and no tool output held the password.
  assert.deepEqual(generation.setups,[false,false],JSON.stringify(generation));
  assert.equal(app.signedIn(),2,'Each setup signed in once with the twin account.');
  assert.ok(Object.values(generation.refused).every(Boolean),JSON.stringify(generation.refused));
  assert.ok(Object.values(generation.written).every(error=>!error),JSON.stringify(generation.written));
  assert.deepEqual([generation.wrote,generation.leaked,generation.exposed],[false,false,false]);
  assert.deepEqual(Object.keys(spec),['hash','approved','stale','provenance'],JSON.stringify(spec));assert.equal(spec.approved,false);
  await access(join(f.dataDir,'browser','generations')).then(async()=>assert.deepEqual(await readdir(join(f.dataDir,'browser','generations')),[]));
});
