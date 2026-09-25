import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createBrowserManager} from '../src/browser/manager.ts';
import {writeJourneyWorkspace} from '../src/journeys/playwright/runtime.ts';
import {caseHash,signsIn,specHash,validateJourneySpec} from '../src/journeys/playwright/specs.ts';
import {navigationAllowed,numberAfter,paymentAllowed,stripeLive} from '../src/journeys/playwright/checks.ts';
import type {BrowserManager,BrowserManagerOptions,BrowserStageContext,TargetEnvironment} from '../src/browser/manager.ts';
import type {WorkerEvent} from '../src/browser/runtime.ts';
import type {BrowserCase} from '../src/business/browser-cases.ts';
import type {JourneyRunInput} from '../src/journeys/playwright/runtime.ts';

type JourneyRuntime=NonNullable<BrowserManagerOptions['playwright']>;
type Events=(input:JourneyRunInput)=>WorkerEvent[];
type Stored={runs:{id:string;verification?:unknown}[];specs:Record<string,Record<string,{approved:{code:string;approvedRunIds?:string[]}|null;draft:unknown}>>};
type HttpError=Error&{statusCode?:number};
const journey={id:'settings',name:'Durable settings',goal:'Rename the workspace and see it kept.',isolation:'shared',selected:true,needsReview:false,
  steps:[{id:'open',title:'Open Settings',checks:[{type:'text-visible',value:'Workspace name'}]},{id:'rename',title:'Rename and reload',checks:[{type:'text-visible',value:'Renamed'}]}],
  preconditions:[],expectedOutcomes:['The new name is kept.'],assertions:[{type:'text-visible',value:'Renamed'}]} satisfies Omit<BrowserCase,'evidence'>;
const body=(ids=['open','rename'])=>ids.map(id=>`  await journey.milestone('${id}', async () => { await page.getByRole('button', { name: 'Go' }).click(); });`).join('\n');
const spec=(inner=body(),head="import { test } from 'perpetual';")=>`${head}\n\ntest('Durable settings', async ({ page, journey }) => {\n${inner}\n});\n`;

