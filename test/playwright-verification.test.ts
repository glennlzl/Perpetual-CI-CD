import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.ts';
import {codeFor} from './fixtures/journey-code.ts';
import {caseHash} from '../src/journeys/playwright/specs.ts';
import type {BrowserManagerOptions} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

type JourneyRuntime=NonNullable<BrowserManagerOptions['playwright']>;
/** One attempt the fake runtime holds until the test finishes or cancels it. */
type Worker={input:JourneyRunInput;cancelled:boolean;promise:Promise<void>;finish(events:WorkerEvent[]):void;cancel():void};
type Verification={id:string;attempt:number;control:boolean;hash:string;caseHash:string};
/** A run as the browser manager saves it, as far as these tests read it. */
type StoredRun={id:string;mode:string;status:string;caseIds:string[];completedAt?:string;results:{status:string}[];specHashes:Record<string,string>;verification?:Verification;progress:{cases:{status:string;steps:{status:string}[]}[]}};
type StoredState={runs:StoredRun[];specs:Record<string,Record<string,{approved:{approvedRunIds?:string[]}|null}>>};

// A draft is verified before approval: three passing runs of exactly its code, then a control run with every
// state-changing request blocked, in which a reviewed check must fail. A fake Playwright runtime plays each attempt.
const journey={id:'rename',name:'Rename the workspace',goal:'Rename the workspace and see it kept.',isolation:'shared',selected:false,needsReview:false,
  steps:[{id:'open',title:'Open Settings',checks:[{type:'text-visible',value:'Workspace name'}]},{id:'rename',title:'Rename and reload',checks:[{type:'text-visible',value:'Renamed'}]}],
  preconditions:[],expectedOutcomes:['The new name is kept.'],assertions:[{type:'text-visible',value:'Renamed'}]} satisfies Omit<BrowserCase,'evidence'>;
const code=codeFor(journey);
const step=(stepId:string,status:string,checks?:unknown[])=>({type:'journey-step',caseId:journey.id,stepId,status,...(status==='running'?{}:{evidence:'Reviewed checks evaluated.',checks})});
const passing:WorkerEvent[]=[...journey.steps.flatMap(item=>[step(item.id,'running'),step(item.id,'completed',item.checks.map(check=>({...check,passed:true})))]),{type:'result',result:{caseId:journey.id,stopCause:'none',assertions:[{...journey.assertions[0],passed:true}]}}];
// With every change blocked, the rename was not kept: the check after it fails.
const unkept:WorkerEvent[]=[step('open','running'),step('open','completed',[{...journey.steps[0].checks[0],passed:true}]),step('rename','running'),step('rename','failed',[{...journey.steps[1].checks[0],passed:false}]),{type:'result',result:{caseId:journey.id,stopCause:'none',assertions:[]}}];
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function setup(t:TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-verification-'));await mkdir(join(dataDir,'repo'));
  const workers:Worker[]=[];
  const playwright:JourneyRuntime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true}),start(input,onEvent){
    // Its promise, finish and cancel are set at once, as the promise starts.
    const worker={input,cancelled:false} as Worker;
    worker.promise=new Promise<void>((resolve,reject)=>{worker.finish=events=>{for(const event of events)onEvent(event);resolve();};worker.cancel=()=>{worker.cancelled=true;reject(new Error('Browser operation cancelled.'));};});
    workers.push(worker);return {promise:worker.promise,cancel:()=>worker.cancel()};
  }};
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}),start(){throw new Error('The browser agent must not run a journey.');}};
  const options:BrowserManagerOptions={dataDir,runtime,playwright};
  let manager=await createBrowserManager(options);
  t.after(async()=>{for(const worker of workers)worker.cancel?.();await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:'http://localhost:3000'});await manager.saveCases(context,[journey]);
  const hash=(await manager.saveSpec(context,{caseId:journey.id,code})).spec.draft!.hash;
  const f={dataDir,context,workers,hash,get manager(){return manager;},async restart(){await manager.close();manager=await createBrowserManager(options);return manager;},
    verification:async()=>(await manager.view(context)).specs[journey.id]?.draft?.verification,
    async worker(count:number){for(let i=0;i<400;i++){if(workers.length>=count)return workers[count-1];await wait(5);}throw new Error('The attempt did not start.');},
    async settled(){for(let i=0;i<400;i++){const verification=await f.verification();if(verification&&verification.status!=='running'&&!manager.isActive(context))return verification;await wait(5);}throw new Error('The verification did not settle.');}};
  return f;
}
const stored=async(f:{dataDir:string}):Promise<StoredState>=>JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8'));

