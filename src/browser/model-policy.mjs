import {DEFAULT_MODEL,OPENROUTER_BASE_URL,isOpenRouterEndpoint} from './openrouter-models.mjs';

const OPENAI_URL='https://api.openai.com/v1';

function configurationError({apiKey,model,baseUrl}){
  if(typeof apiKey!=='string'||!apiKey.trim())return 'Configure a model API key to use the browser agent.';
  if(apiKey.length>4096||/\s/.test(apiKey))return 'Enter a valid model API key.';
  if(typeof model!=='string'||!model.trim()||model.length>200||/[\s\u0000-\u001f]/.test(model))return 'Enter a model ID.';
  if(/(?:^|\/)jev(?:-|$)/i.test(model))return 'Choose a chat model; Jev uses a separate decisions API.';
  try{
    const url=new URL(baseUrl);
    if(typeof baseUrl!=='string'||baseUrl.length>2048||!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error();
  }catch{return 'Enter a valid model API URL without embedded credentials.';}
  return null;
}

/** Resolve provider defaults once, before configuration crosses the worker seam. */
export function resolveBrowserModel({saved=null,env={}}={}){
  const openRouter=Boolean(env.OPENROUTER_API_KEY&&!env.PERPETUAL_MODEL_API_KEY);
  const value=saved??{
    apiKey:env.PERPETUAL_MODEL_API_KEY||env.OPENROUTER_API_KEY||'',
    model:env.PERPETUAL_MODEL||(openRouter?DEFAULT_MODEL:''),
    baseUrl:env.PERPETUAL_MODEL_BASE_URL||(env.PERPETUAL_MODEL_API_KEY?OPENAI_URL:OPENROUTER_BASE_URL),
  };
  const configuration={apiKey:value.apiKey||'',model:value.model||(value.apiKey?'':DEFAULT_MODEL),baseUrl:value.baseUrl||OPENROUTER_BASE_URL};
  const modelError=configurationError(configuration);
  return {...configuration,modelConfigured:!modelError,...(modelError?{modelError}:{})};
}

export function browserModelView(configuration){
  const {model,baseUrl,modelConfigured,modelError}=configuration;
  return {provider:isOpenRouterEndpoint(baseUrl)?'openrouter':'custom',model,baseUrl,keyConfigured:Boolean(configuration.apiKey),modelConfigured,...(modelError?{modelError}:{})};
}

export function browserModelEnvironment({apiKey,model,baseUrl}){
  return {PERPETUAL_MODEL_API_KEY:apiKey,PERPETUAL_MODEL:model,PERPETUAL_MODEL_BASE_URL:baseUrl};
}