test('a spec performs exactly the reviewed milestones in order, in a grammar of Playwright actions only',()=>{
  assert.equal(validateJourneySpec(spec(),journey),spec());
  const actions=(...lines:string[])=>spec(`  await journey.milestone('open', async () => {\n${lines.map(line=>`    ${line}`).join('\n')}\n  });\n  await journey.milestone('rename', async () => {});`);
  // Comments, literals, options, regular expressions, nested locators, frames, the keyboard and the mouse.
  assert.ok(validateJourneySpec(actions('// Sign in first.','await journey.signIn();',"await page.goto('/settings');","await page.getByRole('button', { name: /Save/i, exact: true }).nth(-1).click();",
    "await page.locator('li').filter({ has: page.getByText('Pro'), hasText: `Plan` }).first().click({ force: true });","await page.frameLocator('iframe').getByLabel('Card').fill('4242');",
    "await page.getByLabel('Plan').selectOption(['a', { label: 'b' }]);","await page.keyboard.press('Enter');","await page.mouse.wheel(0, 400);","await page.waitForURL('**/settings');"),journey));
  const rejected:[string|undefined,RegExp][]=[
    [undefined,/at most 200 KB/],['',/at most 200 KB/],[spec(body()+`// ${'x'.repeat(200*1024)}`),/at most 200 KB/],[spec(body()+'\n  await page.reload(;'),/not valid JavaScript \(line 6\)/],
    [spec(body(),"import { test } from 'perpetual';\nimport fs from 'node:fs';"),/Import only the fixture/],[spec(body(),"import { test } from '@playwright/test';"),/Import only the fixture/],
    [spec(body(),"import { test as it } from 'perpetual';"),/Import only the fixture/],[spec(body())+"export * from 'node:fs';\n",/Import only the fixture/],
    [spec(body())+"test('another', async () => {});\n",/exactly one test/],[spec(body()).replace('({ page, journey })','({ page, journey }, info)'),/exactly one test/],
    [spec(body()).replace('({ page, journey })','({ page, journey: { milestone } })'),/exactly one test/],[spec(body()).replace('({ page, journey })','({ page, journey, request })'),/exactly one test/],
    [spec(body()).replace("\ntest(","\nglobalThis.x = 1;\ntest("),/exactly one test/],
    // Exactly one plain test: it can be neither skipped nor marked to fix later, nor run alone beside another.
    ...['skip','fixme','only','fail','slow','describe'].map((name):[string,RegExp]=>[spec(body()).replace('\ntest(',`\ntest.${name}(`),/exactly one test/]),
    [actions('await test.skip();'),/test\.skip is not an allowed/],[actions('await test.fixme();'),/test\.fixme is not an allowed/],
    // The reviewed bypasses of a denylist: aliases of process, constructors, page scripts, patched globals and direct requests.
    [actions('const p = process;'),/Line 5: a milestone contains only awaited actions/],[actions('await process?.env;'),/Line 5: a milestone contains only awaited actions/],
    [actions("await [].constructor.constructor('return process')();"),/Line 5: a milestone contains only awaited actions/],
    [actions("await page.addScriptTag({ content: 'document.body.innerHTML = 1' });"),/Line 5: page\.addScriptTag is not an allowed journey action/],
    [actions("await page.addStyleTag({ content: 'p { display: none }' });"),/page\.addStyleTag is not an allowed/],[actions("await page.setContent('<p>Renamed</p>');"),/page\.setContent is not an allowed/],
    [actions("await page.mainFrame().addScriptTag({ content: '' });"),/page\.mainFrame\(\)\.addScriptTag is not an allowed/],[actions("await page.getByText('x').page().setContent('');"),/is not an allowed journey action/],
    [actions('String.prototype.includes = () => true;'),/only awaited actions/],[actions("JSON.stringify = () => '';"),/only awaited actions/],
    [actions("const r = page.request;","await r.post('/api/save');"),/only awaited actions/],[actions("await page.request.post('/api/save');"),/page\.request\.post is not an allowed/],
    [actions("await fetch('http://127.0.0.1:1/leak');"),/only awaited actions/],[actions("await console.log('x');"),/console\.log is not an allowed/],
    [actions("await page.evaluate(() => document.title);"),/page\.evaluate is not an allowed/],[actions("await page.locator('h1').evaluate(node => node.remove());"),/page\.locator\(\)\.evaluate is not an allowed/],
    [actions("await page['evaluate'](() => 1);"),/only awaited actions/],[actions("await page.route('**/api', route => route.fulfill({ body: '{}' }));"),/page\.route is not an allowed/],
    [actions("await page.context().newPage();"),/is not an allowed/],[actions("await page.locator('input').setInputFiles('/etc/passwd');"),/setInputFiles is not an allowed/],
    [actions("await expect(page).toHaveURL('/x');"),/expect\(\)\.toHaveURL is not an allowed/],[actions("await test.step('x', async () => {});"),/test\.step is not an allowed/],
    [actions("await page.goto('javascript:document.body.remove()');"),/page\.goto takes an http\(s\) URL or a path/],[actions("await page.goto('data:text/html,Renamed');"),/page\.goto takes/],
    [actions("await page.waitForURL(url => true);"),/action arguments are literals/],[actions("await page.getByText(`${'x'}`).click();"),/action arguments are literals/],
    [actions("await page.getByRole('button', { ...{ name: 'Go' } }).click();"),/action arguments are literals/],[actions("await page.getByRole('button', { __proto__: { name: 'Go' } }).click();"),/action arguments are literals/],
    [actions("await page.getByRole('button', { name: globalThis.name }).click();"),/action arguments are literals/],
    [actions('if (true) await page.reload();'),/only awaited actions/],[actions('page.reload();'),/only awaited actions/],[actions('await page.reload?.();'),/only awaited actions/],
    [actions("await journey.milestone('rename', async () => {});"),/journey\.signIn\(\) is the only journey call/],
    [spec(`  await page.reload();\n${body()}`),/Line 4: the test body only awaits journey\.milestone/],
    [spec("  // await journey.milestone('open', …); await journey.milestone('rename', …);\n  const p = process;"),/Line 5: the test body only awaits journey\.milestone/],
    [spec(body(['rename','open'])),/once per reviewed step, in order.*open, rename/],[spec(body(['open'])),/once per reviewed step/],[spec(body(['open','rename','rename'])),/once per reviewed step/],
    [spec("  await journey.milestone(`${'open'}`, async () => {});\n  await journey.milestone('rename', async () => {});"),/literal ID/],
  ];
  for(const [code,pattern] of rejected)assert.throws(()=>validateJourneySpec(code,journey),pattern,String(code).slice(-160));
  assert.equal(signsIn(actions('await journey.signIn();')),true);
  assert.equal(signsIn(spec()),false);assert.equal(signsIn(actions('// await journey.signIn();')),false,'A comment does not sign in.');
});

