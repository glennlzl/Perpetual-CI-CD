// Optional transport acceptance: real controller, Browser Use and owned Chromium;
// deterministic local model responses. This does not evaluate model intelligence.
// Two reviewed, isolated journeys run at concurrency 2, each in its own worker and
// browser, with milestone checks the runner evaluates on the live page.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../src/server.mjs';

const directory=await mkdtemp(join(tmpdir(),'perpetual-browser-contract-'));
const repo=join(directory,'repo');await mkdir(repo);
await writeFile(join(repo,'package.json'),'{}');
await writeFile(join(repo,'app.js'),'// Fixture product: Save updates workspace; Use credit runs work and spends one credit.\nexport const title="Workspace";');
const html='<!doctype html><html><body><h1>Workspace</h1><p>Credits <span id="credits">10</span></p><p id="result"></p><button onclick="document.querySelector(\'h1\').textContent=\'Saved workspace\'">Save</button><button onclick="document.getElementById(\'credits\').textContent=\'9\';document.getElementById(\'result\').textContent=\'Run complete\'">Use credit</button></body></html>';
const fixture=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
const plans={
  'Use a credit':{button:1,done:'Run complete',steps:[['start','Credits and workspace are visible'],['run','Run complete is shown after Use credit']]},
  'Save workspace':{button:0,done:'Saved workspace',steps:[['enter','Workspace and Save control are visible'],['save','Saved workspace heading is visible after Save']]},
};
let discovery=true,uncertain=false,observations=0,clickDecisions=0,overlap=false,concurrent=2;const seen=new Set();
async function started(name){
  if(seen.has(name))return;
  seen.add(name);
  // Hold each journey's first decision until every concurrent worker is active; serial execution stalls here and fails.
  for(let i=0;i<600&&seen.size<concurrent;i++)await new Promise(resolve=>setTimeout(resolve,50));
  if(concurrent>1&&seen.size>=concurrent)overlap=true;
}
const model=createServer((req,res)=>{void(async()=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const latest=input.messages.at(-1).content;
  const text=typeof latest==='string'?latest:latest.map(part=>part.text||'').join('\n');
  const observation=text.split('<browser_state>').at(-1);observations++;
  let action;
  if(discovery)action={done:{data:{summary:'Fixture workspace observed',cases:Object.entries(plans).map(([name,plan])=>({name,goal:`${name} and verify the result`,steps:plan.steps.map(([id])=>({id,title:`${name}: ${id}`})),preconditions:[],expectedOutcomes:[`${plan.done} visible`],assertions:[{type:'text-visible',value:plan.done}],evidence:[]}))}}};
  else{
    const name=Object.keys(plans).find(item=>JSON.stringify(input.messages).includes(item));assert.ok(name,'Model fixture must identify its journey');
    await started(name);
    // The runner asks for one milestone at a time; the latest request names the current one.
    const plan=plans[name],milestone=[...JSON.stringify(input.messages).matchAll(/Current milestone (\d)\/2/g)].at(-1)[1];
    if(milestone==='1')action={done:{data:{reached:true,evidence:plan.steps[0][1]}}};
    else if(observation.includes(plan.done))action={done:{data:{reached:true,evidence:plan.steps[1][1],outcomes:[{outcomeIndex:0,status:'satisfied',evidence:`${plan.done} is visible after the action`},...(uncertain?[{outcomeIndex:1,status:'uncertain',evidence:'Test inbox is unavailable; delivery was not observed'}]:[])]}}};
    else{const buttons=[...observation.matchAll(/\[(\d+)\][^\n]*<button|(\d+)\[:\]<button/g)].map(match=>Number(match[1]??match[2]));assert.ok(buttons.length>plan.button,'Model fixture must choose an observed browser button');clickDecisions++;action={click:{index:buttons[plan.button]}};}
  }
  const output={evaluation_previous_goal:'Observed fixture page',memory:'Choose from current page',next_goal:'Complete fixture task',action:[action]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
})().catch(error=>{res.statusCode=500;res.end(JSON.stringify({error:error.message}));});});
let app,token,stageId,frames=0,frameBytes=0,activity=0,parallel=0;const caseFrames={};
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return `http://127.0.0.1:${server.address().port}`;}
async function call(path,body){const response=await fetch(app.url+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Perpetual-Token':token}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
const context=()=>({repoPath:repo,stageId});
const query=extra=>new URLSearchParams({...context(),...extra});
async function frame(id,caseId){
  const response=await fetch(`${app.url}/api/browser/runs/${id}/frame?${query(caseId?{caseId}:{})}`);
  if(response.status!==200)return;
  assert.equal(response.headers.get('content-type'),'image/jpeg');const bytes=await response.arrayBuffer();frames++;frameBytes+=bytes.byteLength;
  if(caseId)caseFrames[caseId]=(caseFrames[caseId]||0)+1;
}
async function finish(id){
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    const report=await call(`/api/browser/runs/${id}?${query()}`);
    await frame(id);for(const item of report.progress.cases)if(item.id!=='discovery')await frame(id,item.id);
    activity=Math.max(activity,...report.progress.cases.map(item=>item.actionCount));
    parallel=Math.max(parallel,report.progress.cases.filter(item=>item.status==='running').length);
    if(!['queued','running'].includes(report.run.status))return report;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error('Browser controller contract timed out.');
}
try{
  const targetUrl=await listen(fixture),baseUrl=await listen(model);
  app=await startServer({port:0,repo,dataDir:join(directory,'controller')});
  token=(await call('/api/session')).token;await call('/api/scan',{path:repo});
  stageId=(await call('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'})).pipeline.stages.find(stage=>stage.name==='Beta').id;
  await call('/api/browser/model',{...context(),apiKey:'fixture-not-a-real-key',model:'fixture',baseUrl:baseUrl+'/v1'});
  await call('/api/browser/config',{...context(),config:{targetUrl,maxSteps:10,journeyTimeoutSeconds:300}});
  const generated=await call('/api/browser/discover',context());
  const generation=await finish(generated.run.id);assert.equal(generation.run.status,'completed',JSON.stringify(generation));
  const view=await call(`/api/browser?${query()}`);assert.equal(view.cases.length,2);assert.ok(view.cases.every(item=>!item.selected&&item.needsReview&&item.isolation==='shared'));
  // Review adds independent milestone checks and approves independent data for both journeys.
  const checks={start:[{type:'read-number',label:'Credits',name:'before'},{type:'text-visible',value:'Workspace'}],run:[{type:'text-visible',value:'Run complete'},{type:'compare-number',label:'Credits',name:'after',op:'<',than:'before'}],enter:[{type:'text-visible',value:'Workspace'}],save:[{type:'text-visible',value:'Saved workspace'}]};
  const reviewed=view.cases.map(item=>({...item,selected:true,needsReview:false,isolation:'isolated',steps:item.steps.map(step=>({...step,checks:checks[step.id]}))}));
  await call('/api/browser/cases',{...context(),cases:reviewed,baseCases:view.cases});
  discovery=false;
  const started=await call('/api/browser/run',{...context(),caseIds:reviewed.map(item=>item.id),concurrency:2});
  assert.equal(started.run.effectiveConcurrency,2);assert.equal(started.run.concurrencyLimit,null);
  const report=await finish(started.run.id);assert.equal(report.run.status,'passed',JSON.stringify(report));
  assert.ok(overlap,'Both journeys must be active at the same time');
  for(const item of reviewed){
    const result=report.results.find(value=>value.caseId===item.id),progress=report.progress.cases.find(value=>value.id===item.id);
    assert.equal(result.status,'passed');assert.ok(result.assertions.every(check=>check.passed));assert.equal(result.outcomes[0].provenance,'agent');
    assert.ok(caseFrames[item.id]>0,`Frames for ${item.name}`);assert.ok(progress.actionCount>0);assert.ok(progress.frameCapturedAt);
    assert.deepEqual(progress.steps.map(step=>step.status),['completed','completed']);
    assert.ok(progress.steps.every(step=>step.provenance==='agent'&&step.evidence.trim()));
    assert.ok(progress.steps.every(step=>step.checks.length===checks[step.id].length&&step.checks.every(check=>check.passed&&check.provenance==='independent')));
  }
  const credit=report.progress.cases.find(item=>item.name==='Use a credit').steps;
  assert.equal(credit[0].checks[0].observed,10);assert.equal(credit[1].checks[1].observed,9);
  assert.ok(report.progress.revision>0);
  const save=reviewed.find(item=>item.name==='Save workspace');
  const changed=reviewed.map(item=>item===save?{...item,goal:'Save workspace and verify delivery',expectedOutcomes:[...item.expectedOutcomes,'Delivery reaches the test inbox']}:item);
  await call('/api/browser/cases',{...context(),cases:changed});uncertain=true;concurrent=1;seen.clear();
  const second=await call('/api/browser/run',{...context(),caseIds:[save.id]});
  const unverified=await finish(second.run.id);
  assert.equal(unverified.run.status,'needs_review',JSON.stringify(unverified));
  assert.equal(unverified.results[0].assertions[0].passed,true);
  assert.deepEqual(unverified.results[0].outcomes.map(item=>item.status),['satisfied','uncertain']);
  assert.match(unverified.results[0].outcomes[1].evidence,/delivery was not observed/);
  assert.ok(unverified.results[0].outcomes.every(item=>item.provenance==='agent'));
  const history=await call(`/api/browser?${query()}`);
  assert.deepEqual(history.runs.find(item=>item.id===second.run.id).results,unverified.results);
  process.stdout.write(JSON.stringify({kind:'deterministic-protocol-fixture',discovery:generation.run.status,reviewRequired:true,run:report.run.status,journeys:reviewed.length,concurrency:report.run.effectiveConcurrency,parallel,overlap,uncertainRun:unverified.run.status,frames,caseFrames:Object.values(caseFrames),frameBytes,activity,observations,clickDecisions,realModelInference:false})+'\n');
}finally{
  await app?.close();for(const server of [fixture,model]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(directory,{recursive:true,force:true});
}
