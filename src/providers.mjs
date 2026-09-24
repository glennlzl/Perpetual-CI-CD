import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);

export function redact(input='') {
  return String(input)
    .replace(/(?:\u001b|\^\[)\[[0-9;]*m/g,'')
    .replace(/(Authorization\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)[^\s]+/gi,'$1[REDACTED]')
    .replace(/(["'])(\w*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)\w*)\1(\s*:\s*)(["'])([^\r\n]*?)\4/gi,'$1$2$1$3$4[REDACTED]$4')
    .replace(/(\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z_]*)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{10,}|AKIA[A-Z0-9]{16})\b/g,'[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[REDACTED]@');
}
export function parseGitHubRemote(remote='') {
  const match=String(remote).match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1] || null;
}
export function normalizeGitHubRuns(runs,sha) {
  return runs.map(r=>({id:String(r.id),name:r.name,status:r.status,conclusion:r.conclusion,sha:r.head_sha,url:r.html_url,branch:r.head_branch,createdAt:r.created_at,matchesCommit:!!sha&&r.head_sha===sha}));
}
async function gh(args) {
  const {stdout}=await exec('gh',args,{timeout:20000,maxBuffer:1024*1024,env:{...process.env,GH_PROMPT_DISABLED:'1'}});
  return stdout;
}
async function jsonFetch(url,options={}) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check credentials and scope.`);
  return response.json();
}
function disconnected(provider,detail) {return {provider,status:'not-connected',detail,runs:[]};}

export async function getProviderStatus(scan,env=process.env) {
  const github=async()=>{
    const repo=parseGitHubRemote(scan?.repo?.remote);
    if(!repo)return disconnected('GitHub','No GitHub remote detected. Create or connect a repository first.');
    try {
      const data=JSON.parse(await gh(['api',`repos/${repo}/actions/runs?per_page=12`]));
      return {provider:'GitHub',status:'connected',detail:'Read-only live workflow runs. Results from other commits do not verify this checkout.',observedAt:new Date().toISOString(),runs:normalizeGitHubRuns(data.workflow_runs||[],scan.repo.sha)};
    } catch {return disconnected('GitHub','Cannot read workflow runs. Check network access and gh auth login, or provide GH_TOKEN with Actions read permission.');}
  };
  const vercel=async()=>{
    if(!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID)return disconnected('Vercel','Set VERCEL_TOKEN and VERCEL_PROJECT_ID (comma-separated for multiple projects); optional VERCEL_TEAM_ID.');
    try {
      const runs=[];
      for(const project of env.VERCEL_PROJECT_ID.split(',').map(x=>x.trim()).filter(Boolean).slice(0,10)) {
        const params=new URLSearchParams({projectId:project,limit:'5'});if(env.VERCEL_TEAM_ID)params.set('teamId',env.VERCEL_TEAM_ID);
        const data=await jsonFetch(`https://api.vercel.com/v6/deployments?${params}`,{headers:{Authorization:`Bearer ${env.VERCEL_TOKEN}`}});
        for(const d of data.deployments||[]) {const sha=d.meta?.githubCommitSha;runs.push({id:d.uid,name:d.name,status:d.state,conclusion:d.state,sha,url:d.url?`https://${d.url}`:null,matchesCommit:!!sha&&sha===scan?.repo?.sha});}
      }
      return {provider:'Vercel',status:'connected',observedAt:new Date().toISOString(),detail:'Read-only deployment status. READY is not a business integration result.',runs};
    }catch(e){return disconnected('Vercel',redact(e.message));}
  };
  const railway=async()=>{
    if(!(env.RAILWAY_API_TOKEN||env.RAILWAY_TOKEN)||!env.RAILWAY_PROJECT_ID||!env.RAILWAY_ENVIRONMENT_ID)return disconnected('Railway','Set RAILWAY_API_TOKEN (account/workspace) or RAILWAY_TOKEN (project token), RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID.');
    try {
      const headers={'Content-Type':'application/json',...(env.RAILWAY_API_TOKEN?{Authorization:`Bearer ${env.RAILWAY_API_TOKEN}`}:{'Project-Access-Token':env.RAILWAY_TOKEN})};
      const data=await jsonFetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers,body:JSON.stringify({query:'query($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { id status createdAt meta } } } }',variables:{input:{projectId:env.RAILWAY_PROJECT_ID,environmentId:env.RAILWAY_ENVIRONMENT_ID}}})});
      if(data.errors?.length)throw new Error('Railway query failed. Check token scope, project and environment.');
      const runs=(data.data?.deployments?.edges||[]).map(({node:d})=>({id:d.id,name:d.meta?.serviceName||'Railway deployment',status:d.status,conclusion:d.status,sha:d.meta?.commitHash,createdAt:d.createdAt,matchesCommit:!!d.meta?.commitHash&&d.meta.commitHash===scan?.repo?.sha}));
      return {provider:'Railway',status:'connected',observedAt:new Date().toISOString(),detail:'Read-only deployment status. Service reachability and business checks are separate.',runs};
    }catch(e){return disconnected('Railway',redact(e.message));}
  };
  return Promise.all([github(),vercel(),railway()]);
}

export function diagnoseFailure(log) {
  const text=redact(log);
  const rules=[
    [/\b\w*(?:TOKEN|API_KEY|SECRET)\b.*(?:required|missing|not set)|(?:401|403|unauthorized|authentication failed)/i,'configuration','Credentials or permissions need attention. Supply them in the provider settings; a source patch cannot grant access.'],
    [/ERR_PNPM_OUTDATED_LOCKFILE|npm ci.*lock|lockfile.*(?:outdated|mismatch)/i,'dependency','Dependency manifest and lockfile disagree. Regenerate with the pinned package manager, then rerun the original build.'],
    [/timed? ?out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i,'availability','A dependency is unavailable or exceeded its deadline. Check the upstream service and target URL before changing code.'],
    [/AssertionError|TestingLibraryElementError|FAIL\s|expected .*received/i,'test-regression','An existing test failed. Reproduce this exact test and patch application code without weakening its assertion.'],
    [/error TS\d+|Type error:|Cannot find module/i,'build','Compilation or module resolution failed. Reproduce with the pinned toolchain and workspace root.']
  ];
  const rule=rules.find(([pattern])=>pattern.test(text));
  return {method:'rule-based',category:rule?.[1]||'unknown',summary:rule?.[2]||'Inspect the failed step and reproduce its unchanged command before changing code.'};
}
export async function getGitHubFailure(scan,runId) {
  const repo=parseGitHubRemote(scan?.repo?.remote);
  if(!repo||!/^\d+$/.test(String(runId)))throw new Error('Choose a GitHub workflow run from the connected repository.');
  const [rawJobs,rawLog]=await Promise.all([gh(['api',`repos/${repo}/actions/runs/${runId}/jobs`]),gh(['run','view',String(runId),'--repo',repo,'--log-failed'])]);
  const jobs=JSON.parse(rawJobs).jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion,failedSteps:j.steps.filter(s=>s.conclusion==='failure').map(s=>s.name)}));
  const log=redact(rawLog).split('\n').filter(l=>/AssertionError|TestingLibraryElementError|(?:\s|^)FAIL\s|##\[error\]|Error:|expected:|received:|timed? ?out/i.test(l)).slice(0,100).join('\n').slice(0,20000);
  return {runId:String(runId),jobs,log,diagnosis:diagnoseFailure(log),observedAt:new Date().toISOString()};
}