test('an approval binds the spec hash to the reviewed contract, not to its name or selection',()=>{
  assert.match(specHash(spec()),/^[a-f0-9]{64}$/);assert.notEqual(specHash(spec()),specHash(`${spec()} `));
  assert.equal(caseHash(journey),caseHash({...journey,name:'Renamed test',selected:false,isolation:'isolated',evidence:[{path:'src/app.js',line:1}]}));
  for(const edit of [{goal:'Another goal'},{preconditions:['Signed in']},{expectedOutcomes:['Another outcome']},{assertions:[]},{steps:[journey.steps[0],{...journey.steps[1],title:'Rename'}]},{steps:[journey.steps[0],{...journey.steps[1],checks:[]}]}])
    assert.notEqual(caseHash({...journey,...edit}),caseHash(journey),JSON.stringify(edit));
});

test('the fixture reads numbers after their label and guards navigation and payment pages',()=>{
  assert.deepEqual(numberAfter('Credits 1,240 remaining','credits'),{value:1240,gap:1});
  assert.deepEqual(numberAfter('Balance: $12.50','Balance'),{value:12.5,gap:2});
  assert.deepEqual(numberAfter('Credits  −3','Credits'),{value:-3,gap:1});
  assert.deepEqual(numberAfter('Credits - 120','Credits'),{value:120,gap:3},'A detached sign is a separator.');
  assert.equal(numberAfter('No credits here','Seats'),null);
  for(const [text,value] of [['Credits: 1240.5 left',1240.5],['CREDITS\n\n42 remaining of 100',42],['Credits used 12, 13 left',12],['Plan 2 Credits 7',7]] as const)assert.equal(numberAfter(text,'Credits')?.value,value,text);
  for(const text of ['Credits','40 Credits',''])assert.equal(numberAfter(text,'Credits'),null,text);
  // An ancestor's text includes following siblings, so only separators may precede its number.
  for(const [text,value] of [['Credits: $12.00',12],['Credits — (−3)',-3],['1,240 credits\nSeats 3',null],['Credits used 12',null],['Billing Credits Plan 2',null]] as const)assert.equal(numberAfter(text,'Credits',true)?.value??null,value,text);
  assert.deepEqual(numberAfter('Seats 7 tokens','Seats',true),{value:7,gap:1});
  assert.equal(numberAfter('Seats left today 3','Seats',true),null);
  assert.deepEqual(numberAfter('Seats left today 3','Seats'),{value:3,gap:12});
  const allowed=new Set(['http://127.0.0.1:3000']);
  assert.equal(navigationAllowed('http://127.0.0.1:3000/settings',allowed),true);assert.equal(navigationAllowed('about:blank',allowed),true);
  assert.equal(navigationAllowed('https://example.com/',allowed),false);assert.equal(navigationAllowed('javascript:alert(1)',allowed),false);
  assert.equal(stripeLive('https://checkout.stripe.com/c/pay/cs_live_a1'),true);assert.equal(stripeLive('https://checkout.stripe.com/c/pay/cs_test_a1'),false);assert.equal(stripeLive('https://example.com/cs_live_a1'),false);
  // A Stripe page loads only when its address shows test mode, as runner.py payment_allowed reads it before any input.
  for(const [url,expected] of [['http://127.0.0.1:3010/billing',true],['https://checkout.stripe.com/c/pay/cs_test_a1',true],['https://billing.stripe.com/p/session/test_YWNj',true],['https://buy.stripe.com/test_aEU5kD',true],
    ['https://checkout.stripe.com/c/pay/cs_live_a1',false],['https://checkout.stripe.com/c/pay/cs_live_a1?next=/test_x#cs_test_',false],['https://checkout.stripe.com/c/pay/cs_live_a1/cs_test_a1',false],
    ['https://billing.stripe.com/p/session/live_YWNj',false],['https://buy.stripe.com/aEU5kD',false],['https://stripe.com/',false],['https://stripe.com.evil.test/',true]] as const)assert.equal(paymentAllowed(url),expected,url);
});