test('three passing runs and a caught control run verify the draft, while the stage stays busy for a gate and a person',async t=>{
  const f=await setup(t);
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:'0'.repeat(64)}),{statusCode:409,message:'The code changed. Reload it and verify again.'});
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:'missing',hash:f.hash}),{statusCode:404});
  const started=await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.deepEqual(started.specs[journey.id].draft?.verification,{status:'running',passes:0,control:null});
  for(let attempt=1;attempt<=4;attempt++){
    const worker=await f.worker(attempt);
    // Between and inside attempts: a gate waits, and a person's run, another verification, generation and approval are refused.
    assert.equal(f.manager.isActive(f.context),true);
    await assert.rejects(f.manager.run(f.context,{},{manual:true}),{statusCode:409});
    await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
    await assert.rejects(f.manager.generateSpec(f.context,{caseId:journey.id}),{statusCode:409});
    await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Code for this test is being verified. Stop it first.'});
    assert.deepEqual([worker.input.case.id,worker.input.spec.hash,worker.input.blockWrites],[journey.id,f.hash,attempt===4?true:undefined],`attempt ${attempt}`);
    assert.equal((await f.verification())?.passes,attempt-1);
    worker.finish(attempt===4?unkept:passing);
  }
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  assert.equal(f.workers.length,4);
  // Each attempt is an ordinary run of the one case, which need not be selected.
  const attempts=(await stored(f)).runs.filter((run):run is StoredRun&{verification:Verification}=>Boolean(run.verification)).reverse();
  assert.deepEqual(attempts.map(run=>[run.mode,run.caseIds,run.verification.attempt,run.verification.control,run.verification.hash,run.results[0].status]),
    [1,2,3,4].map(attempt=>['run',[journey.id],attempt,attempt===4,f.hash,attempt===4?'failed':'passed']));
  assert.equal(new Set(attempts.map(run=>run.verification.id)).size,1);
  // Each attempt names the reviewed journey it verified and the code it ran.
  assert.ok(attempts.every(run=>run.verification.caseHash===caseHash(journey)&&run.specHashes[journey.id]===f.hash));
  // A control run never counts as the journey's current status: the graph carries the latest other run's progress.
  const summary=f.manager.summary(f.context).runs,control=summary.find(run=>run.verification?.control);
  assert.equal(control?.progress,undefined);assert.equal(summary.find(run=>run.verification?.attempt===3)?.progress?.cases[0].status,'passed');
  const {specs}=await f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.equal(specs[journey.id].approved?.hash,f.hash);assert.equal(specs[journey.id].draft,undefined);
  assert.deepEqual((await stored(f)).specs[Object.keys((await stored(f)).specs)[0]][journey.id].approved?.approvedRunIds,attempts.map(run=>run.id));
});

test('the first attempt that does not pass stops the verification with its error',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish(passing);
  (await f.worker(2)).finish([{type:'result',result:{caseId:journey.id,stopCause:'action',error:'Action failed at “Open Settings”: locator.click: Timeout 10000ms exceeded.',assertions:[]}}]);
  assert.deepEqual(await f.settled(),{status:'failed',passes:1,control:null,error:'Action failed at “Open Settings”: locator.click: Timeout 10000ms exceeded.'});
  await wait(30);assert.equal(f.workers.length,2,'No later attempt runs.');
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
  // It can be verified again.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  assert.equal((await f.verification())?.status,'running');
});

test('a control run that passes with every change blocked fails the verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(passing);
  assert.deepEqual(await f.settled(),{status:'failed',passes:3,control:'missed',error:'The journey passed with every change blocked. Strengthen its checks.'});
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
});

