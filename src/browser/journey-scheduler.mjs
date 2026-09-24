/** One supplied account or shared data serializes; only reviewed independent data overlaps. */
export function journeyConcurrency({cases,concurrency,account=false}){
  const isolated=cases.filter(item=>item.isolation==='isolated').length;
  const effectiveConcurrency=account||isolated<2?1:Math.min(concurrency,isolated);
  return {effectiveConcurrency,concurrencyLimit:effectiveConcurrency>=Math.min(concurrency,cases.length)?null:account?'account':'shared-data'};
}

/**
 * Owns admission and cleanup for one run. Shared application state forms a
 * FIFO barrier; a fresh browser profile is not evidence of isolated test data.
 * A launched job settles only when its runtime has finished browser cleanup.
 */
export function createJourneyScheduler({cases,concurrency=2,launch,onState=()=>{}}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Choose 1–4 concurrent journeys.');
  const queue=cases.map(item=>({item,status:'queued',job:null,result:null,error:null,skip:false}));
  let stopped=false,started=false,resolve;
  const promise=new Promise(done=>{resolve=done;});
  const update=(entry,status)=>{entry.status=status;onState(entry.item.id,status,entry);};
  const running=()=>queue.filter(entry=>entry.job);
  function settle(entry,result,error){
    entry.job=null;entry.error=error;
    if(error?.cleanupIncomplete){
      entry.result=null;update(entry,'failed');cancel();
    }else if(entry.skip){entry.result=null;update(entry,'skipped');}
    else if(stopped){entry.result=null;update(entry,'cancelled');}
    else if(error){entry.result=null;update(entry,'failed');}
    else{entry.result=result;update(entry,result?.status||'failed');}
    pump();
  }
  function pump(){
    if(!started)return;
    let active=running();
    while(!stopped&&active.length<concurrency){
      const next=queue.find(entry=>entry.status==='queued');
      if(!next)break;
      if(active.length&&(next.item.isolation!=='isolated'||active.some(entry=>entry.item.isolation!=='isolated')))break;
      update(next,'running');
      try{
        next.job=launch(next.item);
        Promise.resolve(next.job.promise).then(result=>settle(next,result),error=>settle(next,null,error));
      }catch(error){settle(next,null,error);}
      active=running();
      if(next.item.isolation!=='isolated'&&next.job)break;
    }
    let sharedAhead=running().some(entry=>entry.item.isolation!=='isolated');
    for(const entry of queue.filter(item=>item.status==='queued')){
      entry.queueReason=sharedAhead||(entry.item.isolation!=='isolated'&&running().length)?'shared-data':'browser';
      if(entry.item.isolation!=='isolated')sharedAhead=true;
      onState(entry.item.id,'queued',entry);
    }
    if(!running().length&&!queue.some(entry=>entry.status==='queued'))resolve(queue);
  }
  function cancel(){
    stopped=true;
    for(const entry of queue){
      if(entry.status==='queued')update(entry,'cancelled');
      if(entry.job){if(!entry.skip)update(entry,'cancelling');entry.job.cancel();}
    }
    pump();
  }
  function skip(id){
    const entry=queue.find(entry=>entry.item.id===id);
    if(!entry)return false;
    if(entry.status==='queued'){entry.skip=true;update(entry,'skipped');pump();}
    else if(entry.job&&!entry.skip){entry.skip=true;update(entry,'skipping');entry.job.cancel();}
    return true;
  }
  // Let the manager attach cancellation before admitting the first worker.
  queueMicrotask(()=>{started=true;pump();});
  return {promise,skip,cancel};
}
