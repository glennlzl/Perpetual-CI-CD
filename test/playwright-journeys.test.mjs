import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrowserManager} from '../src/browser/manager.mjs';
import {createPlaywrightRuntime} from '../src/journeys/playwright/runtime.mjs';
import {specHash,validateJourneySpec} from '../src/journeys/playwright/specs.mjs';
import {journeyResult} from '../src/browser/results.mjs';

// A real local Chromium runs specs through the manager, as a manual Beta run with engine playwright does.
const account={username:'tester@example.com',password:'pw-secret-4821'};
const page=(title,body)=>`<!doctype html><title>${title}</title><body>${body}</body>`;
function application({persist=true}={}){
  const state={name:'Original Name',credits:10},leaks=[],hosts=new Set();
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://app'),signedIn=/session=1/.test(req.headers.cookie||'');hosts.add(req.headers.host);
    const send=(html,headers={})=>{res.writeHead(200,{'content-type':'text/html',...headers});res.end(html);};
    const redirect=(location,headers={})=>{res.writeHead(303,{location,...headers});res.end();};
    let body='';req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const form=new URLSearchParams(body);
      // A redirect or a link to wherever ?to= says, and a record of what a spec's own requests could send.
      if(url.pathname==='/away')return redirect(url.searchParams.get('to'));
      if(url.pathname==='/link')return send(page('Link',`<a href="${url.searchParams.get('to')}">Leave</a>`));
      if(url.pathname==='/leak'){leaks.push(url.searchParams.get('pw'));return send(page('Leak',''));}
      if(url.pathname==='/')return redirect(signedIn?'/settings':'/login');
      if(url.pathname==='/login'&&req.method==='POST')return form.get('email')===account.username&&form.get('password')===account.password?redirect('/settings',{'set-cookie':'session=1; Path=/'}):redirect('/login');
      if(url.pathname==='/login')return send(page('Sign in','<form method=post action=/login><label>Email <input type=email name=email autocomplete=username></label><label>Password <input type=password name=password></label><button type=submit>Sign in</button></form>'));
      if(!signedIn)return redirect('/login');
      if(url.pathname==='/settings'&&req.method==='POST'){state.credits--;if(persist)state.name=form.get('name');return redirect('/settings?saved=1');}
      if(url.pathname==='/settings')return send(page('Settings',`<h1>Settings</h1><p>Signed in as ${state.name}</p><p><span>Credits</span> <strong>${state.credits}</strong></p>${url.searchParams.has('saved')?'<p role=status>Saved</p>':''}<form method=post action=/settings><label>Display name <input id=display-name name=name value="${state.name}"></label><button>Save</button></form>`));
      res.writeHead(404);res.end();
    });
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({server,leaks,hosts,url:`http://127.0.0.1:${server.address().port}/`})));
}