// A manager whose Playwright runtime records its launches and replays scripted events.
async function fixture(t:TestContext,{events=()=>[],environment=null,capabilities={runtimeInstalled:true,browserInstalled:true},before}:{events?:Events;environment?:TargetEnvironment|null;capabilities?:{runtimeInstalled:boolean;browserInstalled:boolean};before?:(dataDir:string)=>Promise<void>}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-specs-'));await mkdir(join(dataDir,'repo'));
  if(before)await before(dataDir);
  const launches:JourneyRunInput[]=[];
  const playwright:JourneyRuntime={capabilities:async()=>capabilities,start(input,onEvent){launches.push(input);let cancel!:()=>void;const promise=new Promise<void>((resolve,reject)=>{cancel=()=>reject(new Error('cancelled'));setTimeout(()=>{try{for(const event of events(input))onEvent(event);resolve();}catch(error){reject(error);}},10);});return {promise,cancel};}};
  const runtime={capabilities:async()=>({runtimeInstalled:true,browserInstalled:true,modelConfigured:false,modelError:'Add your OpenRouter API key.'}),start(){throw new Error('The browser-use runtime must not start.');}};
  const manager=await createBrowserManager({dataDir,runtime,playwright,resolveEnvironment:()=>environment});
  t.after(async()=>{await manager.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  if(!before){await manager.saveConfig(context,{targetUrl:'http://localhost:3000'});await manager.saveCases(context,[journey]);}
  return {manager,context,launches,dataDir,runtime,playwright};
}
async function completed({manager,context}:{manager:BrowserManager;context:BrowserStageContext},id:string){for(let i=0;i<200;i++){const report=await manager.runProgress(context,id);if(!['queued','running'].includes(report.run.status))return report;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('run did not finish');}
const passing=(input:JourneyRunInput):WorkerEvent[]=>[...input.case.steps!.flatMap(step=>[{type:'journey-step',caseId:input.case.id,stepId:step.id,status:'running'},{type:'journey-step',caseId:input.case.id,stepId:step.id,status:'completed',evidence:'Reviewed checks passed.',checks:step.checks!.map(check=>({...check,passed:true}))}]),{type:'result',result:{caseId:input.case.id,stopCause:'none',agentCompleted:true,outcomes:[{outcomeIndex:0,status:'satisfied',evidence:'Claimed'}],assertions:input.case.assertions!.map(check=>({...check,passed:true}))}}];
// The second milestone's reviewed check fails, as it does when the change it checks was not kept.
const failingSecond=(input:JourneyRunInput):WorkerEvent[]=>{const [first,second]=input.case.steps!,id=input.case.id;return [
  {type:'journey-step',caseId:id,stepId:first.id,status:'running'},{type:'journey-step',caseId:id,stepId:first.id,status:'completed',evidence:'Reviewed checks passed.',checks:first.checks!.map(check=>({...check,passed:true}))},
  {type:'journey-step',caseId:id,stepId:second.id,status:'running'},{type:'journey-step',caseId:id,stepId:second.id,status:'failed',evidence:'A reviewed check failed.',checks:second.checks!.map(check=>({...check,passed:false}))},
  {type:'result',result:{caseId:id,stopCause:'none',assertions:[]}}];};
// A journey whose checks notice: it passes, except in the control run, where nothing it changes is kept.
const noticing=(input:JourneyRunInput)=>input.blockWrites?failingSecond(input):passing(input);
async function verified(f:Awaited<ReturnType<typeof fixture>>,hash:string){
  await f.manager.verifySpec(f.context,{caseId:journey.id,hash});
  for(let i=0;i<400;i++){const verification=(await f.manager.view(f.context)).specs[journey.id]?.draft?.verification;if(verification?.status!=='running')return verification;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('verification did not finish');
}

test('code approved without a verification, as a stored single spec was, loads as a draft that a gate does not run',async t=>{
  const code=(label:string)=>spec(body().replace("'Go'",`'${label}'`)),saved=(item:typeof journey,label:string)=>({code:code(label),hash:specHash(code(label)),caseHash:caseHash(item),savedAt:'2026-09-24T08:00:00.000Z'});
  const legacy={...journey,id:'legacy'},migrated={...journey,id:'migrated'},replaced={...journey,id:'replaced'},pruned={...journey,id:'pruned'},verified={...journey,id:'verified'};
  const approvedAt='2026-09-24T09:00:00.000Z',provenance={harness:'opencode@1.18.32'},needsCode='Generate and approve code for this journey.';
  const f=await fixture(t,{events:passing,before:async dataDir=>{
    const scope=createHash('sha256').update('repo\0beta').digest('hex');
    await mkdir(join(dataDir,'browser'),{recursive:true});
    await writeFile(join(dataDir,'browser','state.json'),JSON.stringify({version:1,configs:{[scope]:{targetUrl:'http://localhost:3000/'}},cases:{[scope]:[journey,legacy,migrated,replaced,pruned,verified]},analyses:{},runs:[],specs:{[scope]:{
      // Single specs, stored before approved and draft code were kept apart: a draft, and code approved after one passing run.
      [journey.id]:{...saved(journey,'Go'),approvedAt:null},
      [legacy.id]:{...saved(legacy,'Legacy'),approvedAt,approvedRunId:'run-1',provenance},
      // Approvals naming no whole verification: one migrated from a single spec, one with a newer draft beside it, and one
      // approved after a control run whose first passing run was no longer on record.
      [migrated.id]:{approved:{...saved(migrated,'Migrated'),provenance,approvedAt,approvedRunIds:['run-1']},draft:null},
      [replaced.id]:{approved:{...saved(replaced,'Old'),approvedAt,approvedRunIds:['run-1']},draft:saved(replaced,'New')},
      [pruned.id]:{approved:{...saved(pruned,'Pruned'),approvedAt,approvedRunIds:['run-2','run-3','run-4']},draft:null},
      // Approved after its verification's three passing runs and control run.
      [verified.id]:{approved:{...saved(verified,'Verified'),approvedAt,approvedRunIds:['run-1','run-2','run-3','run-4']},draft:null},
    }}}));
  }});
  assert.deepEqual((await f.manager.view(f.context)).specs,{
    [journey.id]:{draft:{hash:specHash(code('Go')),stale:false}},
    [legacy.id]:{draft:{hash:specHash(code('Legacy')),stale:false,provenance}},
    [migrated.id]:{draft:{hash:specHash(code('Migrated')),stale:false,provenance}},
    [replaced.id]:{draft:{hash:specHash(code('New')),stale:false}},
    [pruned.id]:{draft:{hash:specHash(code('Pruned')),stale:false}},
    [verified.id]:{approved:{hash:specHash(code('Verified')),stale:false,approvedAt}},
  });
  const stored=Object.values<Record<string,unknown>>(JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')).specs)[0];
  assert.deepEqual(stored[journey.id],{approved:null,draft:saved(journey,'Go')});
  assert.deepEqual(stored[legacy.id],{approved:null,draft:{...saved(legacy,'Legacy'),provenance}});
  assert.deepEqual(stored[migrated.id],{approved:null,draft:{...saved(migrated,'Migrated'),provenance}});
  assert.deepEqual(stored[replaced.id],{approved:null,draft:saved(replaced,'New')});
  assert.deepEqual(stored[pruned.id],{approved:null,draft:saved(pruned,'Pruned')});
  // A gate runs only the verified approval; the others need review without a browser.
  const gated=await completed(f,(await f.manager.run(f.context,{})).run.id);
  assert.deepEqual(gated.results.map(item=>[item.caseId,item.status,item.error]),[...[journey,legacy,migrated,replaced,pruned].map(item=>[item.id,'needs_review',needsCode]),[verified.id,'passed',undefined]]);
  assert.deepEqual(f.launches.map(input=>[input.case.id,input.spec.hash]),[[verified.id,specHash(code('Verified'))]]);
  // The former approval is approved again only after its verification.
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:legacy.id,hash:specHash(code('Legacy'))}),{statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'});
});

test('saved code is a draft beside the approved code, approved by exact hash after its verification, discarded alone, made stale by case edits and removed with its case',async t=>{
  let events=noticing;
  const f=await fixture(t,{events:input=>events(input)});
  await assert.rejects(f.manager.saveSpec(f.context,{caseId:'missing',code:spec()}),{statusCode:404});
  await assert.rejects(f.manager.saveSpec(f.context,{caseId:journey.id,code:spec(body(['open']))}),/once per reviewed step/);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:specHash(spec())}),{statusCode:404,message:'Generate code for this test first.'});
  const saved=await f.manager.saveSpec(f.context,{caseId:journey.id,code:spec()});
  assert.deepEqual(saved.spec,{caseId:journey.id,draft:{hash:specHash(spec()),stale:false}});
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:'0'.repeat(64)}),{statusCode:409,message:'The code changed. Reload it and approve again.'});
  // A person's passing run approves nothing: approval needs a verification of exactly this code.
  const refused={statusCode:409,message:'Verify this code first: it needs three passing runs and a caught control run.'};
  assert.equal((await completed(f,(await f.manager.run(f.context,{},{manual:true})).run.id)).run.status,'passed');
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:saved.spec.draft.hash}),refused);
  const verification=await verified(f,saved.spec.draft.hash);
  assert.deepEqual(verification,{status:'passed',passes:3,control:'caught'});
  const approved=await f.manager.approveSpec(f.context,{caseId:journey.id,hash:saved.spec.draft.hash});
  assert.deepEqual(Object.keys(approved.specs[journey.id]),['approved']);
  assert.deepEqual([approved.specs[journey.id].approved?.hash,approved.specs[journey.id].approved?.stale],[saved.spec.draft.hash,false]);
  const stored:Stored=JSON.parse(await readFile(join(f.dataDir,'browser','state.json'),'utf8')),attempts=stored.runs.filter(run=>run.verification).map(run=>run.id).reverse();
  assert.deepEqual(Object.values(stored.specs)[0][journey.id].approved?.approvedRunIds,attempts);assert.equal(attempts.length,4);
  // New code is a draft beside the approved code, which still runs everywhere; discarding it keeps the approved code.
  const next=await f.manager.saveSpec(f.context,{caseId:journey.id,code:spec(body().replace("'Go'","'Next'"))});
  assert.deepEqual([next.spec.approved?.hash,next.spec.draft?.hash],[saved.spec.draft.hash,specHash(spec(body().replace("'Go'","'Next'")))]);
  for(const options of [{},{manual:true}]){await completed(f,(await f.manager.run(f.context,{},options)).run.id);assert.equal(f.launches.at(-1)?.spec.hash,saved.spec.draft.hash,'Approved code runs while it is current.');}
  await assert.rejects(f.manager.discardSpec(f.context,{caseId:journey.id,hash:saved.spec.draft.hash}),{statusCode:409});
  assert.deepEqual(Object.keys((await f.manager.discardSpec(f.context,{caseId:journey.id,hash:next.spec.draft!.hash})).specs[journey.id]),['approved']);
  await assert.rejects(f.manager.discardSpec(f.context,{caseId:journey.id,hash:next.spec.draft!.hash}),{statusCode:404});
  // The code itself is read for review; the view never carries it.
  await f.manager.saveSpec(f.context,{caseId:journey.id,code:spec(body().replace("'Go'","'Next'"))});
  assert.deepEqual(await f.manager.specCode(f.context,{caseId:journey.id}),{draft:{hash:next.spec.draft!.hash,code:spec(body().replace("'Go'","'Next'"))},approved:{hash:saved.spec.draft.hash,code:spec()}});
  assert.equal(JSON.stringify(await f.manager.view(f.context)).includes('journey.milestone'),false);
  await assert.rejects(f.manager.specCode(f.context,{caseId:'missing'}),{statusCode:404});
  // Renaming the case keeps both current; editing a check makes both stale.
  await f.manager.saveCases(f.context,[{...journey,name:'Renamed'}]);
  assert.deepEqual([(await f.manager.view(f.context)).specs[journey.id].approved?.stale,(await f.manager.view(f.context)).specs[journey.id].draft?.stale],[false,false]);
  await f.manager.saveCases(f.context,[{...journey,assertions:[{type:'text-visible',value:'Renamed workspace'}]}]);
  const stale=(await f.manager.view(f.context)).specs[journey.id];
  assert.deepEqual([stale.approved?.stale,stale.draft?.stale],[true,true]);
  const launches=f.launches.length;
  for(const options of [{},{manual:true}]){
    const report=await completed(f,(await f.manager.run(f.context,{},options)).run.id);
    assert.deepEqual([report.results?.[0].status,report.results?.[0].error],['needs_review','The approved code is for an earlier version of this journey.'],JSON.stringify(options));
  }
  assert.equal(f.launches.length,launches,'Stale code never runs.');
  await assert.rejects(f.manager.verifySpec(f.context,{caseId:journey.id,hash:next.spec.draft!.hash}),/test changed after this code was saved/);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:next.spec.draft!.hash}),/test changed after this code was saved/);
  await f.manager.saveCases(f.context,[{...journey,needsReview:true,selected:false}]);
  await assert.rejects(f.manager.approveSpec(f.context,{caseId:journey.id,hash:next.spec.draft!.hash}),/Review this test/);
  await f.manager.saveCases(f.context,[]);
  await f.manager.saveCases(f.context,[journey]);
  assert.deepEqual((await f.manager.view(f.context)).specs,{},'Code is removed with its case.');
  await f.manager.close();
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.playwright});t.after(()=>restarted.close());
  assert.deepEqual((await restarted.view(f.context)).specs,{});
});

