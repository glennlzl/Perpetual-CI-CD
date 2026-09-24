import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository, createPreviewPlan, DISCOVERY_VERSION } from './scanner.mjs';
import { getProviderStatus, getGitHubFailure, parseGitHubRemote, redact } from './providers.mjs';
import { defaultPipeline, normalizedPipeline, applyPipelineAction } from './pipeline.mjs';
import { getGitHubSession, listGitHubRepositories, listGitHubBranches, prepareGitHubSource, ensureGitHubHistory, updateGitHubSource } from './github-source.mjs';
import { readGitHubActions, readServiceConfig } from './service-config.mjs';
import { withDeliveryGraph } from './delivery.mjs';
import { readGitHistory } from './git-history.mjs';
import { createGitHubAuthManager } from './github-auth.mjs';
import { createGitHubRunsReader } from './github-runs.mjs';
import { createEnvironmentManager } from './environments/manager.mjs';
import { createBrowserManager } from './browser/manager.mjs';
import { sendVideo } from './browser/video-file.mjs';
import { createEnvironmentUsage } from './environments/usage.mjs';
import { createStageRemovalManager } from './environments/stage-removal.mjs';
import { acquireControllerOwnership } from './controller-ownership.mjs';
import { environmentInputs, fromAppSettings } from './environments/runtime.mjs';
import { createTwinInputs, services as twinServices } from './twin/index.mjs';
import { missingInputs } from './twin/inputs.mjs';
import { createGateManager } from './gate/manager.mjs';
import { createGateSteps, createReadiness } from './gate/steps.mjs';
import { readBranchHead, postCommitStatus } from './gate/github.mjs';

const defaultPublicDir=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const staticFiles={'/':['build/index.html','text/html']};
// Exact style-block hash from the embedded preview's reported CSP violation.
// Its injection source is unverified; this grants no other inline CSS or script access.
const reportedPreviewStyleHash="'sha256-UjmwW5hqkbmZat2z0a4MIudqMdHHunQ57o+t2nldQPQ='";
const exec=promisify(execFile);

// Read-only Git queries against a scanned or original checkout; never fetches or writes.
const readGit=(path,args)=>exec('git',['-c','core.fsmonitor=false','-C',path,...args],{
  timeout:2000,maxBuffer:4096,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},
});

