import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {redact} from '../providers.mjs';
import {resolveBrowserModel,browserModelEnvironment} from './model-policy.mjs';
import {validateRunCredentials} from './run-credentials.mjs';
import {HOST as TWIN_HOST} from '../twin/compose.mjs';

const base=fileURLToPath(new URL('../../integrations/browser-use/',import.meta.url));
// The runner's Chromium resolves the twin host to loopback, like the twin's containers reach the host.
const localHost=host=>host==='localhost'||host.endsWith('.localhost')||host==='[::1]'||/^127\./.test(host)||host===TWIN_HOST;

export function validateBrowserTarget(value,{controllerOrigin}={}) {
  let url;try{url=new URL(value);}catch{throw new Error('Enter a valid application URL.');}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(value.length>2048||url.username||url.password||!['http:','https:'].includes(url.protocol))throw new Error('Use an application URL without embedded credentials.');
  if(url.protocol==='http:'&&!localHost(host))throw new Error('Use HTTPS for previews or localhost for a local application.');
  if(!localHost(host)&&(host.includes(':')||/^(?:0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)||host.endsWith('.internal')||host==='metadata'))throw new Error('This address is not an application test target.');
  if(controllerOrigin){const controller=new URL(controllerOrigin);if(url.port===controller.port)throw new Error('Choose the application URL, not the Perpetual controller.');}
  url.hash='';return url.href;
}

export function browserError(error,env=process.env,limit=800) {
  let text=String(error?.message||error||'Browser operation failed.');
  for(const key of ['PERPETUAL_MODEL_API_KEY','OPENROUTER_API_KEY'])if(env[key])text=text.split(env[key]).join('[REDACTED]');
  return redact(text).replace(/\bBearer\s+\S+/gi,'Bearer [REDACTED]').replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g,'$1').slice(0,limit);
}

/**
 * The controller's kill timer is a last resort. A run worker executes one journey with its own deadline,
 * and the runner's request-wide backstop is timeoutSeconds + 15 after preflight, so fire later.
 */
export function workerTimeoutMs({mode,timeoutSeconds}={}){
  const seconds=timeoutSeconds||300;
  return mode==='run'?(seconds+15+30)*1000:seconds*1000+15000;
}

/**
 * Runs one owned worker process that speaks the browser worker contract: one JSON event per stdout line,
 * `error` events carrying the terminal error, and a zero exit once its work is reported. The worker's
 * process group is joined before completion: descendants still running settleMs after the worker exits count as
 * owned processes remaining. stopSignal asks it to clean up before the group is killed.
 * With onOutput, the process speaks no event protocol: its stdout and stderr chunks go to onOutput, and a zero exit completes it.
 */
export function superviseWorker({command,args,cwd,env,stdin='',onEvent,onOutput,timeoutMs,cleanupGraceMs=40000,settleMs=0,stopSignal='SIGTERM',secrets=[],unavailable='Browser runtime is unavailable.'}) {
  const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],env,cwd,detached:process.platform!=='win32'});
  const hidden=secrets.filter(value=>typeof value==='string'&&value);
  const failure=error=>browserError(hidden.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),String(error?.message||error||'Browser operation failed.')),env);
  let buffer='',eventBytes=0,terminalError=null,settled=false,timer,killTimer,forcedAt=0,cleanupIncomplete=false,timedOut=false;
  function signal(name){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,name);else child.kill(name);}catch{}}
  function groupAlive(){if(process.platform==='win32'||!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
  function stop(message){
    if(settled||killTimer)return;terminalError ||= new Error(message);try{child.kill(stopSignal);}catch{}
    // Python closes its agent, Chromium and driver with separate 10-second bounds,
    // after up to 5 seconds finishing recordings. Give those cleanups time before killing the owned process group.
    killTimer=setTimeout(()=>{forcedAt=Date.now();cleanupIncomplete=true;terminalError=new Error(`${terminalError?.message||'Browser operation stopped.'} Cleanup incomplete after forced termination; an owned browser or temporary profile may remain.`);signal('SIGKILL');},cleanupGraceMs);killTimer.unref();
  }
  const promise=new Promise((resolve,reject)=>{
    function done(error){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);error?reject(Object.assign(new Error(failure(error)),cleanupIncomplete?{cleanupIncomplete:true}:{},timedOut?{timedOut:true}:{})):resolve();}
    child.once('error',()=>done(new Error(unavailable)));
    child.stdout.setEncoding('utf8');
    if(onOutput){child.stderr.setEncoding('utf8');for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{try{onOutput(chunk,stream);}catch(error){stop(failure(error));}});}
    else child.stdout.on('data',chunk=>{
      buffer+=chunk;if(Buffer.byteLength(buffer)>3*1024*1024)return stop('Browser event exceeded its size limit.');
      let newline;
      while((newline=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
        let event;try{event=JSON.parse(line);}catch{return stop('Browser runtime returned an invalid event.');}
        if(!event||typeof event!=='object'||Array.isArray(event))return stop('Browser runtime returned an invalid event.');
        if(event.type!=='frame'){eventBytes+=Buffer.byteLength(line);if(eventBytes>8*1024*1024)return stop('Browser event history exceeded its size limit.');}
        if(event.type==='error'){cleanupIncomplete ||= event.cleanupIncomplete===true;terminalError=new Error(failure(event.error));continue;}
        if(event.type!=='frame'&&hidden.length)event=JSON.parse(hidden.reduce((text,secret)=>text.split(JSON.stringify(secret).slice(1,-1)).join('[REDACTED]'),JSON.stringify(event)));
        try{onEvent(event);}catch(error){return stop(failure(error));}
      }
    });
    // Runtime libraries can log page contents or credentials to stderr. Do not retain them.
    if(!onOutput)child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('close',async code=>{
      for(const end=Date.now()+settleMs;!killTimer&&groupAlive()&&Date.now()<end;)await new Promise(resolve=>setTimeout(resolve,50));
      if(groupAlive()){
        stop('Browser runtime exited with owned child processes remaining.');signal('SIGTERM');
        // The wrapper's stdio can close before Chromium and other owned
        // descendants exit. Keep the job (and its environment lease) alive
        // through graceful cleanup, forced termination, and signal delivery.
        while(groupAlive()&&(!forcedAt||Date.now()-forcedAt<1000))await new Promise(resolve=>setTimeout(resolve,10));
        if(groupAlive()){cleanupIncomplete=true;terminalError=new Error(`${terminalError?.message||'Browser operation stopped.'} Cleanup incomplete; owned child processes could not be confirmed stopped.`);}
      }
      done(terminalError||(code!==0?new Error('Browser runtime exited before completing the operation.'):buffer.trim()?new Error('Browser runtime returned an incomplete event.'):null));
    });
    timer=setTimeout(()=>{if(!killTimer)timedOut=true;stop('Browser operation exceeded its time limit.');},timeoutMs);timer.unref();
    child.stdin.end(stdin);
  });
  return {promise,cancel(){stop('Browser operation cancelled.');}};
}

