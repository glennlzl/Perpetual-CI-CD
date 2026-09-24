const conflict=message=>Object.assign(new Error(message),{statusCode:409});
const stageKey=({key,stageId})=>JSON.stringify([key,stageId]);

// Leases last until execution and its durable result have settled. Stage
// membership prevents removal; only the same environment requires exclusivity.
export function createEnvironmentUsage(){
  const leases=new Set(),removals=new Map();let closed=false;
  function assertAvailable(context,{environmentId=null,removalToken=null}={}){
    if(closed)throw conflict('The controller is shutting down.');
    const stage=stageKey(context);
    for(const [token,removal] of removals){
      if(removal.stage!==stage&&!removal.environmentIds.has(environmentId))continue;
      if(token===removalToken&&removal.stage===stage&&removal.environmentIds.has(environmentId))continue;
      throw conflict('This stage is being deleted. Retry deletion to finish its cleanup.');
    }
  }
  return {
    assertAvailable,
    acquire(context,options={}){
      assertAvailable(context,options);
      const {environmentId=null,operation='operation'}=options;
      if(environmentId&&[...leases].some(item=>item.environmentId===environmentId))throw conflict('This environment has an operation in progress.');
      const lease={stage:stageKey(context),environmentId,operation};leases.add(lease);
      return ()=>leases.delete(lease);
    },
    isBusy:environmentId=>[...leases].some(item=>item.environmentId===environmentId)||[...removals.values()].some(item=>item.environmentIds.has(environmentId)),
    beginRemoval(context,environmentIds=[]){
      assertAvailable(context);
      const stage=stageKey(context),ids=new Set(environmentIds);
      if([...leases].some(item=>item.stage===stage||ids.has(item.environmentId)))throw conflict('Wait for this stage’s environment operations to finish before deleting it.');
      for(const removal of removals.values())if([...ids].some(id=>removal.environmentIds.has(id)))throw conflict('This environment is already being deleted.');
      const token=Symbol('stage-removal');removals.set(token,{stage,environmentIds:ids});return token;
    },
    endRemoval:token=>removals.delete(token),
    stopAdmissions(){closed=true;},
  };
}
