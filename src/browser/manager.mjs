import {randomUUID,createHash} from 'node:crypto';
import {mkdir,lstat,readFile,readdir,writeFile,rename,rm,chmod,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createBrowserRuntime,validateBrowserTarget,browserError} from './runtime.mjs';
import {validateBrowserCases,browserDiscoveryContext,discoveredBrowserCases,assertReviewedJourneys} from '../business/browser-cases.mjs';
import {createBrowserModelSettings} from './model.mjs';
import {createOpenRouterModelCatalog,isOpenRouterEndpoint} from './openrouter-models.mjs';
import {draftBrowserCase,transcribeBrowserAudio,validateTestDescription} from './openrouter-input.mjs';
import {journeyResult,runStatus} from './results.mjs';
import {createJourneyScheduler,journeyConcurrency} from './journey-scheduler.mjs';
import {createEnvironmentUsage} from '../environments/usage.mjs';
import {validateRunCredentials} from './run-credentials.mjs';
import {services as twinServices} from '../twin/registry.mjs';
import {appId} from '../twin/detect.mjs';
import {createTwinRuntime} from '../twin/runtime.mjs';
import {createPlaywrightRuntime} from '../journeys/playwright/runtime.mjs';
import {caseHash,signsIn,specHash,validateJourneySpec} from '../journeys/playwright/specs.mjs';
import {CANCELLED,generateJourneySpec} from '../journeys/playwright/generation.mjs';

const now=()=>new Date().toISOString();
const scopeId=({key,stageId})=>createHash('sha256').update(`${key}\0${stageId}`).digest('hex');
const conflict=message=>Object.assign(new Error(message),{statusCode:409});
const publicRun=({scope,approvedCases,environmentUseUncertain,...run})=>structuredClone({...run,caseSummaries:(approvedCases||[]).map(({id,name,goal,preconditions,expectedOutcomes,assertions,steps,isolation})=>({id,name,goal,preconditions,expectedOutcomes,assertions,steps:steps||[],isolation:isolation||'shared'}))});
const summaryKeys=new Set(['id','stageId','environmentId','mode','engine','status','createdAt','startedAt','completedAt','targetUrl','sourceRevision','caseIds','caseSummaries','results','error','frameUpdatedAt','frameCapturedAt','concurrency','effectiveConcurrency','concurrencyLimit']);
// Graph polling carries live state only; full action lists stay in runProgress.
function summaryRun({progress,...run},withProgress){
  const view=Object.fromEntries(Object.entries(publicRun(run)).filter(([key])=>summaryKeys.has(key)));
  if(withProgress&&progress)view.progress=structuredClone({...progress,cases:progress.cases.map(({actions,...item})=>item)});
  return view;
}
const defaults={targetUrl:'',scope:'',requirements:'',maxSteps:60,journeyTimeoutSeconds:900,externalOrigins:[],authEndpoints:[]};
const active=run=>['queued','running'].includes(run.status);
// Playwright names each tab's recording; a stage keeps the recordings of its latest runs.
const VIDEO_RUNS_PER_STAGE=5,videoName=/^page@[a-f0-9]{32}\.webm$/,runFolder=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeText=(value,limit)=>value?browserError(String(value),process.env,limit):'';
const touch=run=>{run.progress.revision=(run.progress.revision||0)+1;};
const settleSteps=(progress,status)=>{for(const step of progress.steps||[])if(step.status==='running')step.status=['skipped','cancelled'].includes(status)?status:'unconfirmed';};
const actionErrorCodes=new Set(['action_not_allowed','navigation_not_allowed','attachments_not_allowed','credential_literal_rejected','credential_reference_invalid','credential_origin_mismatch','credential_field_unavailable','credential_target_mismatch','credential_frame_mismatch','credential_field_type_mismatch','credential_verification_failed','browser_action_failed','action_result_missing','journey_progress_invalid','payment_live_mode_rejected']);
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const webFrontend=/^(?:next(?:\.js)?|vite|nuxt|react|sveltekit|astro|remix)$/i;
const originOf=value=>{try{return new URL(value).origin;}catch{return null;}};
// An environment's browser-reachable apps; a twin names each after its repository service id.
const applications=environment=>(environment?.apps??[]).filter(app=>typeof app?.url==='string'&&originOf(app.url));
/** The target an environment implies: its one web-frontend app, else its only app; null when ambiguous. */
function applicationUrl(environment,scan){
  const apps=applications(environment);
  const frontends=apps.filter(app=>(scan.services||[]).some(service=>appId(service.id)===appId(app.id)&&webFrontend.test(service.framework||'')));
  return frontends.length===1?frontends[0].url:apps.length===1?apps[0].url:null;
}
// Twin services left out for missing test inputs. Nothing substitutes for them, so a journey that needs one is blocked.
const unavailableServices=environment=>(environment?.services??[]).filter(service=>service?.status==='blocked'&&typeof service.id==='string')
  .map(({id,missing})=>({id,title:Object.hasOwn(twinServices,id)?twinServices[id].title:id,missing:(Array.isArray(missing)?missing:[]).filter(name=>typeof name==='string'&&name.trim()).slice(0,20)}));