test('every run executes Playwright code with no model, approved unless a person started it, and its results are backed by checks alone',async t=>{
  const f=await fixture(t,{events:noticing});
  const {spec:saved}=await f.manager.saveSpec(f.context,{caseId:journey.id,code:spec()});
  const {run}=await f.manager.run(f.context,{credentials:{username:'tester@example.com',password:'pw-secret'}},{manual:true});
  assert.equal(run.engine,'playwright');assert.deepEqual(run.specHashes,{[journey.id]:saved.draft!.hash});
  const report=await completed(f,run.id);
  assert.equal(report.run.status,'passed','No model is configured, and none is needed.');
  assert.deepEqual(report.results,[{caseId:journey.id,status:'passed',engine:'playwright',assertions:[{...journey.assertions[0],passed:true}]}]);
  assert.ok(report.progress?.cases[0].steps?.every(step=>step.status==='completed'&&!('provenance' in step)));
  const [input]=f.launches;
  assert.deepEqual([input.mode,input.targetUrl,input.allowedOrigins,input.case.id,input.spec,input.credentials?.username,input.blockWrites],['run','http://localhost:3000/',['http://localhost:3000'],journey.id,{code:spec(),hash:saved.draft!.hash},'tester@example.com',undefined]);
  assert.equal(f.manager.summary(f.context).runs[0].engine,'playwright');
  await verified(f,saved.draft!.hash);
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:saved.draft!.hash});
  assert.equal((await completed(f,(await f.manager.run(f.context,{})).run.id)).run.status,'passed','Approved code runs without a person.');
  // An approval kept from an older grammar does not run: the stored code is validated again at launch.
  await f.manager.close();
  const file=join(f.dataDir,'browser','state.json'),stored:Stored=JSON.parse(await readFile(file,'utf8'));
  for(const specs of Object.values(stored.specs))Object.assign(specs[journey.id].approved!,{code:spec(body()+'\n  const p = process;')});
  await writeFile(file,JSON.stringify(stored));
  const restarted=await createBrowserManager({dataDir:f.dataDir,runtime:f.runtime,playwright:f.playwright});t.after(()=>restarted.close());
  const launches=f.launches.length,refused=await completed({manager:restarted,context:f.context},(await restarted.run(f.context,{})).run.id);
  assert.equal(refused.results?.[0].status,'needs_review');
  assert.match(refused.results?.[0].error??'',/^Generate code for this journey again: Line 6: the test body only awaits journey\.milestone/);
  assert.equal(f.launches.length,launches);
});