export function createBrowserRuntime({python=process.env.PERPETUAL_BROWSER_PYTHON||`${base}.venv/bin/python`,runner=`${base}runner.py`,env=process.env,model}={}) {
  let preflight=null,checkedAt=0,pending=null;
  const modelConfiguration=()=>model?(typeof model==='function'?model():model):resolveBrowserModel({env:typeof env==='function'?env():env});
  function childEnvironment(configuration){
    const result={PYTHONUNBUFFERED:'1',ANONYMIZED_TELEMETRY:'false',BROWSER_USE_LOGGING_LEVEL:'error'};
    const values=typeof env==='function'?env():env;
    for(const key of ['PATH','HOME','TMPDIR','LANG','DISPLAY'])if(typeof values[key]==='string')result[key]=values[key];
    Object.assign(result,browserModelEnvironment(configuration));
    return result;
  }
  const runtime={
    async capabilities(){
      if(!preflight||Date.now()-checkedAt>15000){
        pending ||= (async()=>{
          const result={runtimeInstalled:false,browserInstalled:false};
          try{
            if(!isAbsolute(python))throw new Error('Invalid runtime path.');
            await access(python,constants.X_OK);await access(runner,constants.R_OK);
            const job=runtime.start({mode:'preflight'},event=>{if(event.type==='status'){result.runtimeInstalled=event.runtimeInstalled===true;result.browserInstalled=event.browserInstalled===true;}},{timeoutMs:10000});
            await job.promise;
          }catch{result.runtimeInstalled=false;result.browserInstalled=false;}
          preflight=result;checkedAt=Date.now();pending=null;return result;
        })();
        await pending;
      }
      const {modelConfigured,modelError}=modelConfiguration();return {...preflight,modelConfigured,...(modelError?{modelError}:{}),...(python===`${base}.venv/bin/python`?{runtimeProject:base.replace(/\/$/,'')}:{})};
    },
    start(input,onEvent,{timeoutMs=workerTimeoutMs(input),cleanupGraceMs=40000}={}) {
      const credentials=validateRunCredentials(input.credentials);
      if(credentials&&!['run','discover'].includes(input.mode))throw new Error('A test account is only available for a test run or discovery.');
      if(!isAbsolute(python)||!isAbsolute(runner))throw new Error('Configure an absolute Browser Use Python path.');
      const configuration=modelConfiguration();
      if(input.mode!=='preflight'&&!configuration.modelConfigured)throw new Error(configuration.modelError);
      const env=childEnvironment(configuration);
      return superviseWorker({command:python,args:[runner],cwd:base,env,stdin:JSON.stringify(input),onEvent,timeoutMs,cleanupGraceMs,secrets:[env.PERPETUAL_MODEL_API_KEY],unavailable:'Browser runtime is unavailable. Install integrations/browser-use first.'});
    },
  };
  return runtime;
}
