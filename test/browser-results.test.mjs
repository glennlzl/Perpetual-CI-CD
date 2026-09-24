import test from 'node:test';
import assert from 'node:assert/strict';
import {journeyResult,runStatus} from '../src/browser/results.mjs';

// The controller's verdict is the only one. Worker facts follow docs/architecture/journey-contract.md.
const journey={id:'save-and-reopen',expectedOutcomes:['Saved workspace reopens','Delivery reaches the test inbox'],assertions:[{type:'text-visible',value:'Saved workspace'}],steps:[{id:'account',title:'Confirm the paid plan'},{id:'pay',title:'Pay with a Stripe test card'}]};
const observations=[{outcomeIndex:0,status:'satisfied',evidence:'Reopened the saved workspace'},{outcomeIndex:1,status:'uncertain',evidence:'Test inbox is unavailable'}];
const satisfied=observations.map(item=>({...item,status:'satisfied'}));
const passing={type:'text-visible',value:'Saved workspace',passed:true},missed={...passing,passed:false};
const blocker={stepId:'pay',kind:'integration',evidence:'Stripe Checkout is not configured in this sandbox'};
const facts=changes=>({caseId:journey.id,stopCause:'none',agentCompleted:true,outcomes:satisfied,assertions:[passing],...changes});
const progress=(...statuses)=>journey.steps.map((step,index)=>({...step,status:statuses[index]||'pending'}));
const done=progress('completed','completed');
const verdict=(changes,steps=done,approved=journey)=>journeyResult(approved,facts(changes),steps);

test('a pass needs agent completion, every outcome satisfied with evidence, matching independent checks and every milestone',()=>{
  assert.deepEqual(verdict({}),{caseId:journey.id,status:'passed',agentCompleted:true,outcomes:satisfied.map(item=>({...item,provenance:'agent'})),assertions:[passing]});
  for(const changes of [{agentCompleted:false},{agentCompleted:undefined},{assertions:[]},{assertions:[{...passing,value:'Other text'}]},{assertions:[{...passing,passed:'true'}]},{outcomes:satisfied.map(item=>({...item,evidence:''}))},{outcomes:observations}]){
    const result=verdict(changes);
    assert.equal(result.status,'needs_review',JSON.stringify(changes));assert.equal(result.error,'Not all fixed outcomes have sufficient evidence and independent assertions.');
  }
  assert.equal(verdict({assertions:[]},done,{...journey,assertions:[]}).status,'needs_review','A case without independent assertions never passes.');
  assert.deepEqual(verdict({},progress('completed','running')).error,'Not every reviewed business milestone has observed completion evidence.');
});

test('outcome reports are reordered by immutable indexes, bounded and redacted, and malformed sets are never trusted',()=>{
  for(const outcomes of [undefined,[],[satisfied[0],satisfied[0]],[satisfied[0],{...satisfied[1],outcomeIndex:99}],[satisfied[0],{...satisfied[1],outcomeIndex:'1'}],[satisfied[0],{...satisfied[1],status:'passed'}]]){
    const result=verdict({outcomes});
    assert.equal(result.status,'needs_review');assert.deepEqual(result.outcomes,[]);
  }
  const result=verdict({outcomes:[{...satisfied[1],evidence:'Confirmed delivery',expectedOutcome:'Injected replacement',provenance:'independent'},{...satisfied[0],evidence:'Bearer secret-token '+'x'.repeat(5000)}]});
  assert.equal(result.status,'passed');
  assert.deepEqual(result.outcomes.map(item=>item.outcomeIndex),[0,1]);
  assert.equal(result.outcomes[0].evidence.length,2000,'Outcome evidence is stored up to 2000 characters.');
  assert.ok(!JSON.stringify(result).includes('secret-token'));assert.ok(!JSON.stringify(result).includes('Injected replacement'));
  assert.ok(result.outcomes.every(item=>item.provenance==='agent'));
});

