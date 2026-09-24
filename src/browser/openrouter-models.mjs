export const OPENROUTER_BASE_URL='https://openrouter.ai/api/v1';
export const isOpenRouterEndpoint=value=>typeof value==='string'&&value.replace(/\/$/,'')===OPENROUTER_BASE_URL;
const CATALOG_URL=`${OPENROUTER_BASE_URL}/models`;
export const DEFAULT_MODEL='openai/gpt-5.4-mini';
const CACHE_TTL_MS=5*60*1000;
const CATALOG_LIMIT=8*1024*1024;

function eligible(model,time){
  if(!model||typeof model.id!=='string'||model.id.length>200||!/^[a-z0-9][a-z0-9._-]*\/[^\s\u0000-\u001f]+$/i.test(model.id))return false;
  if(typeof model.name!=='string'||!model.name.trim()||model.name.length>400||/[\u0000-\u001f]/.test(model.name))return false;
  if(/:batch(?:$|:)/i.test(model.id)||model.deprecated===true||model.is_deprecated===true||/\bdeprecated\b/i.test(model.name))return false;
  if(model.expiration_date){const expires=Date.parse(model.expiration_date);if(!Number.isFinite(expires)||expires<=time)return false;}
  const {input_modalities:input,output_modalities:output}=model.architecture||{};
  return Array.isArray(input)&&input.includes('text')&&input.includes('image')
    &&Array.isArray(output)&&output.includes('text')
    &&Array.isArray(model.supported_parameters)&&model.supported_parameters.includes('tools');
}

export function createOpenRouterModelCatalog(){
  let cached=null,expiresAt=0,pending=null;
  async function fetchModels(){
    try{
      // This public catalog request never receives saved credentials or model settings.
      const response=await fetch(CATALOG_URL,{headers:{Accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok||Number(response.headers.get('content-length'))>CATALOG_LIMIT){await response.body?.cancel();throw new Error('Unavailable catalog.');}
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>CATALOG_LIMIT)throw new Error('Oversized catalog.');chunks.push(chunk);}
      const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!Array.isArray(payload.data))throw new Error('Invalid catalog.');
      const time=Date.now(),unique=new Map();let validUntil=time+CACHE_TTL_MS;
      for(const model of payload.data)if(eligible(model,time)){
        unique.set(model.id,{id:model.id,name:model.name.trim(),provider:model.id.split('/')[0]});
        if(model.expiration_date)validUntil=Math.min(validUntil,Date.parse(model.expiration_date));
      }
      const models=[...unique.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
      if(!models.length)throw new Error('Empty catalog.');
      return {models,validUntil};
    }catch{throw Object.assign(new Error('Could not load OpenRouter models. Try again.'),{statusCode:502});}
  }
  async function load(){
    if(cached&&expiresAt>Date.now())return cached;
    pending ||= fetchModels().then(({models,validUntil})=>{cached=models;expiresAt=validUntil;return models;}).finally(()=>{pending=null;});
    return pending;
  }
  return {
    async view(preferredModel){
      const models=await load();
      const defaultModel=[preferredModel,DEFAULT_MODEL].find(id=>models.some(model=>model.id===id))||models[0].id;
      return {models:structuredClone(models),defaultModel};
    },
  };
}
