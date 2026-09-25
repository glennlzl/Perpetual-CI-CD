import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Scan } from './scanner.ts';
const exec=promisify(execFile);

// Provider API responses are external data, read as unknown: each list must be a list of objects, or the reply is of
// another shape and throws inside the caller's try/catch, so the provider is not connected; each field is text or null.
interface GitHubJobsJson { jobs: { id?: unknown; name?: unknown; conclusion?: unknown; steps: { name?: unknown; conclusion?: unknown }[] }[] }
const isRecord=(value: unknown): value is Record<string, unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const text=(value: unknown,limit=500)=>typeof value==='string'?value.slice(0,limit):null;
const field=(value: unknown,key: string)=>isRecord(value)?value[key]:undefined;
function records(value: unknown,provider: string): Record<string, unknown>[] {
  if(!Array.isArray(value)||!value.every(isRecord))throw new Error(`${provider} returned an unreadable reply.`);
  return value;
}
// The failed-run reader has no caller-side try/catch, so its job list is checked here.
const isJobs=(value: unknown): value is GitHubJobsJson=>isRecord(value)&&Array.isArray(value.jobs)&&value.jobs.every(job=>isRecord(job)&&Array.isArray(job.steps)&&job.steps.every(isRecord));
export interface ProviderRun { id: string | null; name: string | null; status: string | null; conclusion: string | null; sha: string | null; url?: string | null; branch?: string | null; createdAt?: string | null; matchesCommit: boolean }
export interface ProviderStatus { provider: string; status: 'connected' | 'not-connected'; detail: string; observedAt?: string; runs: ProviderRun[] }
export interface FailureDiagnosis { method: 'rule-based'; category: string; summary: string }

export function redact(input: unknown=''): string {
  return String(input)
    .replace(/(?:\u001b|\^\[)\[[0-9;]*m/g,'')
    .replace(/(Authorization\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)[^\s]+/gi,'$1[REDACTED]')
    .replace(/(["'])(\w*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)\w*)\1(\s*:\s*)(["'])([^\r\n]*?)\4/gi,'$1$2$1$3$4[REDACTED]$4')
    .replace(/(\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z_]*)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{10,}|AKIA[A-Z0-9]{16})\b/g,'[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[REDACTED]@');
}
export function parseGitHubRemote(remote: unknown=''): string | null {
  const match=String(remote).match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1] || null;
}
export function normalizeGitHubRuns(runs: unknown,sha: unknown): ProviderRun[] {
  return records(runs,'GitHub').map(r=>{
    if(typeof r.id!=='number'&&typeof r.id!=='string')throw new Error('GitHub returned an unreadable reply.');
    const head=text(r.head_sha);
    return {id:String(r.id),name:text(r.name),status:text(r.status),conclusion:text(r.conclusion),sha:head,url:text(r.html_url),branch:text(r.head_branch),createdAt:text(r.created_at),matchesCommit:!!sha&&head===sha};
  });
}
async function gh(args: string[]) {
  const {stdout}=await exec('gh',args,{timeout:20000,maxBuffer:1024*1024,env:{...process.env,GH_PROMPT_DISABLED:'1'}});
  return stdout;
}
async function jsonFetch(url: string,options: RequestInit={}): Promise<unknown> {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check credentials and scope.`);
  return response.json();
}
function disconnected(provider: string,detail: string): ProviderStatus {return {provider,status:'not-connected',detail,runs:[]};}

export async function getProviderStatus(scan: Pick<Scan,'repo'>,env: NodeJS.ProcessEnv=process.env): Promise<ProviderStatus[]> {
  const github=async(): Promise<ProviderStatus>=>{
    const repo=parseGitHubRemote(scan?.repo?.remote);
    if(!repo)return disconnected('GitHub','No GitHub remote detected. Create or connect a repository first.');
    try {
      const data: unknown=JSON.parse(await gh(['api',`repos/${repo}/actions/runs?per_page=12`]));
      return {provider:'GitHub',status:'connected',detail:'Read-only live workflow runs. Results from other commits do not verify this checkout.',observedAt:new Date().toISOString(),runs:normalizeGitHubRuns(field(data,'workflow_runs'),scan.repo.sha)};
    } catch {return disconnected('GitHub','Cannot read workflow runs. Check network access and gh auth login, or provide GH_TOKEN with Actions read permission.');}
  };
  const vercel=async(): Promise<ProviderStatus>=>{
    if(!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID)return disconnected('Vercel','Set VERCEL_TOKEN and VERCEL_PROJECT_ID (comma-separated for multiple projects); optional VERCEL_TEAM_ID.');
    try {
      const runs: ProviderRun[]=[];
      for(const project of env.VERCEL_PROJECT_ID.split(',').map(x=>x.trim()).filter(Boolean).slice(0,10)) {
        const params=new URLSearchParams({projectId:project,limit:'5'});if(env.VERCEL_TEAM_ID)params.set('teamId',env.VERCEL_TEAM_ID);
        const data=await jsonFetch(`https://api.vercel.com/v6/deployments?${params}`,{headers:{Authorization:`Bearer ${env.VERCEL_TOKEN}`}});
        for(const d of records(field(data,'deployments'),'Vercel')) {
          const sha=text(field(d.meta,'githubCommitSha')),state=text(d.state),url=text(d.url);
          runs.push({id:text(d.uid),name:text(d.name),status:state,conclusion:state,sha,url:url?`https://${url}`:null,matchesCommit:!!sha&&sha===scan?.repo?.sha});
        }
      }
      return {provider:'Vercel',status:'connected',observedAt:new Date().toISOString(),detail:'Read-only deployment status. READY is not a business integration result.',runs};
    }catch(e){return disconnected('Vercel',redact((e as Error).message));}
  };
  const railway=async(): Promise<ProviderStatus>=>{
    if(!(env.RAILWAY_API_TOKEN||env.RAILWAY_TOKEN)||!env.RAILWAY_PROJECT_ID||!env.RAILWAY_ENVIRONMENT_ID)return disconnected('Railway','Set RAILWAY_API_TOKEN (account/workspace) or RAILWAY_TOKEN (project token), RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID.');
    try {
      const headers={'Content-Type':'application/json',...(env.RAILWAY_API_TOKEN?{Authorization:`Bearer ${env.RAILWAY_API_TOKEN}`}:{'Project-Access-Token':env.RAILWAY_TOKEN!})};
      const data=await jsonFetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers,body:JSON.stringify({query:'query($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { id status createdAt meta } } } }',variables:{input:{projectId:env.RAILWAY_PROJECT_ID,environmentId:env.RAILWAY_ENVIRONMENT_ID}}})});
      const errors=field(data,'errors');
      if(errors!==undefined&&errors!==null&&(!Array.isArray(errors)||errors.length))throw new Error('Railway query failed. Check token scope, project and environment.');
      const runs=records(field(field(field(data,'data'),'deployments'),'edges'),'Railway').map(edge=>{
        if(!isRecord(edge.node))throw new Error('Railway returned an unreadable reply.');
        const d=edge.node,sha=text(field(d.meta,'commitHash')),status=text(d.status);
        return {id:text(d.id),name:text(field(d.meta,'serviceName'))||'Railway deployment',status,conclusion:status,sha,createdAt:text(d.createdAt),matchesCommit:!!sha&&sha===scan?.repo?.sha};
      });
      return {provider:'Railway',status:'connected',observedAt:new Date().toISOString(),detail:'Read-only deployment status. Service reachability and business checks are separate.',runs};
    }catch(e){return disconnected('Railway',redact((e as Error).message));}
  };
  return Promise.all([github(),vercel(),railway()]);
}