const journey={id:'rename',name:'Rename the display name',goal:'Change my display name and see it kept after a reload.',isolation:'shared',selected:true,needsReview:false,
  steps:[
    {id:'open-settings',title:'Sign in and open Settings',checks:[{type:'url-contains',value:'/settings'},{type:'read-number',label:'Credits',name:'before'}]},
    {id:'save-name',title:'Save the display name Twin Tester',checks:[{type:'text-visible',value:'Saved'},{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'}]},
    {id:'reload',title:'Reload Settings and see the new name',checks:[{type:'text-visible',value:'Signed in as Twin Tester'}]},
  ],
  preconditions:['A test account'],expectedOutcomes:['After a reload, Settings shows Twin Tester.'],assertions:[{type:'text-absent',value:'Original Name'}]};
const spec=({missing=false,linger=false,reload='await page.reload();'}={})=>`import { test } from 'perpetual';

test('Rename the display name', async ({ page, journey }) => {
  await journey.milestone('open-settings', async () => {
    await journey.signIn();
  });
  await journey.milestone('save-name', async () => {
    ${missing?"await page.locator('#nickname').fill('Twin Tester', { timeout: 1000 });":"await page.getByLabel('Display name').fill('Twin Tester');"}
    await page.getByRole('button', { name: 'Save' }).click();
  });
  await journey.milestone('reload', async () => {
    ${linger?'await page.waitForTimeout(60000);':''}${reload}
  });
});
`;

async function setup(t,options){
  const app=await application(options);
  const dataDir=await mkdtemp(join(tmpdir(),'perpetual-playwright-journeys-'));await mkdir(join(dataDir,'repo'));
  const runtime={capabilities:async()=>({runtimeInstalled:true,modelConfigured:false}),start(){throw new Error('The browser-use runtime is not used.');}};
  const manager=await createBrowserManager({dataDir,runtime,playwright:createPlaywrightRuntime({checkTimeoutMs:3000})});
  t.after(async()=>{await manager.close();app.server.closeAllConnections();app.server.close();await rm(dataDir,{recursive:true,force:true});});
  const context={key:'repo',stageId:'beta',controllerOrigin:'http://127.0.0.1:4317',scan:{repo:{path:join(dataDir,'repo'),sha:'abc'}}};
  await manager.saveConfig(context,{targetUrl:app.url,journeyTimeoutSeconds:60});
  await manager.saveCases(context,[journey]);
  // A person's manual run tries a saved draft; approval follows its passing run.
  const draft=async code=>(await manager.saveSpec(context,{caseId:journey.id,code})).spec;
  const run=input=>manager.run(context,{engine:'playwright',credentials:account,...input},{manual:true});
  return {manager,context,dataDir,draft,run,app};
}
// Runs a spec in the worker directly, as the manager would after approval, with any allowed origins.
async function runSpec(target,code,{allowedOrigins=[new URL(target).origin],timeoutSeconds=30,item=journey}={}){
  const events=[];
  await createPlaywrightRuntime({checkTimeoutMs:3000}).start({mode:'run',targetUrl:target,allowedOrigins,timeoutSeconds,credentials:account,case:item,spec:{code,hash:specHash(code)}},event=>{if(!['frame','case'].includes(event.type))events.push(event);}).promise;
  return events;
}
async function finished({manager,context},id,seconds=90){
  for(const end=Date.now()+seconds*1000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){const report=await manager.runProgress(context,id);if(!['queued','running'].includes(report.run.status))return report;}
  throw new Error('The run did not finish.');
}

test('a draft spec passes its reviewed journey with live frames, actions and a recording, and is then approved',{timeout:120000},async t=>{
  const f=await setup(t);
  await assert.rejects(f.run(),/Generate current Playwright code for “Rename the display name”/);
  const draft=await f.draft(spec());
  await assert.rejects(f.manager.run(f.context,{engine:'playwright',credentials:account}),/Approve a current Playwright spec for “Rename the display name”/,'Only a person runs a draft.');
  const {run}=await f.run();
  assert.equal(run.engine,'playwright');
  const report=await finished(f,run.id);
  assert.equal(report.run.status,'passed',JSON.stringify(report.results));
  assert.deepEqual(report.results,[{caseId:journey.id,status:'passed',engine:'playwright',agentCompleted:false,outcomes:[],assertions:[{type:'text-absent',value:'Original Name',passed:true}]}]);
  const [progress]=report.progress.cases;
  assert.deepEqual(progress.steps.map(step=>[step.id,step.status,step.provenance]),journey.steps.map(step=>[step.id,'completed','playwright']));
  // The number read before saving is compared after it.
  assert.deepEqual(progress.steps.flatMap(step=>step.checks.map(check=>[check.name||check.value,check.passed,check.observed])),[['/settings',true,undefined],['before',true,10],['Saved',true,undefined],['after',true,9],['Signed in as Twin Tester',true,undefined]]);
  assert.match(progress.steps[1].evidence,/^Reviewed checks passed: Text visible “Saved”; Credits 9 < before 10\.$/);
  assert.deepEqual(progress.actions.map(action=>action.type),['sign_in_with_test_account','input','click','reload_page']);
  assert.ok(progress.actions.every(action=>action.status==='passed'));
  const frame=await f.manager.frame(f.context,run.id,journey.id);
  assert.ok(frame.length>100&&frame[0]===0xff&&frame[1]===0xd8,'A JPEG frame reached the live view.');
  assert.equal(progress.videos.length,1);
  const video=await f.manager.video(f.context,run.id,journey.id,progress.videos[0]);
  assert.ok((await stat(video.path)).size>1000);
  assert.ok(!JSON.stringify(report).includes(account.password));
  assert.equal((await f.manager.view(f.context)).specs[journey.id].verified,true);
  await f.manager.approveSpec(f.context,{caseId:journey.id,hash:draft.hash});
  assert.equal((await f.manager.view(f.context)).specs[journey.id].approved,true);
});

test('a reviewed check the application does not satisfy fails the journey',{timeout:120000},async t=>{
  const f=await setup(t,{persist:false});
  await f.draft(spec());
  const {run}=await f.run();
  const report=await finished(f,run.id);
  assert.equal(report.run.status,'failed');
  assert.equal(report.results[0].error,'Milestone check failed: Reload Settings and see the new name.');
  const steps=report.progress.cases[0].steps;
  assert.deepEqual(steps.map(step=>step.status),['completed','completed','failed']);
  assert.equal(steps[2].checks[0].passed,false);
  assert.deepEqual(report.results[0].assertions,[],'The end state was never reached, so no final assertion ran.');
});

test('a spec action that cannot complete needs review, never a product failure',{timeout:120000},async t=>{
  const f=await setup(t);
  await f.draft(spec({missing:true}));
  const {run}=await f.run();
  const report=await finished(f,run.id);
  assert.equal(report.run.status,'needs_review');
  assert.match(report.results[0].error,/^Action failed at “Save the display name Twin Tester”: .*locator\.fill: Timeout 1000ms exceeded/);
  assert.deepEqual(report.progress.cases[0].steps.map(step=>step.status),['completed','unconfirmed','pending']);
  assert.equal(report.progress.cases[0].actions.at(-1).status,'failed');
});

test('skipping a Playwright journey stops its process and keeps its recording',{timeout:120000},async t=>{
  const f=await setup(t);
  await f.draft(spec({linger:true}));
  const {run}=await f.run();
  for(let report;!(report=await f.manager.runProgress(f.context,run.id)).progress.cases[0].steps.some(step=>step.id==='reload'&&step.status==='running');)await new Promise(resolve=>setTimeout(resolve,100));
  const skipped=Date.now();
  await f.manager.skip(f.context,run.id,journey.id);
  const report=await finished(f,run.id,30);
  assert.ok(Date.now()-skipped<20000,'Skip stopped the lingering journey.');
  assert.equal(report.run.status,'completed');
  assert.equal(report.progress.cases[0].status,'skipped');
  assert.deepEqual(report.progress.cases[0].steps.map(step=>step.status),['completed','completed','skipped']);
  assert.equal(report.progress.cases[0].videos?.length,1);
});

test('leaving the approved origins needs review, whether by address, server redirect or clicked link',{timeout:120000},async t=>{
  const f=await setup(t);
  // The same server under another host name is another origin.
  const target=(await f.manager.view(f.context)).config.targetUrl,outside=`${target.replace('127.0.0.1','localhost')}settings`;
  for(const reload of [`await page.goto('${outside}');`,`await page.goto('/away?to=${encodeURIComponent(outside)}');`,`await page.goto('/link?to=${encodeURIComponent(outside)}');\n    await page.getByText('Leave').click();`]){
    await f.draft(spec({reload}));
    const report=await finished(f,(await f.run()).run.id);
    assert.equal(report.run.status,'needs_review',reload);
    assert.equal(report.results[0].error,'Action failed at “Reload Settings and see the new name”: Navigation is outside approved origins.',reload);
    assert.deepEqual(report.progress.cases[0].steps.map(step=>step.status),['completed','completed','unconfirmed'],reload);
  }
  assert.deepEqual([...f.app.hosts],[new URL(target).host],'No request, not even a redirect hop, reached the other origin.');
  // A Stripe page loads only in test mode: a live Checkout behind a redirect, or a page that does not show test mode, stops the journey.
  const pay={...journey,steps:[{id:'pay',title:'Pay',checks:[{type:'text-visible',value:'Paid'}]}],assertions:[]};
  for(const address of [`/away?to=${encodeURIComponent('https://checkout.stripe.com/c/pay/cs_live_a1')}`,'https://buy.stripe.com/aEU5kD']){
    const code=`import { test } from 'perpetual';\ntest('Pay', async ({ page, journey }) => {\n  await journey.milestone('pay', async () => {\n    await page.goto('${address}');\n  });\n});\n`;
    const events=await runSpec(target,code,{item:pay,allowedOrigins:[new URL(target).origin,'https://checkout.stripe.com','https://buy.stripe.com']});
    assert.deepEqual(events.at(-1).result,{caseId:journey.id,agentCompleted:false,outcomes:[],assertions:[],stopCause:'action',error:'Action failed at “Pay”: Payment pages accept input only in Stripe test mode.'},address);
  }
});

test('a spec that skips a milestone, differs from its approval or runs out of time needs review',{timeout:120000},async t=>{
  const f=await setup(t);
  const target=(await f.manager.view(f.context)).config.targetUrl;
  // Validation rejects a conditional milestone; the fixture enforces coverage for any spec that reaches it.
  const conditional=spec().replace("  await journey.milestone('reload'","  if (await page.getByText('Never shown').count()) await journey.milestone('reload'");
  assert.throws(()=>validateJourneySpec(conditional,journey),/Line 11: the test body only awaits journey\.milestone/);
  assert.deepEqual((await runSpec(target,conditional)).at(-1).result,{caseId:journey.id,agentCompleted:false,outcomes:[],assertions:[],stopCause:'action',error:'The spec did not run every reviewed milestone in order.'});
  // A worker handed code that is not the approved spec refuses to run it.
  const facts=[],code=spec();
  await createPlaywrightRuntime().start({mode:'run',targetUrl:target,allowedOrigins:[new URL(target).origin],timeoutSeconds:30,case:journey,spec:{code,hash:specHash(`${code}\n`)}},event=>{if(event.type==='result')facts.push(event.result);}).promise;
  assert.deepEqual(facts,[{caseId:journey.id,agentCompleted:false,outcomes:[],assertions:[],stopCause:'action',error:'The spec differs from its approved version.'}]);
  // Playwright's test timeout is the journey's deadline.
  const events=await runSpec(target,spec({linger:true}),{timeoutSeconds:4});
  assert.deepEqual(events.filter(event=>event.type==='journey-step').map(event=>`${event.stepId}:${event.status}`),['open-settings:running','open-settings:completed','save-name:running','save-name:completed','reload:running']);
  assert.equal(events.at(-1).result.stopCause,'deadline');
});

test('a spec that escaped validation can neither forge milestones nor read the account',{timeout:120000},async t=>{
  const f=await setup(t,{persist:false});
  const target=(await f.manager.view(f.context)).config.targetUrl;
  // Rewriting the page after a reload would pass the application that does not keep the name; the grammar has no page scripts.
  await assert.rejects(f.draft(spec({reload:"await page.reload();\n    await page.addScriptTag({ content: \"document.body.innerHTML = document.body.innerHTML.replaceAll('Original Name', 'Twin Tester')\" });"})),/Line 13: page\.addScriptTag is not an allowed journey action\./);
  // Milestones named only in a comment, forged events on the channel and the account sent through Node's fetch.
  const forged=`import { test } from 'perpetual';
// journey.milestone('open-settings', …); journey.milestone('save-name', …); journey.milestone('reload', …);
test('Rename the display name', async ({ page }) => {
  const p = process, say = event => p.stdout.write(p.env.PERPETUAL_EVENT_CHANNEL + JSON.stringify({ ...event, caseId: 'rename' }) + '\\n');
  for (const stepId of ['open-settings', 'save-name', 'reload']) { say({ type: 'journey-step', stepId, status: 'running' }); say({ type: 'journey-step', stepId, status: 'completed', evidence: 'Forged.', checks: [] }); }
  say({ type: 'assertions', assertions: [{ type: 'text-absent', value: 'Original Name', passed: true }] });
  await fetch(p.env.PERPETUAL_TARGET_URL + 'leak?pw=' + p.env.PERPETUAL_ACCOUNT_PASSWORD);
});
`;
  await assert.rejects(f.manager.saveSpec(f.context,{caseId:journey.id,code:forged}),/Line 4: the test body only awaits journey\.milestone/);
  const events=await runSpec(target,forged),facts=events.at(-1).result;
  assert.deepEqual(events.map(event=>event.type),['result'],'No forged milestone or assertion reached the controller.');
  assert.deepEqual(f.app.leaks,['undefined'],'The spec ran, and the account had left its environment.');
  assert.equal(journeyResult(journey,facts,journey.steps.map(({id,title})=>({id,title,status:'pending'})),{engine:'playwright'}).status,'needs_review');
});