test('a journey without runnable code needs review without a browser while the others of its run still run',async t=>{
  const other={...journey,id:'other',name:'Other journey'};
  const f=await fixture(t,{events:passing});
  await f.manager.saveCases(f.context,[journey,other]);
  await f.manager.saveSpec(f.context,{caseId:other.id,code:spec()});
  const report=await completed(f,(await f.manager.run(f.context,{},{manual:true})).run.id);
  assert.deepEqual(report.results.map(item=>[item.caseId,item.status,item.error]),[[journey.id,'needs_review','Generate and approve code for this journey.'],[other.id,'passed',undefined]]);
  assert.deepEqual(report.progress.cases.map(item=>item.status),['needs_review','passed']);
  assert.deepEqual(report.progress.cases[0].steps?.map(step=>step.status),['pending','pending']);
  assert.deepEqual(f.launches.map(input=>input.case.id),[other.id]);
  assert.deepEqual(report.run.specHashes,{[other.id]:specHash(spec())});
  assert.equal(report.run.status,'needs_review');
  // A gate runs approved code only: a draft never runs without a person.
  const gated=await completed(f,(await f.manager.run(f.context,{})).run.id);
  assert.deepEqual(gated.results.map(item=>item.error),['Generate and approve code for this journey.','Generate and approve code for this journey.']);
  assert.equal(f.launches.length,1);
});

