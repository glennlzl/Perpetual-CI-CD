import {browserError} from './runtime.mjs';

const safeText=(value,limit=800)=>value?browserError(String(value),process.env,limit):'';
const outcomeStates=new Set(['satisfied','failed','uncertain']);
const blockerKinds=new Set(['account','fixture','integration','permission','environment']);
// How a journey ended: none (the agent finished its report, or a spec ran to its end or to a failed check),
// deadline (its time limit), forced (Browser Use forced a final report after repeated failures), action (a spec's
// action, milestone order or approval could not be carried out) or exception (the journey could not continue).
const stopCauses=new Set(['none','deadline','forced','action','exception']);

// Persist counters only: worker diagnostics must never carry prompts or provider errors.
function runDiagnostics(value){
  const count=n=>Number.isInteger(n)&&n>=0&&n<=1000;
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.forcedFinalization!=='boolean')return null;
  if(!['modelCalls','stepsWithoutActions','actionCount'].every(key=>count(value[key])))return null;
  const categories=['timeout','invalid_output','provider','other'];
  if(!value.modelFailures||!categories.every(key=>count(value.modelFailures[key])))return null;
  // Model time and tokens are optional totals; an implausible value is dropped, not trusted.
  const usage=Object.fromEntries(['modelMs','inputTokens','outputTokens'].filter(key=>Number.isInteger(value[key])&&value[key]>=0&&value[key]<=1e9).map(key=>[key,value[key]]));
  return {modelCalls:value.modelCalls,modelFailures:Object.fromEntries(categories.map(key=>[key,value.modelFailures[key]])),stepsWithoutActions:value.stepsWithoutActions,forcedFinalization:value.forcedFinalization,actionCount:value.actionCount,...usage};
}

// Only immutable approved indexes identify outcomes. Agent-supplied labels and
// provenance cannot replace those in the run's approved case snapshot.
function observations(original,received){
  const count=original.expectedOutcomes?.length || 0;
  if(!count || !Array.isArray(received) || received.length!==count || count>50)return [];
  const seen=new Set();
  for(const item of received){
    if(!item || !Number.isInteger(item.outcomeIndex) || item.outcomeIndex<0 || item.outcomeIndex>=count || seen.has(item.outcomeIndex) || !outcomeStates.has(item.status) || typeof item.evidence!=='string')return [];
    seen.add(item.outcomeIndex);
  }
  return received.map(({outcomeIndex,status,evidence})=>({outcomeIndex,status,evidence:safeText(evidence.trim(),2000),provenance:'agent'})).sort((a,b)=>a.outcomeIndex-b.outcomeIndex);
}

// Missing accounts, fixtures or integrations stay explicit; a malformed list is never partially trusted.
function reportedBlockers(original,value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>10)return null;
  const steps=new Set((original.steps||[]).map(step=>step.id));
  const valid=value.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).every(key=>['stepId','kind','evidence'].includes(key))&&blockerKinds.has(item.kind)&&typeof item.evidence==='string'&&item.evidence.trim()&&(item.stepId===undefined||steps.has(item.stepId)));
  return valid?value.map(({stepId,kind,evidence})=>({...(stepId===undefined?{}:{stepId}),kind,evidence:safeText(evidence.trim(),2000)})):null;
}

// Independent final assertion results count only for exactly the approved assertions, in order.
function finalChecks(original,received){
  const expected=original.assertions||[];
  const matches=Array.isArray(received)&&received.length===expected.length&&expected.every((a,i)=>a.type===received[i]?.type&&a.value===received[i]?.value&&typeof received[i]?.passed==='boolean');
  return matches?expected.map(({type,value},i)=>({type,value,passed:received[i].passed})):null;
}

/**
 * The only journey verdict: untrusted worker facts, accepted milestone progress and the approved case
 * snapshot decide status and message, failed before blocked before needs review before passed.
 * engine is the controller's: a Playwright journey has no agent, so its reviewed checks alone can pass it.
 */
export function journeyResult(approved,facts,steps=[],{engine='browser-use'}={}){
  if(facts?.caseId!==approved.id)throw new Error('Browser runtime returned an unknown case.');
  const stop=facts.stopCause,coded=engine==='playwright';
  if(!stopCauses.has(stop))throw new Error('Browser runtime returned an invalid stop cause.');
  const outcomes=coded?[]:observations(approved,facts.outcomes),blockers=reportedBlockers(approved,facts.blockers),diagnostics=coded?null:runDiagnostics(facts.diagnostics),checks=finalChecks(approved,facts.assertions);
  const failed=steps.find(step=>step.status==='failed'),blocked=steps.find(step=>step.status==='blocked');
  // Final assertions describe the end state. The journey stopped short of it at a blocked or failed milestone
  // or a reported blocker, or when it ended early before every milestone completed; a case without
  // milestones never shows it finished. An unreached assertion is context, never a failure or a pass.
  const short=Boolean(failed||blocked||blockers?.length)||stop!=='none'&&(!steps.length||steps.some(step=>step.status!=='completed'));
  const assertions=(checks||[]).map(item=>short?{...item,reached:false}:item);
  function decide(){
    if(failed)return ['failed',`Milestone check failed: ${failed.title}.`];
    if(assertions.some(item=>!item.passed&&!short))return ['failed','A final assertion failed.'];
    if(outcomes.some(item=>item.status==='failed'))return ['failed','A fixed business outcome failed.'];
    if(stop==='exception')return ['failed',safeText(facts.error)||'The journey stopped on an error.'];
    if(blocked||blockers?.length){
      const title=blocked?.title||steps.find(step=>step.id===blockers[0].stepId)?.title;
      return ['blocked',title?`Blocked at milestone: ${title}.`:`Blocked: ${blockers[0].kind} prerequisite unavailable.`];
    }
    if(stop==='deadline')return ['needs_review','Journey exceeded its time limit.'];
    if(stop==='action')return ['needs_review',safeText(facts.error)||'A journey action could not be completed.'];
    if(stop==='forced')return ['needs_review','The agent finalized after an execution limit or repeated errors. Review the journey evidence and run diagnostics.'];
    if(steps.some(step=>step.status!=='completed'))return ['needs_review','Not every reviewed business milestone has observed completion evidence.'];
    if(coded){
      if(!checks||!blockers)return ['needs_review','The final assertions were not evaluated.'];
      return assertions.length||(approved.steps||[]).some(step=>step.checks?.length)?['passed',null]:['needs_review','The journey has no reviewed checks or final assertions.'];
    }
    if(!checks||!assertions.length||!blockers||facts.diagnostics!==undefined&&!diagnostics||facts.agentCompleted!==true||!outcomes.length||outcomes.some(item=>item.status!=='satisfied'||!item.evidence))return ['needs_review','Not all fixed outcomes have sufficient evidence and independent assertions.'];
    return ['passed',null];
  }
  const [status,error]=decide();
  return {caseId:approved.id,status,...(coded?{engine}:{}),agentCompleted:!coded&&facts.agentCompleted===true,outcomes,assertions,...(blockers?.length?{blockers}:{}),...(diagnostics?{diagnostics}:{}),...(error?{error}:{})};
}

const rollUp=['failed','blocked','needs_review','cancelled'];
export const runStatus=results=>rollUp.find(status=>results.some(item=>item.status===status))||(results.some(item=>item.status==='skipped')?'completed':'passed');