test('worker status claims are ignored, and an unknown case or stop cause is a protocol error',()=>{
  assert.equal(verdict({status:'passed',assertions:[]}).status,'needs_review');
  assert.equal(verdict({status:'cancelled',error:'Journey exceeded its time limit.'}).status,'passed','Error text is never a signal.');
  for(const stopCause of [undefined,'cancelled','timeout','Journey exceeded its time limit.'])assert.throws(()=>verdict({stopCause}),/stop cause/,String(stopCause));
  assert.throws(()=>verdict({caseId:'other'}),/unknown case/);
});

test('one precedence decides status and message: failed, blocked, needs review, then passed',()=>{
  const failedCheck=[{...journey.steps[0],status:'completed'},{...journey.steps[1],status:'failed',checks:[{type:'compare-number',label:'Credits',name:'after',op:'>',than:'before',passed:false,observed:10,provenance:'independent'}]}];
  const table=[
    ['a failed milestone check names its milestone',{stopCause:'exception',error:'Browser transport failed',blockers:[blocker]},failedCheck,'failed','Milestone check failed: Pay with a Stripe test card.'],
    ['a reached final assertion that did not pass',{assertions:[missed]},done,'failed','A final assertion failed.'],
    ['a failed outcome outranks a blocker',{outcomes:[satisfied[0],{...satisfied[1],status:'failed'}],blockers:[blocker]},progress('completed','running'),'failed','A fixed business outcome failed.'],
    ['an exception outranks a blocked milestone',{stopCause:'exception',error:'Model authentication failed.',agentCompleted:false,outcomes:[],assertions:[]},progress('blocked'),'failed','Model authentication failed.'],
    ['a blocked milestone',{outcomes:observations},progress('completed','blocked'),'blocked','Blocked at milestone: Pay with a Stripe test card.'],
    ['a blocker names its milestone',{blockers:[blocker]},progress('completed','running'),'blocked','Blocked at milestone: Pay with a Stripe test card.'],
    ['a blocker without a milestone names its kind',{blockers:[{kind:'account',evidence:'No test account was supplied'}]},done,'blocked','Blocked: account prerequisite unavailable.'],
    ['a deadline',{stopCause:'deadline',agentCompleted:false,outcomes:[]},progress('completed','running'),'needs_review','Journey exceeded its time limit.'],
    ['forced finalization',{stopCause:'forced'},done,'needs_review','The agent finalized after an execution limit or repeated errors. Review the journey evidence and run diagnostics.'],
    ['incomplete milestones',{},progress('completed','running'),'needs_review','Not every reviewed business milestone has observed completion evidence.'],
    ['uncertain outcomes',{outcomes:observations},done,'needs_review','Not all fixed outcomes have sufficient evidence and independent assertions.'],
    ['complete evidence',{},done,'passed',undefined],
  ];
  for(const [name,changes,steps,status,error] of table){
    const result=verdict(changes,steps);
    assert.equal(result.status,status,name);assert.equal(result.error,error,name);
  }
});

test('final assertions are unreached only when the journey stopped short of its end state',()=>{
  const unreached={...missed,reached:false};
  const table=[
    ['a reported blocker',{blockers:[blocker],assertions:[missed]},done,'blocked'],
    ['a blocked milestone',{assertions:[missed]},progress('completed','blocked'),'blocked'],
    ['a deadline before every milestone completed',{stopCause:'deadline',assertions:[missed]},progress('completed','running'),'needs_review'],
    ['forced finalization before every milestone completed',{stopCause:'forced',assertions:[missed]},progress('completed'),'needs_review'],
  ];
  for(const [name,changes,steps,status] of table){
    const result=verdict(changes,steps);
    assert.equal(result.status,status,name);assert.deepEqual(result.assertions,[unreached],name);
  }
  // A case without milestones never shows that it finished before its deadline.
  const legacy={...journey,steps:[]};
  assert.deepEqual(verdict({stopCause:'deadline',assertions:[missed]},[],legacy).assertions,[unreached]);
  // Every milestone completed, or the agent finished its report: the end state was reached.
  for(const [changes,steps] of [[{stopCause:'deadline',assertions:[missed]},done],[{assertions:[missed]},progress('completed','running')],[{assertions:[unreached]},done]]){
    const result=verdict(changes,steps);
    assert.equal(result.status,'failed');assert.deepEqual(result.assertions,[missed],'The worker cannot mark its own assertions unreached.');
  }
  const kept=verdict({stopCause:'deadline'},progress('completed','running'));
  assert.equal(kept.status,'needs_review','An unreached assertion never passes.');assert.deepEqual(kept.assertions,[{...passing,reached:false}]);
});