test('code that signs in without a test account is blocked before launch',async t=>{
  const environment={id:'twin-1',status:'ready',apps:[{id:'web',url:'http://localhost:3000'}],accounts:[],services:[{id:'postgres',status:'ready'}]};
  const f=await fixture(t,{events:passing,environment});
  const code=spec("  await journey.milestone('open', async () => { await journey.signIn(); });\n  await journey.milestone('rename', async () => {});");
  await f.manager.saveSpec(f.context,{caseId:journey.id,code});
  const report=await completed(f,(await f.manager.run(f.context,{},{manual:true})).run.id);
  assert.equal(report.run.status,'blocked');assert.equal(f.launches.length,0);
  assert.deepEqual(report.results[0].blockers,[{kind:'account',evidence:'The code signs in, and no test account is available.'}]);
});

test('a missing twin service blocks only a journey that does not pass',async t=>{
  const environment={id:'twin-1',status:'ready',apps:[{id:'web',url:'http://localhost:3000'}],services:[{id:'stripe',title:'Stripe',status:'blocked',missing:['secretKey']},{id:'postgres',status:'ready'}]};
  let events=passing;
  const f=await fixture(t,{events:input=>events(input),environment});
  await f.manager.saveSpec(f.context,{caseId:journey.id,code:spec()});
  const passed=await completed(f,(await f.manager.run(f.context,{},{manual:true})).run.id);
  assert.equal(passed.run.status,'passed','a journey that never needed the missing service passes');
  // The second milestone's reviewed check fails, as it would if it needed the missing service.
  events=failingSecond;
  // The twin is released after the first result is saved, so the next run may briefly wait for it.
  const start=async()=>{for(let i=0;;i++){try{return await f.manager.run(f.context,{},{manual:true});}catch(error){if((error as HttpError).statusCode!==409||i>=200)throw error;await new Promise(resolve=>setTimeout(resolve,5));}}};
  const report=await completed(f,(await start()).run.id);
  assert.equal(f.launches.length,2);assert.equal(report.run.status,'blocked');
  assert.deepEqual(report.results[0].blockers,[{kind:'integration',evidence:'Stripe is unavailable: missing secretKey.'}]);
  assert.match(report.results[0].error??'',/^Blocked: Stripe unavailable\. Milestone check failed: /);
});

test('generated code runs once with no retries, and a flaky pass fails',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-playwright-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {default:config}=await import(pathToFileURL(await writeJourneyWorkspace(dir,{item:journey,targetUrl:'http://localhost:3000/',timeoutSeconds:60})).href);
  assert.deepEqual([config.retries,config.failOnFlakyTests,config.workers,config.timeout],[0,true,1,60000]);
});