async function configurationLinks(scan,files) {
  const repository=parseGitHubRemote(scan.repo.remote);
  if(!repository || !scan.repo.branch)return files;
  try {
    // Link only a branch GitHub has: the origin tracking ref is local evidence of that, without a network call.
    const [{stdout},remote]=await Promise.all([
      readGit(scan.repo.path,['rev-parse','--show-prefix']),
      readGit(scan.repo.path,['rev-parse','--verify','--quiet',`refs/remotes/origin/${scan.repo.branch}`]).then(()=>true,()=>false),
    ]);
    if(!remote)return files.map(file=>({...file,local:true}));
    const prefix=stdout.trim();
    if(prefix && (prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').some(part=>part==='..')))return files;
    return files.map(file=>({...file,editUrl:`https://github.com/${repository}/edit/${encodeURIComponent(scan.repo.branch)}/${(prefix+file.path).split('/').map(encodeURIComponent).join('/')}`}));
  }catch {return files;}
}

// The original --repo checkout, so a GitHub source can switch back to it by rescanning.
async function localCheckout(repo) {
  const path=resolve(repo);
  try {return {path,branch:(await readGit(path,['symbolic-ref','--short','--quiet','HEAD'])).stdout.trim()||null};}
  catch {return {path,branch:null};}
}

// A Sandbox stage's twin services and the inputs each still needs; views never carry values.
function twinServiceView(config,values) {
  return Object.entries(config?.services??{}).filter(([id])=>Object.hasOwn(twinServices,id)).map(([id,options])=>{
    const service=twinServices[id],missing=missingInputs(service,values[id]),settings=fromAppSettings(id,options);
    return {id,title:service.title,fidelity:service.fidelity,...(settings?{source:'settings'}:{}),blocked:missing.length>0,
      missing:settings?[]:(service.inputs??[]).filter(input=>missing.includes(input.name)).map(({name,label,secret})=>({name,label:label??name,secret:Boolean(secret)}))};
  });
}

async function assetFiles(publicDir) {
  const assets={};
  // Serve only generated asset filenames, never arbitrary filesystem paths.
  let built=[];try{built=await readdir(join(publicDir,'build/assets'),{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const file of built) {
    if(!file.isFile()||!/^[a-z0-9_-]+\.(js|css)$/i.test(file.name))continue;
    const path=`build/assets/${file.name}`;
    assets[`/${path}`]=[path,file.name.endsWith('.js')?'text/javascript':'text/css'];
  }
  for(const folder of ['brand','providers','fonts']) {
    const relative=`assets/${folder}`;
    let files=[];try{files=await readdir(join(publicDir,relative),{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const file of files) {
      if(!file.isFile()||!/^[a-z0-9-]+\.(svg|woff2|ttf)$/i.test(file.name))continue;
      const path=`${relative}/${file.name}`;
      assets[`/${path}`]=[path,file.name.endsWith('.svg')?'image/svg+xml':file.name.endsWith('.ttf')?'font/ttf':'font/woff2'];
    }
  }
  return assets;
}

export async function startServer(options={}) {
  const dataDir=resolve(options.dataDir??'.perpetual');
  const release=await acquireControllerOwnership(dataDir),cleanup=[];
  try {
    const app=await createController({...options,dataDir},dispose=>cleanup.push(dispose));
    let closing;
    return {...app,close(){return closing??=(async()=>{await app.close();await release();})();}};
  }catch(error){
    const results=await Promise.allSettled(cleanup.map(dispose=>Promise.resolve().then(dispose)));
    // Keep ownership if shutdown cannot establish a clean boundary.
    if(results.every(result=>result.status==='fulfilled'))await release();
    throw error;
  }
}

async function createController({port=4317,repo=process.cwd(),dataDir,github={},publicDir=defaultPublicDir},onCleanup) {
  await mkdir(dataDir,{recursive:true,mode:0o700});
  let publicFiles={...staticFiles,...await assetFiles(publicDir)},assetScans=0,appliedAssetScan=0;
  // A rebuild replaces hashed asset names while the server runs; rescan instead of requiring a restart.
  // Each miss scans after it arrives, and an older scan finishing late never replaces a newer listing.
  const refreshAssets=async()=>{const scan=++assetScans,assets=await assetFiles(publicDir);if(scan>appliedAssetScan){appliedAssetScan=scan;publicFiles={...staticFiles,...assets};}};
  const stateFile=join(dataDir,'state.json');
  let state={scan:null,providers:[],pipelines:{}};
  try {const saved=JSON.parse(await readFile(stateFile,'utf8'));if(saved.schema===1)state=saved.state;}catch(error){if(error.code!=='ENOENT')throw new Error('Cannot load saved state; preserve it and use a different --data directory.');}
  if(!state.pipelines || typeof state.pipelines!=='object' || Array.isArray(state.pipelines))state.pipelines={};
  // Retired repair reports, HTTP checks and their stage drafts; the next save omits them.
  delete state.runs;delete state.checks;
  for(const pipeline of Object.values(state.pipelines))if(Array.isArray(pipeline?.stages))for(const stage of pipeline.stages)delete stage?.tests;
  const token=randomBytes(32).toString('hex');
  // `github` lets tests supply the sign-in manager, runs reader, branch head and commit status; no CLI is spawned for them.
  const githubAuth=github.auth??createGitHubAuthManager(),githubRuns=github.runs??createGitHubRunsReader();
  onCleanup(()=>githubAuth.dispose());
  const usage=createEnvironmentUsage();let environments;
  onCleanup(()=>usage.stopAdmissions());
  const browser=await createBrowserManager({dataDir,usage,resolveEnvironment:url=>environments?.resolveTarget(url),onEnvironmentUncertain:(id,error)=>environments.markUsageUncertain(id,error)});
  onCleanup(()=>browser.close());
  const twinInputs=createTwinInputs({dataDir});
  const twinsReady=createReadiness();
  environments=await createEnvironmentManager({dataDir,usage,interruptedEnvironmentIds:browser.interruptedEnvironmentIds(),onReady:(context,environment)=>browser.prepareEnvironment(context,environment,{isCurrent:()=>isPreparationSourceCurrent(context)}).finally(()=>twinsReady.done(environment.id))});
  onCleanup(()=>environments.close());
  let saving=Promise.resolve(),tickTask=null,sourceBusy=false,closed=false,closing;
  // A fresh checkout must not reset stage definitions for the same repository/root.
  const sourceKey=source=>`github:${source.repository.toLowerCase()}:${source.rootDirectory}`;
  const pipelineKey=current=>current.source?.scanPath===current.scan?.repo?.path
    ? sourceKey(current.source) : current.scan?.repo?.path;
  function currentPipeline(current) {
    const repoPath=current.scan?.repo?.path;
    if(!repoPath)throw new Error('Scan a repository first.');
    return normalizedPipeline({... (current.pipelines[pipelineKey(current)] ?? defaultPipeline(repoPath)),repoPath});
  }
  function isPreparationSourceCurrent(context) {
    return !closed&&!sourceBusy&&pipelineKey(state)===context.key
      &&state.scan?.repo.path===context.scan.repo.path&&state.scan?.repo.sha===context.scan.repo.sha&&state.scan?.repo.branch===context.scan.repo.branch
      &&currentPipeline(state).stages.some(stage=>stage.id===context.stageId&&stage.kind==='sandbox');
  }
  function requireSourceIdle() {
    if(sourceBusy){const error=new Error('A source change is still being saved. Please wait.');error.statusCode=409;throw error;}
    if(githubAuth.isPending()){const error=new Error('Finish or cancel GitHub sign-in first.');error.statusCode=409;throw error;}
  }
  function requireSourceChangeIdle(){
    requireSourceIdle();
    if(browser.hasPendingInput())throw Object.assign(new Error('Finish adding this test before changing the source.'),{statusCode:409});
  }
  async function githubConnection(knownSession) {
    const session=knownSession ?? await getGitHubSession();
    const detected=parseGitHubRemote(state.scan?.repo?.remote);
    // A local GitHub project already has a source. Reuse its verified CLI
    // session unless this instance has an explicit connection choice. A null
    // record is a deliberate Disconnect, whereas an absent record is legacy.
    const reuseLocalSession=Boolean(detected) && !Object.hasOwn(state,'githubConnection');
    const connected=Boolean(!githubAuth.isPending() && session.authenticated && (reuseLocalSession || state.githubConnection?.login===session.account?.login));
    const source=state.source ?? (detected ? {
      repository:detected,branch:state.scan.repo.branch,rootDirectory:'/',
    } : null);
    return {...session,connected,source};
  }
  async function requireGitHub() {
    if(githubAuth.isPending()){const error=new Error('Finish or cancel GitHub sign-in first.');error.statusCode=409;throw error;}
    const connection=await githubConnection();
    if(!connection.connected)throw new Error(connection.message || 'Connect your GitHub account before selecting a repository.');
    return connection;
  }
  function save(prepare) {
    const operation=saving.then(async()=>{
      const transaction=prepare?.(state);
      const content=JSON.stringify({schema:1,state:transaction?.state ?? state},null,2);
      const temp=stateFile+'.tmp';await writeFile(temp,content,{mode:0o600});await rename(temp,stateFile);
      transaction?.commit?.();
      return transaction?.result;
    });
    saving=operation.catch(()=>{});
    return operation;
  }
  // Refresh older discovery snapshots without resetting the user's stages or source.
  if (state.scan && (state.scan.discoveryVersion ?? 0) < DISCOVERY_VERSION) {
    try {
      const scan = await scanRepository(state.scan.repo.path);
      await save(current => ({
        state: { ...current, scan, providers: [] },
        commit() { state.scan = scan; state.providers = []; },
      }));
    } catch (error) {
      process.stderr.write(`Could not refresh repository discovery; retaining saved data: ${redact(error.message)}\n`);
    }
  }
  // Journey gate: each pushed commit of the managed source moves the source copy in place, rebuilds
  // a Sandbox stage's twin and runs its reviewed journeys. The user's own checkout never moves.
  const gateStop=new AbortController(),conflict=message=>Object.assign(new Error(message),{statusCode:409});
  async function moveSource(sha) {
    const source=state.source;
    if(!source||source.scanPath!==state.scan.repo.path)throw new Error('Connect a GitHub repository to test pushed commits.');
    requireSourceChangeIdle();sourceBusy=true;
    try {
      await requireGitHub();
      await updateGitHubSource({source,dataDir,sha});
      const scan=await scanRepository(source.scanPath),next={...source,sha:scan.repo.sha,savedAt:new Date().toISOString()};
      await save(current=>({state:{...current,scan,source:next,providers:[]},commit(){state.scan=scan;state.source=next;state.providers=[];}}));
    }finally{sourceBusy=false;}
  }
  const gates=await createGateManager({dataDir,
    source(){
      if(!state.scan)return null;
      const managed=state.source?.scanPath===state.scan.repo.path;
      return {key:pipelineKey(state),branch:state.scan.repo.branch||null,sha:state.scan.repo.sha||null,repository:managed?state.source.repository:null,stages:currentPipeline(state).stages.map(({id,name,kind})=>({id,name,kind}))};
    },
    github:{
      // Only the connected account reads heads and reports statuses, as for workflow runs.
      async connection(){
        if(state.githubConnection===null||githubAuth.isPending())return null;
        const connection=await githubConnection(await githubRuns.session());
        return connection.connected&&connection.source?.repository?{login:connection.account.login,repository:connection.source.repository}:null;
      },
      head:input=>(github.head??readBranchHead)(input),
      post:input=>(github.status??postCommitStatus)(input),
    },
    steps:createGateSteps({environments,browser,readiness:twinsReady,signal:gateStop.signal,async checkout({key,branch,stageId,sha}){
      requireSourceChangeIdle();
      if(!state.scan||pipelineKey(state)!==key||(state.scan.repo.branch||null)!==branch)throw conflict('The active source changed.');
      usage.assertAvailable({key,stageId});
      if(state.scan.repo.sha!==sha)await moveSource(sha);
      return {key,stageId,scan:state.scan,controllerOrigin:`http://127.0.0.1:${server.address().port}`};
    }}),
  });
  onCleanup(()=>{gateStop.abort();return gates.close();});
  const removals=await createStageRemovalManager({dataDir,usage,environments,browser,removeStage:context=>save(current=>{
    // Deletion belongs to the confirmed source, even after the user changes
    // repositories or closes the browser. A prior final commit is idempotent.
    const existing=current.pipelines[context.key];
    if(!existing||!existing.stages.some(stage=>stage.id===context.stageId))return {result:null};
    if(browser.isActive(context)||environments.summaries(context.key).some(item=>item.stageId===context.stageId&&item.status!=='destroyed'&&!(item.status==='failed'&&(!item.sandboxId||item.cleanedAt))))throw new Error('Stage cleanup is not complete.');
    const pipeline=applyPipelineAction(existing,{action:'remove-stage',stageId:context.stageId});
    const pipelines={...current.pipelines,[context.key]:pipeline};
    return {state:{...current,pipelines},commit(){state.pipelines=pipelines;},result:pipeline};
  })});
  onCleanup(()=>removals.close());
  // A paused recording stream would otherwise hold shutdown open.
  const videoStreams=new Set();
  const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  async function body(req,limit=65536) {
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('Request exceeds the allowed size.');chunks.push(chunk);}
    const content=Buffer.concat(chunks).toString('utf8');
    return content?JSON.parse(content):{};
  }
  const server=createServer(async(req,res)=>{
    const styleNonce=randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${styleNonce}' ${reportedPreviewStyleHash}; style-src-attr 'none'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    const actualPort=server.address()?.port;
    const hosts=[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`];
    const origin=req.headers.origin;
    if(!hosts.includes(req.headers.host) || (origin&&!hosts.some(h=>origin===`http://${h}`)) || req.headers['sec-fetch-site']==='cross-site')return reply(res,403,{error:'This local control room accepts same-origin requests only.'});
    if(req.method==='POST'&&req.headers['x-perpetual-token']!==token)return reply(res,403,{error:'Session expired. Refresh the page before making changes.'});
    if(closed)return reply(res,503,{error:'The controller is shutting down.'});
    try {
      const requestUrl=new URL(req.url,'http://localhost'),path=requestUrl.pathname;
      if(req.method==='GET'&&!publicFiles[path]&&/^\/(build\/)?assets\//.test(path))await refreshAssets();
      if(req.method==='GET'&&publicFiles[path]) {
        const [file,type]=publicFiles[path];
        let content;
        try { content=await readFile(join(publicDir,file)); }
        catch(error) {
          if(error.code==='ENOENT'&&path==='/')return reply(res,503,{error:'Build the interface with npm run build.'});
          if(error.code==='ENOENT'){await refreshAssets();return reply(res,404,{error:'Not found.'});}
          throw error;
        }
        if(type==='text/html')content=content.toString('utf8').replace('__PERPETUAL_STYLE_NONCE__',styleNonce);
        res.setHeader('Content-Type',`${type}; charset=utf-8`);
        return res.end(content);
      }
      if(req.method==='GET'&&path==='/favicon.ico'){res.writeHead(204);return res.end();}
      if(req.method==='GET'&&path==='/api/session')return reply(res,200,{token});
      if(req.method==='GET'&&path==='/api/settings/model')return reply(res,200,await browser.viewModel());
      if(req.method==='GET'&&path==='/api/settings/models')return reply(res,200,await browser.listModels());
      if(req.method==='POST'&&path==='/api/settings/model')return reply(res,200,await browser.saveModelSettings(await body(req,16384)));
      if(path==='/api/twin/inputs') {
        if(req.method==='GET')return reply(res,200,{services:await twinInputs.view()});
        if(req.method!=='PUT')return reply(res,404,{error:'Not found.'});
        if(req.headers['x-perpetual-token']!==token)return reply(res,403,{error:'Session expired. Refresh the page before making changes.'});
        const input=await body(req,16384);
        return reply(res,200,{services:await twinInputs.set(input.service,input.inputs)});
      }
      if(req.method==='GET'&&path==='/api/twin/services') {
        requireSourceIdle();
        const scan=state.scan,changed=()=>Object.assign(new Error('The active source changed. Reload the pipeline.'),{statusCode:409});
        if(!scan||requestUrl.searchParams.get('repoPath')!==scan.repo.path)throw changed();
        const stage=currentPipeline(state).stages.find(item=>item.id===requestUrl.searchParams.get('stageId'));
        if(!stage||stage.kind!=='sandbox')throw new Error('Choose a Sandbox stage.');
        const {plan}=await environments.view({key:pipelineKey(state),stageId:stage.id,scan,controllerOrigin:`http://127.0.0.1:${actualPort}`});
        const services=twinServiceView(plan,await environmentInputs({dataDir,config:plan}));
        if(state.scan!==scan)throw changed();
        return reply(res,200,{services});
      }
      if(req.method==='GET'&&path==='/api/state')return reply(res,200,{...state,scan:withDeliveryGraph(state.scan),pipeline:state.scan?currentPipeline(state):null,environments:state.scan?environments.summaries(pipelineKey(state)):[],stageRemovals:state.scan?removals.summaries(pipelineKey(state)):[],browserTests:state.scan?Object.fromEntries(currentPipeline(state).stages.filter(stage=>stage.kind==='sandbox').map(stage=>[stage.id,browser.summary({key:pipelineKey(state),stageId:stage.id})])):{},defaultRepo:repo,capabilities:{modelConfigured:!!((process.env.PERPETUAL_MODEL_API_KEY&&process.env.PERPETUAL_MODEL)||process.env.OPENROUTER_API_KEY),browserAgent:true,localBrowser:true,cloudProvisioning:false,businessDiscovery:true}});
      if(path==='/api/stages/remove'||path==='/api/stages/removal'){
        requireSourceIdle();
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req);
        const scan=state.scan;
        if(!scan||input.repoPath!==scan.repo.path)throw Object.assign(new Error('The active source changed. Reload the pipeline.'),{statusCode:409});
        const context={key:pipelineKey(state),stageId:input.stageId};
        const stage=currentPipeline(state).stages.find(item=>item.id===input.stageId),previous=removals.view(context);
        if(stage?stage.kind!=='sandbox':!previous.removal)throw new Error('Choose a Sandbox stage.');
        if(req.method==='GET'&&path==='/api/stages/removal')return reply(res,200,previous);
        if(req.method==='POST'&&path==='/api/stages/remove')return reply(res,202,await removals.start(context));
        return reply(res,404,{error:'Stage operation not found.'});
      }
      if(path==='/api/gate'||path.startsWith('/api/gate/')) {
        const scan=state.scan;
        if(!scan)throw new Error('Scan a repository first.');
        // The view names the active source, so a page on an older commit reloads it.
        if(req.method==='GET'&&path==='/api/gate')return reply(res,200,{repoPath:scan.repo.path,sha:scan.repo.sha||null,...gates.view()});
        if(req.method!=='POST')return reply(res,404,{error:'Gate operation not found.'});
        const input=await body(req);
        if(input.repoPath!==scan.repo.path)throw conflict('The active source changed. Reload the pipeline.');
        if(path==='/api/gate/run')return reply(res,202,{repoPath:scan.repo.path,sha:scan.repo.sha||null,...await gates.run({stageId:input.stageId})});
        if(path==='/api/gate/release') {
          const connection=state.githubConnection===null?null:await githubConnection(await githubRuns.session());
          if(!connection?.connected)throw new Error('Connect GitHub to release.');
          return reply(res,200,{repoPath:scan.repo.path,sha:scan.repo.sha||null,...await gates.release({stageId:input.stageId,sha:input.sha,login:connection.account.login})});
        }
        return reply(res,404,{error:'Gate operation not found.'});
      }
      if(path==='/api/browser'||path.startsWith('/api/browser/')) {
        requireSourceIdle();
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req,path==='/api/browser/transcribe'?12*1024*1024:1024*1024);
        const scan=state.scan;
        if(!scan||input.repoPath!==scan.repo.path)throw Object.assign(new Error('The active source changed. Reload the pipeline.'),{statusCode:409});
        const stage=currentPipeline(state).stages.find(item=>item.id===input.stageId);
        if(!stage||stage.kind!=='sandbox')throw new Error('Choose a Sandbox stage.');
        const context={key:pipelineKey(state),stageId:stage.id,scan,controllerOrigin:`http://127.0.0.1:${actualPort}`};
        const browserRun=path.match(/^\/api\/browser\/runs\/([a-f0-9-]{36})(\/frame|\/video)?$/);
        if(req.method==='GET'&&browserRun) {
          if(!browserRun[2])return reply(res,200,await browser.runProgress(context,browserRun[1]));
          if(browserRun[2]==='/video'){
            const recording=await browser.video(context,browserRun[1],input.caseId,input.file);
            videoStreams.add(res);res.once('close',()=>videoStreams.delete(res));
            return await sendVideo(req,res,recording);
          }
          const frame=await browser.frame(context,browserRun[1],input.caseId);
          if(!frame){res.writeHead(204);return res.end();}
          res.setHeader('Content-Type','image/jpeg');res.setHeader('Content-Length',frame.length);return res.end(frame);
        }
        if(req.method==='GET'&&path==='/api/browser')return reply(res,200,await browser.view(context));
        if(req.method==='POST') {
          const operation=path.slice('/api/browser/'.length);
          if(operation==='config')return reply(res,200,await browser.saveConfig(context,input.config));
          if(operation==='model')return reply(res,200,await browser.saveModel(context,{...Object.fromEntries(['apiKey','model','baseUrl'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]))}));
          if(operation==='cases')return reply(res,200,await browser.saveCases(context,input.cases,input.baseCases));
          if(operation==='specs')return reply(res,200,await browser.saveSpec(context,{caseId:input.caseId,code:input.code}));
          if(operation==='specs/approve')return reply(res,200,await browser.approveSpec(context,{caseId:input.caseId,hash:input.hash}));
          if(operation==='specs/generate')return reply(res,202,await browser.generateSpec(context,{caseId:input.caseId}));
          if(operation==='specs/generate/cancel')return reply(res,200,await browser.cancelSpecGeneration(context,{caseId:input.caseId}));
          if(operation==='draft'||operation==='transcribe'){
            const controller=new AbortController();
            const cancel=()=>{if(!res.writableEnded)controller.abort();};
            res.once('close',cancel);
            if(res.destroyed)controller.abort();
            try{
              const options={signal:controller.signal,isCurrent:()=>isPreparationSourceCurrent(context)};
              const result=operation==='draft'?await browser.draft(context,input.description,options):await browser.transcribe(context,input,options);
              return reply(res,200,result);
            }finally{res.off('close',cancel);}
          }
          if(operation==='discover')return reply(res,202,await browser.discover(context,input));
          if(operation==='run')return reply(res,202,await browser.run(context,input,{manual:true}));
          if(operation==='skip')return reply(res,200,await browser.skip(context,input.id,input.caseId));
          if(operation==='stop')return reply(res,200,await browser.stop(context,input.id));
        }
        return reply(res,404,{error:'Browser operation not found.'});
      }
      if(path==='/api/environments'||path.startsWith('/api/environments/')) {
        requireSourceIdle();
        const input=req.method==='GET'?Object.fromEntries(requestUrl.searchParams):await body(req,1024*1024);
        const scan=state.scan;
        if(!scan||input.repoPath!==scan.repo.path)throw Object.assign(new Error('The active source changed. Reload the pipeline.'),{statusCode:409});
        const stage=currentPipeline(state).stages.find(item=>item.id===input.stageId);
        if(!stage||stage.kind!=='sandbox')throw new Error('Choose a Sandbox stage.');
        const context={key:pipelineKey(state),stageId:stage.id,scan,controllerOrigin:`http://127.0.0.1:${actualPort}`};
        if(req.method==='GET'&&path==='/api/environments')return reply(res,200,await environments.view(context));
        if(req.method==='POST') {
          const operation=path.slice('/api/environments/'.length);
          if(operation==='plan')return reply(res,200,await environments.savePlan(context,input.plan));
          if(operation==='create')return reply(res,202,await environments.create(context));
          if(operation==='destroy')return reply(res,202,await environments.destroy(context,input.id));
          if(operation==='logs')return reply(res,200,await environments.logs(context,input.id));
        }
        return reply(res,404,{error:'Environment operation not found.'});
      }
      if(req.method==='GET'&&path==='/api/github/connection'){
        const [connection,local]=await Promise.all([githubConnection(),localCheckout(repo)]);
        return reply(res,200,{...connection,localCheckout:local});
      }
      if(req.method==='POST'&&path==='/api/github/auth/start') {
        await body(req);
        if(sourceBusy){const error=new Error('A source change is still being saved. Please wait.');error.statusCode=409;throw error;}
        return reply(res,200,githubAuth.start());
      }
      if(req.method==='POST'&&path==='/api/github/auth/status') {
        const input=await body(req);
        return reply(res,200,githubAuth.status(input.id));
      }
      if(req.method==='POST'&&path==='/api/github/auth/cancel') {
        const input=await body(req);
        return reply(res,200,githubAuth.cancel(input.id));
      }
      if(req.method==='POST'&&path==='/api/github/connect') {
        requireSourceIdle();sourceBusy=true;
        try {
          const session=await getGitHubSession();
          if(!session.authenticated)throw new Error(session.message || 'Sign in with GitHub CLI on this computer, then connect again.');
          const connectionRecord={login:session.account.login,connectedAt:new Date().toISOString()};
          await save(current=>({state:{...current,githubConnection:connectionRecord},commit(){state.githubConnection=connectionRecord;}}));
          return reply(res,200,await githubConnection(session));
        }finally{sourceBusy=false;}
      }
      if(req.method==='POST'&&path==='/api/github/disconnect') {
        requireSourceIdle();sourceBusy=true;
        try {
          await save(current=>({state:{...current,githubConnection:null},commit(){state.githubConnection=null;}}));
          return reply(res,200,await githubConnection());
        }finally{sourceBusy=false;}
      }
      if(req.method==='GET'&&path==='/api/github/repositories') {
        await requireGitHub();
        return reply(res,200,await listGitHubRepositories({page:requestUrl.searchParams.get('page') ?? 1}));
      }
      if(req.method==='GET'&&path==='/api/github/branches') {
        await requireGitHub();
        return reply(res,200,await listGitHubBranches({repository:requestUrl.searchParams.get('repository'),page:requestUrl.searchParams.get('page') ?? 1,preferredBranch:requestUrl.searchParams.get('preferredBranch') || undefined}));
      }
      if(req.method==='POST'&&path==='/api/source/github') {
        requireSourceChangeIdle();sourceBusy=true;
        try {
          const connection=await requireGitHub(),input=await body(req);
          const prepared=await prepareGitHubSource({repository:input.repository,branch:input.branch,rootDirectory:input.rootDirectory,dataDir});
          const scan=await scanRepository(prepared.scanPath);
          const source={...prepared,connectedAccount:connection.account.login,savedAt:new Date().toISOString()};
          const result=await save(current=>{
            const key=sourceKey(source),detected=parseGitHubRemote(current.scan?.repo?.remote);
            const pipelines={...current.pipelines};
            // Preserve the outgoing local repository even if a different one is selected first.
            if(!current.source && detected && current.pipelines[current.scan.repo.path]) {
              const legacyKey=sourceKey({repository:detected,rootDirectory:'/'});
              pipelines[legacyKey] ??= current.pipelines[current.scan.repo.path];
            }
            const saved=pipelines[key];
            const pipeline=normalizedPipeline({... (saved ?? defaultPipeline(scan.repo.path)),repoPath:scan.repo.path});
            pipelines[key]=pipeline;
            return {state:{...current,scan,source,providers:[],pipelines},
              commit(){state.scan=scan;state.source=source;state.providers=[];state.pipelines=pipelines;},
              result:{scan,source,pipeline}};
          });
          return reply(res,200,result);
        }finally{sourceBusy=false;}
      }
      if(req.method==='POST'&&path==='/api/scan') {
        requireSourceChangeIdle();sourceBusy=true;
        try {
          const input=await body(req),scan=await scanRepository(input.path||repo);
          await save(current=>({state:{...current,providers:[],scan,source:null},commit(){state.providers=[];state.scan=scan;state.source=null;}}));
          return reply(res,200,scan);
        }finally{sourceBusy=false;}
      }
      if(req.method==='GET'&&path==='/api/pipeline') {
        return reply(res,200,{pipeline:currentPipeline(state)});
      }
      if(req.method==='GET'&&path==='/api/git-history') {
        requireSourceIdle();
        const scan=state.scan;
        const source=state.source;
        if(!scan || requestUrl.searchParams.get('repoPath')!==scan.repo.path) {
          const error=new Error('The active repository changed. Reopen its Git graph.');
          error.statusCode=409;throw error;
        }
        let sync=null;
        if(source?.scanPath===scan.repo.path) {
          await requireGitHub();
          sync=await ensureGitHubHistory({source,dataDir,refresh:requestUrl.searchParams.get('refresh')==='1'});
        }
        const history=await readGitHistory(scan,{
          scope:requestUrl.searchParams.get('scope')??'all',
          limit:Number(requestUrl.searchParams.get('limit')??100),
          ...(sync ? {currentRef:`refs/remotes/origin/${source.branch}`} : {}),
        });
        if(state.scan!==scan) {
          const error=new Error('The active repository changed. Reopen its Git graph.');
          error.statusCode=409;throw error;
        }
        return reply(res,200,{...history,...sync});
      }
      if(req.method==='GET'&&path==='/api/github-actions') {
        requireSourceIdle();
        const scan=state.scan;
        if(!scan || requestUrl.searchParams.get('repoPath')!==scan.repo.path) {
          const error=new Error('The active repository changed. Reload its pipeline.');
          error.statusCode=409;throw error;
        }
        const actions=await readGitHubActions(scan);
        if(state.scan!==scan) {
          const error=new Error('The active repository changed. Reload its pipeline.');
          error.statusCode=409;throw error;
        }
        return reply(res,200,actions);
      }
      if(req.method==='GET'&&path==='/api/service-config') {
        requireSourceIdle();
        const scan=state.scan;
        if(!scan || requestUrl.searchParams.get('repoPath')!==scan.repo.path) {
          const error=new Error('The active repository changed. Reload its pipeline.');
          error.statusCode=409;throw error;
        }
        const configuration=await readServiceConfig(scan,requestUrl.searchParams.get('nodeId'));
        configuration.files=await configurationLinks(scan,configuration.files);
        if(state.scan!==scan) {
          const error=new Error('The active repository changed. Reopen its settings.');
          error.statusCode=409;throw error;
        }
        return reply(res,200,configuration);
      }
      if(req.method==='POST'&&path==='/api/pipeline/action') {
        requireSourceIdle();
        const input=await body(req);
        const pipeline=await save(current=>{
          const repoPath=current.scan?.repo?.path;
          if(!repoPath || input?.repoPath!==repoPath) {
            const error=new Error('The active repository changed. Reload its pipeline before editing.');
            error.statusCode=409;throw error;
          }
          if(input.action==='remove-stage')throw new Error('Use confirmed stage deletion to remove this stage and its sandbox.');
          for(const stageId of [input.stageId,input.afterStageId,input.sourceStageId,input.targetStageId].filter(Boolean))usage.assertAvailable({key:pipelineKey(current),stageId});
          const pipeline=applyPipelineAction(currentPipeline(current),input);
          if(input.action==='set-github-workflow' && input.workflowFile!==null && !current.scan.workflows?.some(workflow=>workflow.file===input.workflowFile)) {
            throw new Error('The selected GitHub Actions workflow is no longer available. Reload the pipeline.');
          }
          const pipelines={...current.pipelines,[pipelineKey(current)]:pipeline};
          return {state:{...current,pipelines},commit(){state.pipelines=pipelines;},result:pipeline};
        });
        return reply(res,200,{pipeline});
      }
      if(req.method==='GET'&&path==='/api/providers') {
        if(!state.scan)throw new Error('Scan a repository first.');
        const scan=state.scan,providers=await getProviderStatus(scan);
        if(state.scan===scan){state.providers=providers;await save();}
        return reply(res,200,{providers});
      }
      if(req.method==='GET'&&path==='/api/github/runs') {
        // Current-commit Actions status only for the connected account, never the ambient gh session.
        // The account is verified on every read, so gh auth switch or logout stops reads at once.
        requireSourceIdle();
        const scan=state.scan;
        if(!scan||requestUrl.searchParams.get('repoPath')!==scan.repo.path)throw Object.assign(new Error('The active repository changed. Reload its pipeline.'),{statusCode:409});
        if(state.githubConnection===null)throw new Error('Connect your GitHub account to read workflow runs.');
        const connection=await githubConnection(await githubRuns.session());
        if(!connection.connected)throw new Error(connection.message||'Connect your GitHub account to read workflow runs.');
        const runs=await githubRuns.read({repository:connection.source?.repository,sha:scan.repo.sha,login:connection.account?.login});
        if(state.scan!==scan)throw Object.assign(new Error('The active repository changed. Reload its pipeline.'),{statusCode:409});
        return reply(res,200,runs);
      }
      const failedRun=path.match(/^\/api\/providers\/github\/runs\/(\d+)\/failure$/);
      if(req.method==='GET'&&failedRun) return reply(res,200,await getGitHubFailure(state.scan,failedRun[1]));
      if(req.method==='POST'&&path==='/api/plan') {
        if(!state.scan)throw new Error('Scan a repository first.');
        const input=await body(req);return reply(res,200,createPreviewPlan(state.scan,input.environment||'alpha'));
      }
      return reply(res,404,{error:'Not found.'});
    } catch(error) {return reply(res,[404,409,502].includes(error.statusCode)?error.statusCode:400,{error:redact(error.message).slice(0,1000)});}
  });
  onCleanup(()=>server.listening?new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())):undefined);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const timer=setInterval(()=>{
    if(tickTask||closed)return;
    tickTask=(async()=>{
      try {await environments.tick();}
      catch(e){process.stderr.write(`Environment runner: ${redact(e.message)}\n`);}finally{tickTask=null;}
    })();
  },1000);timer.unref();
  gates.start();
  return {url:`http://127.0.0.1:${server.address().port}`,server,close(){
    if(closing)return closing;closed=true;clearInterval(timer);githubAuth.dispose();usage.stopAdmissions();gateStop.abort();
    for(const res of videoStreams)res.destroy();
    const stopped=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    const draining=[gates.close(),removals.close(),environments.close(),browser.close(),tickTask,stopped];
    closing=(async()=>{const results=await Promise.allSettled(draining);await saving;const failed=results.find(item=>item.status==='rejected');if(failed)throw failed.reason;})();return closing;
  }};
}