export function diagnoseFailure(log: unknown): FailureDiagnosis {
  const text=redact(log);
  const rules: [RegExp,string,string][]=[
    [/\b\w*(?:TOKEN|API_KEY|SECRET)\b.*(?:required|missing|not set)|(?:401|403|unauthorized|authentication failed)/i,'configuration','Credentials or permissions need attention. Supply them in the provider settings; a source patch cannot grant access.'],
    [/ERR_PNPM_OUTDATED_LOCKFILE|npm ci.*lock|lockfile.*(?:outdated|mismatch)/i,'dependency','Dependency manifest and lockfile disagree. Regenerate with the pinned package manager, then rerun the original build.'],
    [/timed? ?out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i,'availability','A dependency is unavailable or exceeded its deadline. Check the upstream service and target URL before changing code.'],
    [/AssertionError|TestingLibraryElementError|FAIL\s|expected .*received/i,'test-regression','An existing test failed. Reproduce this exact test and patch application code without weakening its assertion.'],
    [/error TS\d+|Type error:|Cannot find module/i,'build','Compilation or module resolution failed. Reproduce with the pinned toolchain and workspace root.']
  ];
  const rule=rules.find(([pattern])=>pattern.test(text));
  return {method:'rule-based',category:rule?.[1]||'unknown',summary:rule?.[2]||'Inspect the failed step and reproduce its unchanged command before changing code.'};
}
export async function getGitHubFailure(scan: Pick<Scan,'repo'> | null,runId: unknown) {
  const repo=parseGitHubRemote(scan?.repo?.remote);
  if(!repo||!/^\d+$/.test(String(runId)))throw new Error('Choose a GitHub workflow run from the connected repository.');
  const [rawJobs,rawLog]=await Promise.all([gh(['api',`repos/${repo}/actions/runs/${runId}/jobs`]),gh(['run','view',String(runId),'--repo',repo,'--log-failed'])]);
  const listed: unknown=JSON.parse(rawJobs);
  if(!isJobs(listed))throw new Error('GitHub returned an unreadable job list.');
  const jobs=listed.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion,failedSteps:j.steps.filter(s=>s.conclusion==='failure').map(s=>s.name)}));
  const log=redact(rawLog).split('\n').filter(l=>/AssertionError|TestingLibraryElementError|(?:\s|^)FAIL\s|##\[error\]|Error:|expected:|received:|timed? ?out/i.test(l)).slice(0,100).join('\n').slice(0,20000);
  return {runId:String(runId),jobs,log,diagnosis:diagnoseFailure(log),observedAt:new Date().toISOString()};
}