test('stopping a verification cancels its attempt, and a restart ends an unfinished one as cancelled',async t=>{
  const f=await setup(t);
  await assert.rejects(f.manager.cancelSpecVerification(f.context,{caseId:journey.id}),{statusCode:404});
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish(passing);
  const second=await f.worker(2);
  assert.equal((await f.manager.cancelSpecVerification(f.context,{caseId:journey.id})).specs[journey.id].draft?.verification?.status,'running','It stops once its attempt has cleaned up.');
  assert.equal(second.cancelled,true);
  assert.deepEqual(await f.settled(),{status:'cancelled',passes:1,control:null});
  assert.equal(f.workers.length,2);
  await assert.rejects(f.manager.cancelSpecVerification(f.context,{caseId:journey.id}),{statusCode:404});
  // A controller that stops inside an attempt: the attempt and its verification end cancelled, never failed.
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(3)).finish(passing);await f.worker(4);
  await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),state=await stored(f),interrupted=state.runs[0];
  assert.equal(interrupted.verification?.attempt,2);
  Object.assign(interrupted,{status:'running'});delete interrupted.completedAt;interrupted.results=[];Object.assign(interrupted.progress.cases[0],{status:'running'});interrupted.progress.cases[0].steps[0].status='running';
  await writeFile(file,JSON.stringify(state));
  const restarted=await f.restart();
  assert.deepEqual(await f.verification(),{status:'cancelled',passes:1,control:null});
  const run=(await restarted.runProgress(f.context,interrupted.id));
  assert.deepEqual([run.run.status,run.results[0].status,run.progress?.cases[0].steps?.[0].status],['cancelled','cancelled','cancelled']);
  assert.equal(restarted.isActive(f.context),false);
  await assert.rejects(restarted.cancelSpecVerification(f.context,{caseId:journey.id}),{statusCode:404});
});

test('deleting the case stops its verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  const first=await f.worker(1);
  await f.manager.saveCases(f.context,[]);
  assert.equal(first.cancelled,true);
  for(let i=0;i<400&&f.manager.isActive(f.context);i++)await wait(5);
  assert.equal(f.manager.isActive(f.context),false);assert.equal(f.workers.length,1);
});

test('a verification holds only for the journey it ran against, so the same code saved for weaker checks is unverified',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?unkept:passing);
  assert.deepEqual(await f.settled(),{status:'passed',passes:3,control:'caught'});
  // The rename's check and the final assertion go, and the identical code is saved again for the weaker journey.
  await f.manager.saveCases(f.context,[{...journey,steps:[journey.steps[0],{...journey.steps[1],checks:[]}],assertions:[]}]);
  const {spec:{draft}}=await f.manager.saveSpec(f.context,{caseId:journey.id,code});
  assert.deepEqual([draft?.hash,draft?.stale,draft?.verification],[f.hash,false,undefined]);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
  assert.equal(f.workers.length,4);
});

test('an attempt that did not run the draft, as after its journey changed, fails the verification',async t=>{
  const f=await setup(t);
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
  (await f.worker(1)).finish(passing);(await f.worker(2)).finish(passing);
  const third=await f.worker(3);
  await f.manager.saveCases(f.context,[{...journey,goal:`${journey.goal} (edited)`}]);
  third.finish(passing);
  assert.deepEqual(await f.settled(),{status:'failed',passes:3,control:null,error:'The journey changed during its verification. Verify its code again.'});
  assert.equal(f.workers.length,3,'The control run never ran the draft.');
  // Back to the verified journey, the draft is current again, and still unverified.
  await f.manager.saveCases(f.context,[journey]);
  assert.equal((await f.manager.view(f.context)).specs[journey.id].draft?.stale,false);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
});

test('only a failed reviewed check catches the control run; any other end of it is inconclusive',async t=>{
  const passed=journey.steps.map(item=>item.checks.map(check=>({...check,passed:true})));
  const ends:[WorkerEvent[],{status:string;passes:number;control:string|null;error?:string}][]=[
    // The final assertion on the reached end state noticed that the rename was not kept.
    [[...journey.steps.flatMap((item,index)=>[step(item.id,'running'),step(item.id,'completed',passed[index])]),{type:'result',result:{caseId:journey.id,stopCause:'none',assertions:[{...journey.assertions[0],passed:false}]}}],{status:'passed',passes:3,control:'caught'}],
    // An action the block broke judges nothing.
    [[step('open','running'),step('open','completed',passed[0]),step('rename','running'),{type:'result',result:{caseId:journey.id,stopCause:'action',error:'Action failed at “Rename and reload”: page.reload: Not attached to an active page.',assertions:[]}}],
      {status:'failed',passes:3,control:null,error:'No reviewed check noticed the blocked changes. Action failed at “Rename and reload”: page.reload: Not attached to an active page.'}],
    [[{type:'result',result:{caseId:journey.id,stopCause:'exception',error:'The browser crashed.',assertions:[]}}],{status:'failed',passes:3,control:null,error:'No reviewed check noticed the blocked changes. The browser crashed.'}],
  ];
  for(const [events,expected] of ends){
    const f=await setup(t);
    await f.manager.verifySpec(f.context,{caseId:journey.id,hash:f.hash});
    for(let attempt=1;attempt<=4;attempt++)(await f.worker(attempt)).finish(attempt===4?events:passing);
    assert.deepEqual(await f.settled(),expected);
    if(expected.control!=='caught')await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:f.hash}),{statusCode:409});
  }
});