function externalOrigins(value,context){
  if(!Array.isArray(value)||value.length>10)throw new Error('Add at most 10 external origins.');
  return [...new Set(value.map(item=>{
    let url=null;try{url=new URL(item);validateBrowserTarget(item,context);}catch{url=null;}
    if(typeof item!=='string'||!url||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||/[?#]/.test(item))throw new Error('External origins must be HTTPS origins without credentials, paths or queries.');
    return url.origin;
  }))];
}
function authEndpoints(value,targetUrl){
  if(!Array.isArray(value)||value.length>3)throw new Error('Add at most 3 auth endpoints.');
  return [...new Set(value.map(item=>{
    let url=null;try{url=new URL(item);}catch{url=null;}
    if(typeof item!=='string'||item.length>2048||!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||/[?#]/.test(item))throw new Error('Auth endpoints must be absolute URLs without credentials or queries.');
    // A bare origin would admit every POST on that port; the runner rejects it too.
    if(url.pathname==='/')throw new Error('Auth endpoints need a path such as /auth/v1/token.');
    if(targetUrl&&url.hostname!==new URL(targetUrl).hostname)throw new Error('Auth endpoints must be on the application host.');
    return url.href;
  }))];
}
function normalizedConfig(input,context){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Provide browser test settings.');
  for(const [key,limit] of [['scope',4000],['requirements',12000]])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>limit))throw new Error(`${key} exceeds its allowed size.`);
  const maxSteps=input.maxSteps??defaults.maxSteps;if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>100)throw new Error('Choose 1–100 browser actions per case.');
  const journeyTimeoutSeconds=input.journeyTimeoutSeconds??defaults.journeyTimeoutSeconds;if(!Number.isInteger(journeyTimeoutSeconds)||journeyTimeoutSeconds<60||journeyTimeoutSeconds>1800)throw new Error('Choose a journey time limit of 60–1800 seconds.');
  const targetUrl=input.targetUrl?validateBrowserTarget(input.targetUrl,context):'';
  return {targetUrl,scope:input.scope||'',requirements:input.requirements||'',maxSteps,journeyTimeoutSeconds,externalOrigins:externalOrigins(input.externalOrigins??[],context),authEndpoints:authEndpoints(input.authEndpoints??[],targetUrl)};
}

// Mirrors the runner: evaluated checks accompany completed or failed milestones only,
// and a milestone fails only from an independent check. Definitions come from the approved snapshot.
function milestoneChecks(definitions,received,status){
  const invalid=()=>new Error('Browser progress returned invalid milestone checks.');
  const list=received??[];
  if(!Array.isArray(list))throw invalid();
  if(!['completed','failed'].includes(status)||!definitions.length){if(list.length||status==='failed')throw invalid();return null;}
  if(status==='completed'?list.length!==definitions.length:!list.length||list.length>definitions.length)throw invalid();
  const checks=list.map((item,index)=>{
    const definition=definitions[index];
    if(!item||typeof item!=='object'||Array.isArray(item)||item.type!==definition.type||('value' in definition&&item.value!==definition.value)||typeof item.passed!=='boolean'||(item.observed!=null&&!Number.isFinite(item.observed))||(item.error!=null&&typeof item.error!=='string'))throw invalid();
    return {...definition,passed:item.passed,...(item.observed!=null?{observed:item.observed}:{}),...(item.error?{error:safeText(item.error,800)}:{}),provenance:'independent'};
  });
  if(status==='completed'?checks.some(check=>!check.passed):checks.every(check=>check.passed))throw invalid();
  return checks;
}
// Mirrors the runner: it starts the first unfinished milestone running, without evidence, then ends it
// completed, blocked or failed with the agent's evidence. All three are terminal.
function acceptMilestone(progress,event,approved,engine){
  const step=progress.steps?.find(item=>item.id===event.stepId);
  if(!step||!['running','completed','blocked','failed'].includes(event.status))throw new Error('Browser progress referenced an invalid journey step.');
  const start=event.status==='running',evidence=event.evidence;
  if(start?evidence!==undefined:typeof evidence!=='string'||!evidence.trim()||evidence.length>2000||controls.test(evidence))throw new Error('Milestones start without evidence and end with 1–2000 characters of observed evidence.');
  if(step.status!==(start?'pending':'running')||start&&step!==progress.steps.find(item=>item.status!=='completed'))throw new Error('Browser milestones must follow the reviewed journey order.');
  const checks=milestoneChecks(approved?.steps?.find(item=>item.id===step.id)?.checks||[],event.checks,event.status);
  Object.assign(step,{status:event.status,...(start?{}:{evidence:safeText(evidence,2000),provenance:engine==='playwright'?'playwright':'agent'})});
  if(checks)step.checks=checks;
}

// twinAccount(environment, accountId) reads a test account's credentials from the environment's twin, named by its id.
// generation holds generateJourneySpec options, such as a harness in place of OpenCode.
export async function createBrowserManager({dataDir,runtime,playwright=createPlaywrightRuntime(),generation={},usage=createEnvironmentUsage(),resolveEnvironment=()=>null,onEnvironmentUncertain=async()=>{},twinAccount=(environment,accountId)=>createTwinRuntime().account({dataDir,id:environment.id,accountId})}={}){
  const configured=resolve(dataDir,'browser');await mkdir(configured,{recursive:true,mode:0o700});
  if((await lstat(configured)).isSymbolicLink())throw new Error('Browser storage must not be a symbolic link.');
  const root=await realpath(configured);await chmod(root,0o700);const file=join(root,'state.json');
  // <runId>/page@<hex>.webm; each journey's worker names its own files in its video event.
  const videoRoot=join(root,'videos');await mkdir(videoRoot,{recursive:true,mode:0o700});
  // Pruning deletes inside this folder, so it must be the controller's own.
  const videoInfo=await lstat(videoRoot);if(videoInfo.isSymbolicLink()||!videoInfo.isDirectory())throw new Error('Browser recording storage must not be a symbolic link.');
  // <uuid>/ per code generation, removed when it ends; none survives a restart.
  const generationRoot=join(root,'generations');await mkdir(generationRoot,{recursive:true,mode:0o700});
  const generationInfo=await lstat(generationRoot);if(generationInfo.isSymbolicLink()||!generationInfo.isDirectory())throw new Error('Code generation storage must not be a symbolic link.');
  await Promise.all((await readdir(generationRoot)).filter(name=>runFolder.test(name)).map(name=>rm(join(generationRoot,name),{recursive:true,force:true})));
  const modelSettings=await createBrowserModelSettings({dataDir});
  const modelCatalog=createOpenRouterModelCatalog();
  runtime ||= createBrowserRuntime({model:()=>modelSettings.configuration()});
  let state={version:1,configs:{},cases:{},analyses:{},runs:[],preparations:{},preparationAttempts:{},configTargets:{},specs:{}};
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw new Error('Invalid browser state.');state=JSON.parse(await readFile(file,'utf8'));if(state.version!==1||!Array.isArray(state.runs)||!state.configs||!state.cases||!state.analyses)throw new Error('Unsupported browser state.');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const key of ['preparations','preparationAttempts','configTargets','specs']){state[key]??={};if(typeof state[key]!=='object'||Array.isArray(state[key]))throw new Error('Unsupported browser preparation state.');}
  // Add current draft defaults without rewriting immutable historical approvals.
  for(const [scope,cases] of Object.entries(state.cases))state.cases[scope]=validateBrowserCases(cases,{draft:true});
  let saving=Promise.resolve(),closed=false,modelSaving=false,closing;const jobs=new Map(),inputJobs=new Map(),busy=new Set(),frames=new Map(),admissions=new Set();
  // One code generation per case: `${scope}\0${caseId}` → {scope,status,step,error,cancel}; kept in memory only.
  const generations=new Map(),generationJobs=new Set(),generationKey=(scope,caseId)=>`${scope}\0${caseId}`;
  const generating=scope=>[...generations.values()].some(entry=>entry.status==='running'&&(scope===undefined||entry.scope===scope));
  function admit(work){
    if(closed)return Promise.reject(conflict('The controller is shutting down.'));
    let promise;try{promise=Promise.resolve(work());}catch(error){return Promise.reject(error);}admissions.add(promise);
    promise.finally(()=>admissions.delete(promise)).catch(()=>{});return promise;
  }
  // Recordings of each stage's latest runs are kept; a run's recordings go with it.
  async function pruneVideos(){
    const kept=new Set(),count=new Map();
    for(const run of state.runs){
      if(active(run)){kept.add(run.id);continue;}
      if(run.mode!=='run')continue;
      const n=count.get(run.scope)||0;
      if(n<VIDEO_RUNS_PER_STAGE){kept.add(run.id);count.set(run.scope,n+1);}
      else for(const item of run.progress?.cases||[])delete item.videos;
    }
    // Only run folders are removed; anything else placed here is left alone.
    const names=(await readdir(videoRoot).catch(()=>[])).filter(name=>runFolder.test(name)&&!kept.has(name));
    await Promise.all(names.map(name=>{const path=join(videoRoot,name);return lstat(path).then(info=>info.isDirectory()&&rm(path,{recursive:true,force:true})).catch(()=>{});}));
  }
  function persist(project=()=>state,commit=()=>{}){const operation=saving.then(async()=>{const content=JSON.stringify(project());if(Buffer.byteLength(content)>16*1024*1024)throw new Error('Browser metadata storage is full.');const temporary=join(root,`.state-${randomUUID()}.tmp`);await writeFile(temporary,content,{mode:0o600});await rename(temporary,file);commit();});saving=operation.catch(()=>{});return operation;}
  // Journeys that never started are cancelled, not failed; interrupted milestones stay unconfirmed.
  const interrupted={pending:'cancelled',queued:'cancelled',running:'failed',skipping:'skipped',cancelling:'cancelled'};
  for(const run of state.runs)if(active(run)){
    Object.assign(run,{status:'failed',error:'The controller stopped during this operation.',completedAt:now(),...(run.environmentId?{environmentUseUncertain:true}:{})});
    for(const item of run.progress?.cases||[])if(interrupted[item.status]){
      const status=interrupted[item.status],unstarted=status==='cancelled'&&['pending','queued'].includes(item.status);
      Object.assign(item,{status,completedAt:run.completedAt});settleSteps(item,status);
      if(run.mode!=='run'||(run.results||[]).some(result=>result.caseId===item.id))continue;
      // An interrupted journey ended on the controller's exception; cancelled and skipped journeys have no verdict.
      const result=status==='failed'?journeyResult(run.approvedCases.find(value=>value.id===item.id),{caseId:item.id,stopCause:'exception',error:'The controller stopped during this journey.'},item.steps,{engine:run.engine}):{caseId:item.id,status,agentCompleted:false,outcomes:[],assertions:[],...(unstarted?{error:'Controller stopped before this journey started'}:{})};
      run.results=[...(run.results||[]),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
    }
    if(run.progress)touch(run);
  }
  for(const preparation of Object.values(state.preparations))if(['preparing','discovering'].includes(preparation.status))Object.assign(preparation,{status:'failed',error:'The controller stopped while preparing integration tests. Discover cases to try again.',completedAt:now()});
  // Also removes folders left by a crash or by runs past the history limit.
  await pruneVideos();
  await persist();
  // The latest Playwright run of a case, when it ran exactly this spec for the reviewed contract it was written for, and passed.
  function passingRun(scope,caseId,spec){
    const run=state.runs.find(item=>item.scope===scope&&item.mode==='run'&&item.engine==='playwright'&&item.caseIds.includes(caseId)),snapshot=run?.approvedCases?.find(item=>item.id===caseId);
    return run&&!active(run)&&run.specHashes?.[caseId]===spec.hash&&snapshot&&caseHash(snapshot)===spec.caseHash&&run.results?.find(result=>result.caseId===caseId)?.status==='passed'?run:null;
  }
  // A case's journey spec; only an approval of the case's current reviewed contract is current. Specs go with their case.
  // verified: its latest Playwright run passed with exactly this code. generation: code being generated, or why it failed.
  function specView(scope){
    const specs=state.specs[scope]||{};
    return Object.fromEntries((state.cases[scope]||[]).filter(item=>specs[item.id]||generations.has(generationKey(scope,item.id))).map(item=>{
      const spec=specs[item.id],generation=generations.get(generationKey(scope,item.id));
      return [item.id,{
        ...(spec?{hash:spec.hash,approved:!!spec.approvedAt,stale:spec.caseHash!==caseHash(item),...(passingRun(scope,item.id,spec)?{verified:true}:{}),...(spec.provenance?{provenance:structuredClone(spec.provenance)}:{})}:{}),
        ...(generation?{generation:{status:generation.status,...(generation.step?{step:generation.step}:{}),...(generation.error?{error:generation.error}:{}),...(generation.rejected?{rejected:generation.rejected}:{})}}:{}),
      }];
    }));
  }
  const keptSpecs=(scope,cases)=>Object.fromEntries(Object.entries(state.specs[scope]||{}).filter(([id])=>cases.some(item=>item.id===id)));
  // A case deleted while it is saved keeps no spec.
  function storeSpec(scope,caseId,spec){
    const specs=()=>(state.cases[scope]||[]).some(value=>value.id===caseId)?{...state.specs[scope],[caseId]:spec}:{...state.specs[scope]};
    return persist(()=>({...state,specs:{...state.specs,[scope]:specs()}}),()=>{state.specs[scope]=specs();});
  }
  function writeSpec(context,caseId,next){return admit(async()=>{
    requireIdle(context,{duringRun:true});
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is being generated. Stop it first.');
    const spec=next(item,state.specs[scope]?.[item.id]);
    await storeSpec(scope,item.id,spec);
    if(generations.get(key)?.status==='failed')generations.delete(key);
    return {spec:{caseId:item.id,...specView(scope)[item.id]},specs:specView(scope)};
  });}
  // Generates a reviewed case's spec with Playwright's generator agent against the stage's ready twin; the code is a
  // draft until a person approves it after a passing run. Only this request starts it: never a view, a restart or a gate.
  async function generateSpec(context,caseId){
    requireIdle(context,{duringRun:true});
    const scope=scopeId(context),item=(state.cases[scope]||[]).find(value=>value.id===caseId);
    if(!item)throw Object.assign(new Error('Test not found in this stage.'),{statusCode:404});
    if(item.needsReview)throw new Error('Review this test before generating its code.');
    const key=generationKey(scope,item.id);
    if(generations.get(key)?.status==='running')throw conflict('Code for this test is already being generated.');
    const [snapshot]=validateBrowserCases([item],{draft:false});
    if(!snapshot.steps.length)throw new Error('Add journey steps before generating code.');
    const configuration=modelSettings.configuration();
    if(!configuration.modelConfigured||!isOpenRouterEndpoint(configuration.baseUrl))throw new Error('Add your OpenRouter API key in Settings first.');
    const config=normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
    const environment=resolveEnvironment(config.targetUrl);
    if(environment?.status!=='ready'||(environment.stageId&&environment.stageId!==context.stageId))throw conflict('Set the application URL to this stage’s ready twin first.');
    if(state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
    // The generator drives the twin as a journey does, so it holds the environment like a run.
    const release=usage.acquire(context,{environmentId:environment.id,operation:'generate journey code'});
    const entry={scope,status:'running',step:'preparing',cancelled:false,cancel(){entry.cancelled=true;}};
    generations.set(key,entry);
    let credentials;
    try{
      if(!(await playwright.capabilities()).browserInstalled)throw new Error('Install Chromium for Playwright: npx playwright install chromium.');
      // The twin's first test account, as a run uses by default; its password reaches only the harness environment.
      const accounts=environment.accounts||[];
      if(accounts.length){
        const account=await twinAccount(environment,accounts[0].id);
        credentials=account?validateRunCredentials({username:account.username,password:account.password}):undefined;
        if(!credentials)throw new Error('The environment test account is unavailable. Recreate the environment.');
      }
      if(closed||entry.cancelled)throw conflict('Code generation cancelled.');
    }catch(error){generations.delete(key);release();throw error;}
    const origins=[new URL(config.targetUrl).origin,...applications(environment).map(app=>originOf(app.url)),...config.externalOrigins];
    const promise=(async()=>{
      const workspace=join(generationRoot,randomUUID());
      try{
        await mkdir(workspace,{mode:0o700});
        const job=generateJourneySpec({...generation,workspace,item:snapshot,targetUrl:config.targetUrl,allowedOrigins:[...new Set(origins)],timeoutSeconds:config.journeyTimeoutSeconds,credentials,apiKey:configuration.apiKey,model:configuration.model,onStep:step=>{if(!entry.cancelled)entry.step=step;}});
        entry.cancel=()=>{entry.cancelled=true;entry.step='cancelling';job.cancel();};
        if(entry.cancelled)job.cancel();
        const {code,provenance}=await job.promise;
        if(entry.cancelled)throw new Error(CANCELLED);
        entry.step='saving';
        await storeSpec(scope,item.id,{code,hash:specHash(code),caseHash:caseHash(snapshot),savedAt:now(),approvedAt:null,provenance});
        generations.delete(key);
      }catch(error){
        // A cancelled generation leaves no state; a failed one says why until the next attempt.
        if(entry.cancelled)generations.delete(key);
        else{Object.assign(entry,{status:'failed',error:browserError(error),...(typeof error?.rejected==='string'?{rejected:error.rejected}:{})});delete entry.step;}
        if(error?.cleanupIncomplete)await onEnvironmentUncertain(environment.id,browserError(error)).catch(()=>{});
      }finally{
        await rm(workspace,{recursive:true,force:true}).catch(()=>{});
        release();
      }
    })();
    generationJobs.add(promise);promise.finally(()=>generationJobs.delete(promise));
    return {specs:specView(scope)};
  }
  function cancelGeneration(context,caseId){
    const scope=scopeId(context),entry=generations.get(generationKey(scope,caseId));
    if(entry?.status!=='running')throw Object.assign(new Error('No code is being generated for this test.'),{statusCode:404});
    entry.cancel();
    return {specs:specView(scope)};
  }
  function find(context,id){const run=state.runs.find(r=>r.id===id&&r.scope===scopeId(context));if(!run)throw Object.assign(new Error('Browser run not found in this stage.'),{statusCode:404});return run;}
  // A test run executes an immutable case snapshot, so case writes may overlap it; discovery may not.
  function requireIdle(context,{duringRun=false}={}){if(closed)throw conflict('The controller is shutting down.');usage.assertAvailable(context);if(modelSaving)throw conflict('Model settings are being saved. Please wait.');const scope=scopeId(context);if(busy.has(scope)||state.runs.some(r=>r.scope===scope&&active(r)&&!(duringRun&&r.mode==='run')))throw conflict('A browser operation is already in progress for this stage.');}
  async function viewModel(){return {capabilities:{...modelSettings.view(),...await runtime.capabilities()}};}
  async function listModels(){const current=modelSettings.configuration();return modelCatalog.view(isOpenRouterEndpoint(current.baseUrl)&&current.modelConfigured?current.model:undefined);}
  async function updateModel(save){
    if(closed)throw conflict('The controller is shutting down.');
    if(modelSaving||busy.size||jobs.size||generating()||state.runs.some(active)||Object.values(state.preparations).some(preparation=>['preparing','discovering'].includes(preparation.status)))throw conflict('Wait for browser operations to finish before changing the model.');
    modelSaving=true;
    try{await save();return await viewModel();}finally{modelSaving=false;}
  }
  async function saveModelSettings(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['model','apiKey'].includes(key)))throw new Error('Provide an OpenRouter model and API key.');
    if(typeof input.model!=='string'||!input.model.trim())throw new Error('Choose an OpenRouter model.');
    return updateModel(async()=>{
      const {models}=await listModels();
      if(!models.some(model=>model.id===input.model))throw new Error('Choose an available OpenRouter model from the list.');
      await modelSettings.saveOpenRouter(input);
    });
  }
  function withInput(context,work,{signal,isCurrent=()=>true}={}){
    requireIdle(context,{duringRun:true});const scope=scopeId(context),controller=new AbortController();
    const operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const assertCurrent=()=>{
      if(closed||operationSignal.aborted)throw conflict('Operation cancelled.');
      if(!isCurrent())throw conflict('The active source changed. Reopen this stage.');
    };
    const release=usage.acquire(context,{operation:'test input'});
    busy.add(scope);
    const promise=Promise.resolve().then(async()=>{
      assertCurrent();
      const configuration=modelSettings.configuration();
      if(!configuration.modelConfigured||!isOpenRouterEndpoint(configuration.baseUrl))throw new Error('Add your OpenRouter API key in Settings first.');
      return work({scope,configuration,signal:operationSignal,assertCurrent});
    }).finally(()=>{busy.delete(scope);inputJobs.delete(controller);release();});
    inputJobs.set(controller,promise);
    return promise;
  }
  function draft(context,description,options){
    const normalized=validateTestDescription(description);
    return withInput(context,async({scope,configuration,signal,assertCurrent})=>{
      if((state.cases[scope]||[]).length>=60)throw new Error('Delete a test before adding another. This stage supports 60 tests.');
      const sourceContext=await browserDiscoveryContext({repoPath:context.scan.repo.path,scope:normalized.slice(0,4000),requirements:normalized});
      assertCurrent();
      const item=await draftBrowserCase({configuration,description:normalized,sourceContext,signal});
      assertCurrent();
      const previous=state.cases[scope];
      state.cases[scope]=[...(previous||[]),item];
      try{await persist();}catch(error){state.cases[scope]=previous;throw error;}
      return {case:structuredClone(item),cases:structuredClone(state.cases[scope])};
    },options);
  }
  function transcribe(context,input,options){
    return withInput(context,async({configuration,signal,assertCurrent})=>{
      const result=await transcribeBrowserAudio({configuration,audio:input.audio,format:input.format,signal});
      assertCurrent();return result;
    },options);
  }
  const report=run=>({run:publicRun(run),results:run.results||[],progress:run.progress||{cases:[]},...(run.discovery?{discovery:run.discovery}:{})});
  function acceptFrame(run,event,progress){
    if(typeof event.data!=='string'||event.data.length>2800000||!(/^[a-zA-Z0-9+/]+={0,2}$/.test(event.data)))throw new Error('Browser runtime returned an invalid frame.');
    const bytes=Buffer.from(event.data,'base64');if(bytes.length>2*1024*1024||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)throw new Error('Browser runtime returned an invalid JPEG frame.');
    // The worker's capture time is kept apart from the controller's receipt time.
    const captured=event.timestamp;
    if(captured!==undefined&&(!Number.isSafeInteger(captured)||captured<Date.parse(run.createdAt)-60000||captured>Date.now()+60000))throw new Error('Browser runtime returned an invalid frame timestamp.');
    let stored=frames.get(run.id);if(!stored){stored={latest:null,cases:new Map()};frames.set(run.id,stored);}
    stored.latest=bytes;run.frameUpdatedAt=now();if(captured!==undefined)run.frameCapturedAt=new Date(captured).toISOString();
    stored.cases.set(progress.id,bytes);progress.frameUpdatedAt=run.frameUpdatedAt;if(captured!==undefined)progress.frameCapturedAt=run.frameCapturedAt;
    for(const id of [...frames.keys()].slice(0,-5))if(!jobs.has(id))frames.delete(id);
  }
  async function startWork(context,mode,input={},options={}){
    // Run-only account values: never persisted; discovery may use them to see authenticated pages.
    // Without entered values, the target twin's test account (accountId, else its first) signs in; accountId null uses none.
    let credentials=validateRunCredentials(input.credentials);
    const accountId=input.accountId;
    if(accountId!==undefined&&(credentials||(accountId!==null&&typeof accountId!=='string')))throw new Error('Choose one test account.');
    const concurrency=input.concurrency??2,engine=input.engine??'browser-use';
    if(mode==='run'&&(!Number.isInteger(concurrency)||concurrency<1||concurrency>4))throw new Error('Choose 1–4 concurrent journeys.');
    if(mode==='run'&&!['browser-use','playwright'].includes(engine))throw new Error('Choose the Browser Use or Playwright engine.');
    const coded=mode==='run'&&engine==='playwright';
    requireIdle(context);const scope=scopeId(context);busy.add(scope);
    let release,handedOff=false;
    let replaceIds=[];
    try{
      if(mode==='discover'&&input.replaceCaseIds!==undefined){
        const current=state.cases[scope]||[];
        if(!Array.isArray(input.replaceCaseIds)||input.replaceCaseIds.length>60||new Set(input.replaceCaseIds).size!==input.replaceCaseIds.length||input.replaceCaseIds.some(id=>!current.some(item=>item.id===id)))throw new Error('Choose existing tests to replace.');
        if(!Array.isArray(input.baseCases)||!isDeepStrictEqual(validateBrowserCases(input.baseCases,{draft:true}),validateBrowserCases(current,{draft:true})))throw conflict('Tests changed. Reopen Generate and try again.');
        replaceIds=input.replaceCaseIds;
      }
      const config=normalizedConfig(state.configs[scope]||defaults,context);if(!config.targetUrl)throw new Error('Set the application URL first.');
      const environment=resolveEnvironment(config.targetUrl);
      if(environment&&environment.status!=='ready')throw conflict('The selected application environment is not ready. Choose an available application URL.');
      if(environment&&state.runs.some(run=>run.environmentId===environment.id&&run.environmentUseUncertain))throw conflict('The selected application environment requires cleanup before it can be used again.');
      release=usage.acquire(context,{environmentId:environment?.id,operation:`browser ${mode}`});
      // An approved spec runs without a model.
      if(coded){if(!(await playwright.capabilities()).browserInstalled)throw new Error('Install Chromium for Playwright: npx playwright install chromium.');}
      else{const capabilities=await runtime.capabilities();if(!capabilities.runtimeInstalled)throw new Error('Install the local Browser Use runtime first.');if(capabilities.browserInstalled===false)throw new Error('Install Chromium for the local browser runtime.');if(!capabilities.modelConfigured)throw new Error(capabilities.modelError||'Configure a model API key to use the browser agent.');}
      const accounts=environment?.accounts||[];let accountEndpoints=[];
      if(typeof accountId==='string'&&!accounts.some(account=>account.id===accountId))throw new Error('Choose a test account of this environment.');
      if(!credentials&&accountId!==null&&accounts.length){
        // The password is read from the twin's private state here and never reaches a view.
        const account=await twinAccount(environment,accountId??accounts[0].id);
        credentials=account?validateRunCredentials({username:account.username,password:account.password}):undefined;
        if(!credentials)throw new Error('The environment test account is unavailable. Recreate the environment.');
        // The twin says where its sign-in posts, so read-only discovery can let exactly that request through.
        accountEndpoints=account.authEndpoints||[];
      }
      let cases=[];
      if(mode==='run'){
        const available=state.cases[scope]||[],ids=input.caseIds??available.filter(c=>c.selected&&!c.needsReview).map(c=>c.id);
        if(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length)throw new Error('Choose 1–30 distinct reviewed cases.');
        cases=ids.map(id=>{const item=available.find(c=>c.id===id);if(!item||item.needsReview||!item.selected)throw new Error('Review and select each case before running.');return item;});
        cases=validateBrowserCases(cases,{draft:false});
      }
      // Each journey runs the spec approved for exactly its reviewed case; the code stays in memory for this run. A
      // person's manual run may also try a current draft, which is how a draft earns its approval; a gate never does.
      const specs=coded?Object.fromEntries(cases.map(item=>{
        const spec=state.specs[scope]?.[item.id];
        if(!spec||spec.caseHash!==caseHash(item)||(!spec.approvedAt&&!options.manual))throw new Error(options.manual?`Generate current Playwright code for “${item.name}” first.`:`Approve a current Playwright spec for “${item.name}” first.`);
        // An approval kept from an older grammar never runs code the current one rejects.
        try{validateJourneySpec(spec.code,item);}catch(error){throw new Error(`Save the Playwright spec for “${item.name}” again: ${error.message}`);}
        return [item.id,{code:spec.code,hash:spec.hash}];
      })):null;
      const sourceContext=mode==='discover'?await browserDiscoveryContext({repoPath:context.scan.repo.path,scope:config.scope,requirements:config.requirements}):'';
      if(closed)throw conflict('The controller is shutting down.');
      if(options.isCurrent&&!options.isCurrent())throw conflict('The active source changed. Open this source and discover cases to continue.');
      const progressCases=mode==='discover'?[{id:'discovery',caseId:'discovery',name:'Explore application',status:'pending',actions:[],actionCount:0}]:cases.map(c=>({id:c.id,caseId:c.id,name:c.name,status:'queued',actions:[],actionCount:0,steps:c.steps.map(({id,title})=>({id,title,status:'pending'}))}));
      const run={id:randomUUID(),scope,stageId:context.stageId,mode,status:'queued',createdAt:now(),targetUrl:config.targetUrl,sourceRevision:context.scan.repo.sha||null,caseIds:cases.map(c=>c.id),approvedCases:structuredClone(cases),progress:{revision:0,cases:progressCases},...(mode==='run'?{engine,concurrency,...journeyConcurrency({cases,concurrency,account:!!credentials})}:{}),...(specs?{specHashes:Object.fromEntries(Object.entries(specs).map(([id,spec])=>[id,spec.hash]))}:{})};
      if(environment)run.environmentId=environment.id;
      const preparation=mode==='discover'?(options.preparation||state.preparations[scope]):null;
      if(preparation){Object.assign(preparation,{status:'discovering',targetUrl:config.targetUrl,runId:run.id});delete preparation.error;delete preparation.completedAt;}
      const admittedRuns=()=>[run,...state.runs].filter((item,index)=>index<50||active(item));
      await persist(()=>({...state,runs:admittedRuns()}),()=>{state.runs=admittedRuns();});
      if(closed){run.status='cancelled';run.completedAt=now();await persist();throw conflict('The controller is shutting down.');}
      const execution=async()=>{
        let discovery=null,omittedCount=0,progressPersistence=Promise.resolve(),progressError;
        const entry=jobs.get(run.id);
        // Runs may reach reviewed external origins (such as Stripe test checkout); discovery stays on
        // the target environment's apps and receives auth endpoints only with a supplied test account.
        // Scope focuses discovery only; unavailable twin services become blockers in runs.
        const origins=[new URL(config.targetUrl).origin,...applications(environment).map(app=>originOf(app.url))],unavailable=unavailableServices(environment);
        const workerInput={mode,targetUrl:config.targetUrl,allowedOrigins:[...new Set(mode==='run'?[...origins,...config.externalOrigins]:origins)],...(mode==='discover'?{scope:config.scope}:{}),requirements:config.requirements,sourceContext,maxSteps:config.maxSteps,timeoutSeconds:config.journeyTimeoutSeconds,...(credentials?{credentials}:{}),...(mode==='discover'&&credentials&&(config.authEndpoints.length||accountEndpoints.length)?{authEndpoints:authEndpoints([...new Set([...config.authEndpoints,...accountEndpoints])],config.targetUrl)}:{}),...(mode==='run'&&unavailable.length?{unavailableServices:unavailable}:{})};
        const assertCurrent=()=>{if(options.isCurrent&&!options.isCurrent())throw new Error('The active source changed. Open this source and discover cases to continue.');};
        function progressEvent(event,caseId){
          if(event.caseId!==undefined&&event.caseId!==caseId)throw new Error('Browser progress referenced another journey.');
          const progress=run.progress.cases.find(item=>item.id===caseId);
          if(!progress)throw new Error('Browser progress referenced an unknown case.');
          // A skipped journey keeps its recording; an invalid one is ignored, never a journey failure.
          if(event.type==='video'){
            if(mode==='run'&&Array.isArray(event.files)&&event.files.length<=20&&event.files.every(name=>typeof name==='string'&&videoName.test(name))){progress.videos=[...new Set(event.files)];touch(run);}
            return;
          }
          if(['skipping','cancelling','skipped','cancelled'].includes(progress.status))return;
          if(event.type==='frame'){acceptFrame(run,event,progress);touch(run);return;}
          if(event.type==='case'){
            if(mode==='discover')progress.status='running';
            if(Array.isArray(event.actions)){
              progress.actions=event.actions.slice(-150).map(a=>({type:/^[a-z][a-z0-9_-]{0,40}$/i.test(a?.type)?a.type:'browser',status:['pending','running','passed','failed','cancelled'].includes(a?.status)?a.status:'running',...(a?.status==='failed'&&actionErrorCodes.has(a.errorCode)?{errorCode:a.errorCode}:{})}));
              progress.actionCount=event.actions.length;
              const last=progress.actions.at(-1);if(last)progress.lastAction={type:last.type,status:last.status};else delete progress.lastAction;
            }
          }else if(event.type==='journey-step')acceptMilestone(progress,event,run.approvedCases.find(item=>item.id===caseId),run.engine);
          else return;
          touch(run);
        }
        try{
          run.status='running';run.startedAt=now();await persist();
          if(closed||entry?.cancelled)throw new Error('Browser operation cancelled.');
          assertCurrent();
          if(mode==='run'){
            // One supplied account shares application state even across fresh profiles.
            const scheduledCases=credentials?cases.map(item=>({...item,isolation:'shared'})):cases;
            // Without its folder the run is only unrecorded.
            const videoDir=await mkdir(join(videoRoot,run.id),{recursive:true,mode:0o700}).then(()=>join(videoRoot,run.id),()=>null);
            const scheduler=createJourneyScheduler({cases:scheduledCases,concurrency,
              onState(caseId,status,item){
                const progress=run.progress.cases.find(item=>item.id===caseId);progress.status=status;
                // A supplied account is scheduled as shared data; report the account as the wait.
                if(status==='queued')progress.queueReason=credentials&&item.queueReason==='shared-data'?'account':item.queueReason||'browser';else delete progress.queueReason;
                if(status==='running')progress.startedAt=now();
                if(!['queued','running','skipping','cancelling'].includes(status)){
                  progress.completedAt=now();
                  // A worker error is the journey's exception; skipped and cancelled journeys have no verdict.
                  const result=item.result||(status==='failed'?journeyResult(item.item,{caseId,stopCause:'exception',error:browserError(item.error?.message||String(item.error))},progress.steps,{engine}):{caseId,status,agentCompleted:false,outcomes:[],assertions:[]});
                  run.results=[...(run.results||[]).filter(previous=>previous.caseId!==caseId),result].sort((a,b)=>run.caseIds.indexOf(a.caseId)-run.caseIds.indexOf(b.caseId));
                  // An unreported milestone is unconfirmed, never a blocked prerequisite.
                  settleSteps(progress,status);
                  // Completed journeys survive a later worker/controller interruption.
                  progressPersistence=progressPersistence.then(()=>persist()).catch(error=>{progressError||=error;entry.cancel();});
                }
                touch(run);
              },
              launch(item){
                let facts=null;
                assertCurrent();
                const steps=()=>run.progress.cases.find(progress=>progress.id===item.id).steps;
                const onEvent=event=>{
                  if(event.type==='result'){
                    if(facts)throw new Error('Browser runtime returned duplicate results.');
                    facts=event.result;
                  }else if(event.type==='discovery')throw new Error('Browser runtime returned unexpected discovery.');
                  else progressEvent(event,item.id);
                };
                // A spec that signs in cannot run without an account. A missing service may not be needed:
                // the spec runs, and only a journey that does not pass is blocked on it, since without an
                // agent nothing tells whether the missing service caused its failure.
                if(coded&&!credentials&&signsIn(specs[item.id].code))return {cancel:()=>{},promise:Promise.resolve().then(()=>journeyResult(item,{caseId:item.id,stopCause:'none',assertions:[],blockers:[{kind:'account',evidence:'The spec signs in, and no test account is available.'}]},steps(),{engine}))};
                const judged=result=>coded&&unavailable.length&&result.status!=='passed'?{...result,status:'blocked',
                  blockers:[...unavailable.map(({title,missing})=>({kind:'integration',evidence:`${title} is unavailable${missing.length?`: missing ${missing.join(', ')}`:''}.`})),...(result.blockers||[])].slice(0,10),
                  error:`Blocked: ${unavailable.map(({title})=>title).join(', ')} unavailable.${result.error?` ${result.error}`:''}`}:result;
                // Each milestone's done does not spend the journey's business action budget.
                const job=coded?playwright.start({...workerInput,case:item,spec:specs[item.id],...(videoDir?{videoDir}:{})},onEvent)
                  :runtime.start({...workerInput,maxSteps:Math.min(112,config.maxSteps+item.steps.length),case:item,...(videoDir?{videoDir}:{})},onEvent);
                return {cancel:()=>job.cancel(),promise:job.promise.then(()=>{
                  assertCurrent();if(!facts)throw new Error('Browser runtime did not return results.');
                  return judged(journeyResult(item,facts,steps(),{engine}));
                },error=>{
                  // The kill timer is the journey's deadline too; facts the runner reported before it still count.
                  if(!error?.timedOut||error.cleanupIncomplete)throw error;
                  assertCurrent();
                  return judged(journeyResult(item,facts||{caseId:item.id,stopCause:'deadline'},steps(),{engine}));
                })};
              },
            });
            entry.scheduler=scheduler;entry.cancel=()=>scheduler.cancel();
            for(const caseId of entry.skips)scheduler.skip(caseId);
            if(entry.cancelled)scheduler.cancel();
            // Every journey's result row is recorded as it settles.
            const finished=await scheduler.promise;
            await progressPersistence;
            if(progressError)throw progressError;
            const uncertain=finished.find(item=>item.error?.cleanupIncomplete);
            if(uncertain)throw uncertain.error;
            const errors=finished.filter(item=>item.error&&item.status==='failed');
            if(errors.length)run.error=browserError(errors[0].error?.message||String(errors[0].error));
            run.status=runStatus(run.results);
          }else{
            const job=runtime.start(workerInput,event=>{
              if(event.type==='discovery'){
                if(discovery)throw new Error('Browser runtime returned unexpected discovery.');
                // A journey the controller cannot accept is named in the summary; the valid ones are kept.
                const {cases:drafts,omitted}=discoveredBrowserCases(event.cases,sourceContext);
                const note=safeText(omitted.map(item=>`Omitted “${item.name}”: ${item.reason}`).join('\n'),2000);
                discovery={cases:drafts,summary:[safeText(event.summary,note?3999-note.length:4000),note].filter(Boolean).join('\n'),authenticated:!!credentials&&event.authenticated===true};omittedCount=omitted.length;
              }else if(event.type==='result')throw new Error('Browser runtime returned unexpected results.');
              else progressEvent(event,'discovery');
            });
            entry.cancel=()=>job.cancel();if(entry.cancelled)job.cancel();
            await job.promise;
            if(entry.cancelled)throw new Error('Browser operation cancelled.');
            assertCurrent();
            if(!discovery)throw new Error('Browser agent did not return business cases.');
            const analysis={...discovery,createdAt:now(),sourceRevision:run.sourceRevision};
            if(!discovery.cases.length&&(replaceIds.length||omittedCount)){
              // The run fails and every test is retained, but the agent's summary and omissions are kept.
              const failed={...analysis,error:'No acceptable journeys were discovered. Existing tests were retained.'};
              run.discovery=discovery;
              await persist(()=>({...state,analyses:{...state.analyses,[scope]:failed}}),()=>{state.analyses[scope]=failed;});
              throw new Error(failed.error);
            }
            const current=state.cases[scope]||[],retained=current.filter(item=>!replaceIds.includes(item.id)),known=new Set(retained.map(item=>item.id));
            const nextCases=[...retained,...discovery.cases.filter(item=>!known.has(item.id))].slice(0,60);
            await persist(()=>({...state,cases:{...state.cases,[scope]:nextCases},specs:{...state.specs,[scope]:keptSpecs(scope,nextCases)},analyses:{...state.analyses,[scope]:analysis}}),()=>{state.specs[scope]=keptSpecs(scope,nextCases);state.cases[scope]=nextCases;state.analyses[scope]=analysis;});
            run.discovery=discovery;run.status='completed';run.progress.cases[0].status='completed';touch(run);
          }
        }catch(error){
          run.status=entry?.cancelled?'cancelled':'failed';run.error=browserError(error?.message||String(error));
          for(const item of run.progress.cases)if(['pending','queued','running','skipping','cancelling'].includes(item.status)){item.status=run.status;settleSteps(item,run.status);}
          touch(run);
          if(error?.cleanupIncomplete===true&&run.environmentId){
            run.status='failed';run.environmentUseUncertain=true;
            try{await persist();}finally{await onEnvironmentUncertain(run.environmentId,run.error);}
          }
        }finally{
          run.completedAt=now();
          if(preparation?.runId===run.id){
            const empty=run.status==='completed'&&!(state.cases[scope]||[]).length;
            Object.assign(preparation,{status:empty?'needs_setup':run.status==='completed'?'completed':'failed',completedAt:run.completedAt,...(empty?{error:'No integration cases were discovered. Set a scope or add a case.'}:run.error?{error:run.error}:{})});
          }
          try{await pruneVideos();}catch{}
          try{await persist();}finally{jobs.delete(run.id);release();}
        }
      };
      const entry={cancelled:false,cancel:()=>{},promise:null,skips:new Set()};jobs.set(run.id,entry);entry.promise=Promise.resolve().then(execution);entry.promise.catch(()=>{});
      handedOff=true;
      return {run:publicRun(run)};
    }finally{busy.delete(scope);if(!handedOff)release?.();}
  }
  function start(...args){
    // startWork runs synchronously to its first await, reserving the target
    // before another manager can admit a mutation of the same environment.
    if(closed)return Promise.reject(conflict('The controller is shutting down.'));
    const promise=startWork(...args);admissions.add(promise);
    promise.finally(()=>admissions.delete(promise)).catch(()=>{});return promise;
  }
  // The target twin's test accounts for the account choice, without passwords.
  function targetAccounts(url){const environment=url?resolveEnvironment(url):null;return environment?.status==='ready'?(environment.accounts||[]).map(({id,label,username})=>({id,label,username})):[];}
  function summary(context){
    const scope=scopeId(context),cases=state.cases[scope]||[],runs=state.runs.filter(r=>r.scope===scope).slice(0,30);
    const latest=new Set(cases.map(item=>runs.find(run=>run.mode==='run'&&run.caseIds.includes(item.id))?.id).filter(Boolean));
    return {cases:structuredClone(cases),specs:specView(scope),runs:runs.map(run=>summaryRun(run,active(run)||latest.has(run.id))),preparation:structuredClone(state.preparations[scope]||null)};
  }
  async function prepareEnvironment(context,environment,{isCurrent=()=>true}={}){
    const scope=scopeId(context),attempt=`${scope}:${environment.id}`;
    if(environment.status!=='ready'||environment.stageId!==context.stageId
      ||(environment.pipelineKey&&environment.pipelineKey!==context.key)||(environment.repoPath&&environment.repoPath!==context.scan.repo.path)
      ||state.preparationAttempts[attempt])return summary(context);
    // Persist the attempt before any runtime/model work. Restart and read-only
    // views never replay this hook, including a previously blocked attempt.
    const release=usage.acquire(context,{operation:'prepare integration cases'});
    const preparation={environmentId:environment.id,status:'preparing',createdAt:now()};
    state.preparationAttempts[attempt]=true;state.preparations[scope]=preparation;
    try{
      await persist();
      requireIdle(context);
      if(!isCurrent())throw conflict('The active source changed. Open this source and discover cases to continue.');
      const config=normalizedConfig(state.configs[scope]||defaults,context);
      const previousTarget=state.configTargets[scope];
      const explicitTarget=config.targetUrl&&(!previousTarget||previousTarget.url!==config.targetUrl);
      if(!explicitTarget){
        const url=applicationUrl(environment,context.scan);
        if(!url){
          if(previousTarget){state.configs[scope]={...config,targetUrl:''};delete state.configTargets[scope];}
          throw new Error('Choose the application URL before discovering integration tests.');
        }
        config.targetUrl=validateBrowserTarget(url,context);
        state.configs[scope]=config;state.configTargets[scope]={environmentId:environment.id,url:config.targetUrl};
      }
      preparation.targetUrl=config.targetUrl;
      // Reusing the stage's cases avoids overwriting reviews or charging for
      // duplicate discovery whenever another application environment is made.
      if((state.cases[scope]||[]).length){preparation.status='completed';preparation.completedAt=now();await persist();return summary(context);}
      await start(context,'discover',{}, {preparation,isCurrent});
    }catch(error){Object.assign(preparation,{status:'needs_setup',error:browserError(error),completedAt:now()});await persist();}
    finally{release();}
    return summary(context);
  }
  return {
    summary,prepareEnvironment:(...args)=>admit(()=>prepareEnvironment(...args)),viewModel,listModels,saveModelSettings:input=>admit(()=>saveModelSettings(input)),
    interruptedEnvironmentIds:()=>[...new Set(state.runs.filter(run=>run.environmentUseUncertain&&run.environmentId).map(run=>run.environmentId))],
    draft:(...args)=>admit(()=>draft(...args)),transcribe:(...args)=>admit(()=>transcribe(...args)),
    hasPendingInput:()=>inputJobs.size>0,
    async view(context){const scope=scopeId(context);return {config:structuredClone({...defaults,...state.configs[scope]}),cases:structuredClone(state.cases[scope]||[]),specs:specView(scope),runs:state.runs.filter(r=>r.scope===scope).slice(0,30).map(publicRun),preparation:structuredClone(state.preparations[scope]||null),analysis:structuredClone(state.analyses[scope]||null),accounts:targetAccounts(state.configs[scope]?.targetUrl),capabilities:{...modelSettings.view(),...await runtime.capabilities()}};},
    saveModel(context,input){return admit(()=>{requireIdle(context);return updateModel(()=>modelSettings.save(input));});},
    async saveConfig(context,config){requireIdle(context);const normalized=normalizedConfig(config,context),scope=scopeId(context);state.configs[scope]=normalized;if(state.configTargets[scope]?.url!==normalized.targetUrl)delete state.configTargets[scope];await persist();return {config:normalized};},
    saveCases(context,cases,baseCases){return admit(async()=>{
      requireIdle(context,{duringRun:true});
      const scope=scopeId(context),normalized=validateBrowserCases(cases,{draft:true});
      if(baseCases!==undefined&&!isDeepStrictEqual(validateBrowserCases(baseCases,{draft:true}),state.cases[scope]||[]))throw conflict('Tests changed. Reopen the test and apply your changes again.');
      assertReviewedJourneys(normalized,state.cases[scope]||[]);
      const release=usage.acquire(context,{operation:'save integration cases'});
      busy.add(scope);
      try{
        // Publish only after durable persistence. Other stages keep their own
        // updates, and failed writes never approve a case in memory.
        await persist(()=>({...state,cases:{...state.cases,[scope]:normalized},specs:{...state.specs,[scope]:keptSpecs(scope,normalized)}}),()=>{state.specs[scope]=keptSpecs(scope,normalized);state.cases[scope]=normalized;});
        // A deleted case's code generation stops with it.
        for(const [key,entry] of generations)if(entry.scope===scope&&!normalized.some(item=>generationKey(scope,item.id)===key)){if(entry.status==='running')entry.cancel();else generations.delete(key);}
        return {cases:structuredClone(normalized)};
      }finally{busy.delete(scope);release();}
    });},
    // A saved spec is a draft; approval binds its exact hash to the case's current reviewed contract.
    saveSpec:(context,input)=>writeSpec(context,input?.caseId,item=>{const code=validateJourneySpec(input.code,item);return {code,hash:specHash(code),caseHash:caseHash(item),savedAt:now(),approvedAt:null};}),
    // Approval also requires that the case's latest Playwright run passed with exactly this code.
    approveSpec:(context,input)=>writeSpec(context,input?.caseId,(item,spec)=>{
      if(!spec)throw Object.assign(new Error('Save a spec for this test first.'),{statusCode:404});
      if(item.needsReview)throw new Error('Review this test before approving its spec.');
      if(typeof input.hash!=='string'||spec.hash!==input.hash)throw conflict('The spec changed. Reload it and approve again.');
      if(spec.caseHash!==caseHash(item))throw conflict('The test changed after this spec was saved. Save the spec again.');
      const run=passingRun(scopeId(context),item.id,spec);
      if(!run)throw conflict('Run this code with Playwright and approve it after it passes.');
      return {...spec,approvedAt:now(),approvedRunId:run.id};
    }),
    generateSpec:(context,input)=>admit(()=>generateSpec(context,input?.caseId)),
    cancelSpecGeneration:async(context,input)=>cancelGeneration(context,input?.caseId),
    // options.manual: a person started the run, so current draft specs may run with Playwright.
    run:(context,input,options)=>start(context,'run',input,options),discover:(context,input)=>start(context,'discover',input),
    async runProgress(context,id){return report(find(context,id));},
    async frame(context,id,caseId){const run=find(context,id);if(caseId!==undefined&&!run.progress?.cases.some(item=>item.id===caseId))throw Object.assign(new Error('Journey not found in this run.'),{statusCode:404});const stored=frames.get(id);return (caseId===undefined?stored?.latest:stored?.cases.get(caseId))||null;},
    // Only a file its journey reported, in this stage's run, is served.
    async video(context,id,caseId,file){
      const run=find(context,id),progress=run.progress?.cases.find(item=>item.id===caseId);
      const notFound=()=>Object.assign(new Error('Recording not found.'),{statusCode:404});
      if(typeof file!=='string'||!progress?.videos?.includes(file))throw notFound();
      const path=join(videoRoot,id,file),info=await lstat(path).catch(()=>null);
      // Under lstat a symbolic link is not a file.
      if(!info?.isFile()||!info.size)throw notFound();
      return {path,size:info.size};
    },
    async skip(context,id,caseId){const run=find(context,id);if(run.mode!=='run'||!run.caseIds.includes(caseId))throw Object.assign(new Error('Journey not found in this run.'),{statusCode:404});const entry=jobs.get(id);if(entry){entry.skips.add(caseId);if(entry.scheduler)entry.scheduler.skip(caseId);else{const item=run.progress.cases.find(item=>item.id===caseId);item.status='skipped';item.completedAt=now();touch(run);}}return report(run);},
    async stop(context,id){const run=find(context,id),entry=jobs.get(id);if(entry){entry.cancelled=true;entry.cancel();}return {run:publicRun(run)};},
    isActive(context){const scope=scopeId(context);return busy.has(scope)||generating(scope)||state.runs.some(r=>r.scope===scope&&active(r));},
    close(){
      if(closing)return closing;closed=true;
      const cancel=()=>{for(const entry of jobs.values()){entry.cancelled=true;entry.cancel();}for(const controller of inputJobs.keys())controller.abort();for(const entry of generations.values())if(entry.status==='running')entry.cancel();};cancel();
      closing=(async()=>{await Promise.allSettled([...admissions]);cancel();await Promise.allSettled([...jobs.values()].map(job=>job.promise));await Promise.allSettled([...generationJobs]);await saving;})();return closing;
    },
  };
}
