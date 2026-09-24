import {lstat,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateBrowserTarget} from './runtime.mjs';
import {resolveBrowserModel,browserModelView,browserModelEnvironment} from './model-policy.mjs';
import {OPENROUTER_BASE_URL,isOpenRouterEndpoint} from './openrouter-models.mjs';

export async function createBrowserModelSettings({dataDir,env=process.env}){
  const file=join(dataDir,'browser-model.json');let saved=null;
  try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>16384)throw new Error('Invalid browser model settings.');saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const configuration=()=>resolveBrowserModel({saved,env});
  const view=()=>browserModelView(configuration());
  let saving=Promise.resolve();
  function save(input,{openRouterOnly=false}={}){
      const operation=saving.then(async()=>{
        const fields=openRouterOnly?['apiKey','model']:['apiKey','model','baseUrl'];
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))throw new Error(openRouterOnly?'Provide an OpenRouter model and API key.':'Provide model, API key or API URL.');
        if(openRouterOnly&&(typeof input.model!=='string'||!input.model.trim()))throw new Error('Choose an OpenRouter model.');
        const current=configuration();
        if(openRouterOnly&&input.apiKey===undefined&&!isOpenRouterEndpoint(current.baseUrl))throw new Error('Enter your OpenRouter API key to switch providers.');
        const apiKey=input.apiKey===undefined?current.apiKey:input.apiKey,model=input.model??current.model,baseUrl=openRouterOnly?OPENROUTER_BASE_URL:input.baseUrl??current.baseUrl;
        const resolved=resolveBrowserModel({saved:{apiKey,model,baseUrl}});
        if(!resolved.modelConfigured)throw new Error(resolved.modelError);
        const normalizedUrl=validateBrowserTarget(baseUrl).replace(/\/$/,'');
        const next={apiKey,model,baseUrl:normalizedUrl},temporary=join(dataDir,`.browser-model-${randomUUID()}.tmp`);
        await writeFile(temporary,JSON.stringify(next),{mode:0o600});await rename(temporary,file);saved=next;return view();
      });saving=operation.catch(()=>{});return operation;
  }
  return {
    view,configuration,save,
    saveOpenRouter:input=>save(input,{openRouterOnly:true}),
    environment:()=>browserModelEnvironment(configuration()),
  };
}