test('a worker that stopped without a report is judged from its accepted milestones',()=>{
  const stopped=(stopCause,steps,error)=>journeyResult(journey,{caseId:journey.id,stopCause,...(error?{error}:{})},steps);
  assert.deepEqual(stopped('deadline',progress('completed','running')),{caseId:journey.id,status:'needs_review',agentCompleted:false,outcomes:[],assertions:[],error:'Journey exceeded its time limit.'});
  assert.equal(stopped('deadline',progress('completed','blocked')).status,'blocked');
  assert.equal(stopped('deadline',progress('failed')).status,'failed');
  assert.deepEqual(stopped('exception',progress('completed','running'),'Browser transport failed'),{caseId:journey.id,status:'failed',agentCompleted:false,outcomes:[],assertions:[],error:'Browser transport failed'});
  assert.equal(stopped('exception',[]).error,'The journey stopped on an error.');
  assert.equal(stopped('exception',progress('failed'),'Browser transport failed').error,'Milestone check failed: Confirm the paid plan.');
});

test('agent blockers are bounded and a malformed list is never partially trusted',()=>{
  let result=verdict({blockers:[blocker]},progress('completed','running'));
  assert.equal(result.status,'blocked');assert.deepEqual(result.blockers,[blocker]);
  for(const blockers of ['account',[{kind:'network',evidence:'x'}],[{kind:'account',evidence:''}],[{kind:'account'}],[{kind:'account',evidence:'x',stepId:'unknown'}],[{kind:'account',evidence:'x',detail:'extra'}],Array.from({length:11},()=>({kind:'fixture',evidence:'Missing fixture'}))]){
    result=verdict({blockers});
    assert.notEqual(result.status,'blocked',JSON.stringify(blockers));assert.notEqual(result.status,'passed');assert.equal(result.blockers,undefined);
  }
  result=verdict({blockers:[{kind:'account',evidence:'Bearer secret-token '+'x'.repeat(5000)}]});
  assert.equal(result.status,'blocked');assert.equal(result.blockers[0].evidence.length,2000,'Blocker evidence is stored up to 2000 characters, as the runner sends it.');assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('run diagnostics keep bounded counters only, and malformed diagnostics cannot pass',()=>{
  const diagnostics={modelCalls:3,modelFailures:{timeout:0,invalid_output:2,provider:0,other:0},stepsWithoutActions:2,forcedFinalization:true,actionCount:0};
  const result=verdict({stopCause:'forced',diagnostics:{...diagnostics,prompt:'private prompt',rawError:'private error'}});
  assert.equal(result.status,'needs_review');assert.deepEqual(result.diagnostics,diagnostics);assert.ok(!JSON.stringify(result).includes('private'));
  for(const change of [{modelCalls:-1},{actionCount:Infinity},{forcedFinalization:'false'},{modelFailures:{invalid_output:'2'}}]){
    const invalid=verdict({diagnostics:{...diagnostics,forcedFinalization:false,...change}});
    assert.equal(invalid.status,'needs_review');assert.equal(invalid.diagnostics,undefined);
  }
  // Model time and token totals are kept when plausible; an implausible one is dropped without failing the run.
  const usage={modelMs:41250,inputTokens:52000,outputTokens:1800};
  assert.deepEqual(verdict({stopCause:'forced',diagnostics:{...diagnostics,...usage}}).diagnostics,{...diagnostics,...usage});
  assert.deepEqual(verdict({stopCause:'forced',diagnostics:{...diagnostics,...usage,modelMs:-5,outputTokens:'many'}}).diagnostics,{...diagnostics,inputTokens:52000});
});

test('run roll-up orders failed, blocked, needs review, cancelled, skipped completion and pass',()=>{
  const statuses=(...values)=>values.map(status=>({status}));
  assert.equal(runStatus(statuses('passed','blocked','failed','needs_review')),'failed');
  assert.equal(runStatus(statuses('passed','needs_review','blocked','cancelled')),'blocked');
  assert.equal(runStatus(statuses('cancelled','needs_review','skipped')),'needs_review');
  assert.equal(runStatus(statuses('skipped','cancelled','passed')),'cancelled');
  assert.equal(runStatus(statuses('skipped','passed')),'completed');
  assert.equal(runStatus(statuses('passed','passed')),'passed');
});

test('a Playwright journey has no agent: its reviewed checks pass it, and an action it could not complete needs review',()=>{
  const coded=(changes,steps=done,approved=journey)=>journeyResult(approved,facts({agentCompleted:false,outcomes:[],...changes}),steps,{engine:'playwright'});
  assert.deepEqual(coded({}),{caseId:journey.id,status:'passed',engine:'playwright',agentCompleted:false,outcomes:[],assertions:[passing]});
  // Worker claims of agent completion or outcome observations are never kept for a Playwright journey.
  assert.deepEqual(coded({agentCompleted:true,outcomes:[...satisfied.slice(0,1),{...satisfied[1],status:'failed'}]}),coded({}));
  const checked={...journey,assertions:[],steps:[{...journey.steps[0],checks:[{type:'text-visible',value:'Paid plan'}]},journey.steps[1]]};
  const table=[
    ['milestone checks alone back a pass',{assertions:[]},done,checked,'passed',undefined],
    ['a journey without any check',{assertions:[]},done,{...journey,assertions:[]},'needs_review','The journey has no reviewed checks or final assertions.'],
    ['unevaluated final assertions',{assertions:[]},done,journey,'needs_review','The final assertions were not evaluated.'],
    ['a failed milestone check',{},progress('completed','failed'),journey,'failed','Milestone check failed: Pay with a Stripe test card.'],
    ['a failed final assertion',{assertions:[missed]},done,journey,'failed','A final assertion failed.'],
    ['an action the spec could not complete',{stopCause:'action',error:'Action failed at “Pay with a Stripe test card”: locator.click: Timeout 10000ms exceeded.',assertions:[]},progress('completed','running'),journey,'needs_review','Action failed at “Pay with a Stripe test card”: locator.click: Timeout 10000ms exceeded.'],
    ['a milestone order or approval mismatch',{stopCause:'action',error:'The spec did not run every reviewed milestone in order.',assertions:[]},progress('completed'),journey,'needs_review','The spec did not run every reviewed milestone in order.'],
    ['the deadline',{stopCause:'deadline',assertions:[]},progress('completed','running'),journey,'needs_review','Journey exceeded its time limit.'],
    ['a service or account missing before launch',{assertions:[],blockers:[{kind:'integration',evidence:'Stripe is unavailable: missing secretKey.'}]},progress(),journey,'blocked','Blocked: integration prerequisite unavailable.'],
    ['a controller-side exception',{stopCause:'exception',error:'The controller stopped during this journey.',assertions:[]},progress('completed','running'),journey,'failed','The controller stopped during this journey.'],
    ['incomplete milestones',{},progress('completed','running'),journey,'needs_review','Not every reviewed business milestone has observed completion evidence.'],
  ];
  for(const [name,changes,steps,approved,status,error] of table){
    const result=coded(changes,steps,approved);
    assert.equal(result.status,status,name);assert.equal(result.error,error,name);assert.equal(result.engine,'playwright',name);
  }
  // The browser-use verdict is unchanged: without agent observations the same facts need review.
  assert.equal(journeyResult(journey,facts({agentCompleted:false,outcomes:[]}),done).status,'needs_review');
  assert.equal(journeyResult(journey,facts({}),done).engine,undefined);
});
