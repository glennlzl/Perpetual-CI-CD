import {lstat,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateBrowserTarget} from './runtime.ts';
import {resolveBrowserModel,browserModelView,browserModelEnvironment} from './model-policy.ts';
import type {BrowserModelInput,BrowserModelView} from './model-policy.ts';
import {OPENROUTER_BASE_URL,isOpenRouterEndpoint} from './openrouter-models.ts';

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

/** The saved browser model settings; the stored file may hold only what the controller saved. */
export type BrowserModelSettingsStore=Awaited<ReturnType<typeof createBrowserModelSettings>>;

export async function createBrowserModelSettings({dataDir,env=process.env}:{dataDir:string;env?:NodeJS.ProcessEnv}){
  const file=join(dataDir,'browser-model.json');let saved:BrowserModelInput|null=null;
  try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>16384)throw new Error('Invalid browser model settings.');const parsed:unknown=JSON.parse(await readFile(file,'utf8'));saved=parsed===null?null:isRecord(parsed)?parsed:{};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const configuration=()=>resolveBrowserModel({saved,env});
  const view=()=>browserModelView(configuration());
  let saving:Promise<unknown>=Promise.resolve();
  function save(input:unknown,{openRouterOnly=false}={}):Promise<BrowserModelView>{
      const operation=saving.then(async()=>{
        const fields=openRouterOnly?['apiKey','model']:['apiKey','model','baseUrl'];
        if(!isRecord(input)||Object.keys(input).some(key=>!fields.includes(key)))throw new Error(openRouterOnly?'Provide an OpenRouter model and API key.':'Provide model, API key or API URL.');
        if(openRouterOnly&&(typeof input.model!=='string'||!input.model.trim()))throw new Error('Choose an OpenRouter model.');
        const current=configuration();
        if(openRouterOnly&&input.apiKey===undefined&&!isOpenRouterEndpoint(current.baseUrl))throw new Error('Enter your OpenRouter API key to switch providers.');
        const apiKey=input.apiKey===undefined?current.apiKey:input.apiKey,model=input.model??current.model,baseUrl=openRouterOnly?OPENROUTER_BASE_URL:input.baseUrl??current.baseUrl;
        const resolved=resolveBrowserModel({saved:{apiKey,model,baseUrl}});
        if(!resolved.modelConfigured)throw new Error(resolved.modelError);
        const normalizedUrl=validateBrowserTarget(String(baseUrl)).replace(/\/$/,'');
        const next={apiKey,model,baseUrl:normalizedUrl},temporary=join(dataDir,`.browser-model-${randomUUID()}.tmp`);
        await writeFile(temporary,JSON.stringify(next),{mode:0o600});await rename(temporary,file);saved=next;return view();
      });saving=operation.catch(()=>{});return operation;
  }
  return {
    view,configuration,save,
    saveOpenRouter:(input:unknown)=>save(input,{openRouterOnly:true}),
    environment:()=>browserModelEnvironment(configuration()),
  };
}
