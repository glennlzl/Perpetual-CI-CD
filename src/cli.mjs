#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './scanner.mjs';
import { startServer } from './server.mjs';
import { getProviderStatus, getGitHubFailure, redact } from './providers.mjs';

const args=process.argv.slice(2),command=args.shift()||'help';
const option=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
// An absent option stays undefined so the called module's default applies.
const number=name=>{const value=option(name);return value===undefined?undefined:Number(value);};
const repo=resolve(option('repo',process.cwd())),dataDir=resolve(option('data','.perpetual'));
const output=data=>console.log(JSON.stringify(data,null,2));
async function main(){
  if(command==='serve') {
    const app=await startServer({port:number('port'),repo,dataDir});
    console.log(`Perpetual is ready at ${app.url}\nRepository: ${repo}`);
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});return;
  }
  if(command==='scan')return output(await scanRepository(repo));
  if(command==='sandbox') {
    const cua=await import('./sandbox/cua.mjs');
    const action=args[0],id=option('id',''),context={dataDir,id};
    if(action==='create')return output(await cua.createSandbox({dataDir,image:option('image'),cpus:number('cpus'),memoryMiB:number('memory')}));
    if(action==='list')return output(await cua.listSandboxes({dataDir}));
    if(action==='inspect')return output(await cua.inspectSandbox(context));
    if(action==='destroy')return output(await cua.destroySandbox(context));
    if(action==='exec') {
      const result=await cua.executeSandbox({...context,command:option('command',''),timeoutSeconds:number('timeout')});
      output(result);if(result.returncode!==0)process.exitCode=1;return;
    }
    if(action==='screenshot')return output(await cua.screenshotSandbox({...context,output:option('output','')}));
    if(action==='upload')return output(await cua.uploadSandboxFile({...context,input:option('input',''),destination:option('to','')}));
    if(action==='download')return output(await cua.downloadSandboxFile({...context,source:option('from',''),output:option('output','')}));
    if(action==='act')return output(await cua.sandboxAction({...context,action:JSON.parse(option('action','{}'))}));
    if(action==='mcp') {
      process.exitCode=await cua.runSandboxMcp({...context,driverPath:option('driver-path'),user:option('user')});return;
    }
    throw new Error('Use sandbox create, list, inspect, destroy, exec, screenshot, upload, download, act, or mcp.');
  }
  if(command==='providers')return output(await getProviderStatus(await scanRepository(repo)));
  if(command==='failure')return output(await getGitHubFailure(await scanRepository(repo),option('run','')));
  if(command==='init-ci') {
    const scan=await scanRepository(repo);
    if(scan.workflows.length)throw new Error('Existing workflows detected. Reuse the current CI; no new workflow was generated.');
    if(!scan.plan?.workflow)throw new Error('No supported build workflow can be generated for this repository.');
    const path=resolve(option('output',join(dataDir,'exports','perpetual-ci.yml')));await mkdir(dirname(path),{recursive:true});await writeFile(path,scan.plan.workflow,{flag:'wx'});console.log(`Review this starter workflow before adding it to your repository: ${path}`);return;
  }
  console.log(`Perpetual 0.1 — local release control room\n\n  perpetual serve --repo /path/to/repo [--port 4317]\n  perpetual scan --repo /path/to/repo\n  perpetual providers --repo /path/to/repo\n  perpetual failure --repo /path/to/repo --run RUN_ID\n  perpetual init-ci --repo /path/to/repo [--output file]\n  perpetual sandbox create [--image IMAGE] [--cpus 2] [--memory 4096]\n  perpetual sandbox list\n  perpetual sandbox inspect --id ID\n  perpetual sandbox exec --id ID --command 'guest command'\n  perpetual sandbox screenshot --id ID --output screenshot.png\n  perpetual sandbox mcp --id ID [--driver-path /guest/path/cua-driver]\n  perpetual sandbox destroy --id ID\n\nUse --data PATH to choose where local reports and history are stored.\nQuickstart: ${resolve(dirname(fileURLToPath(import.meta.url)),'../README.md')}`);
}
main().catch(error=>{console.error(redact(error.message));if(error.sandboxId)console.error(`Sandbox: ${error.sandboxId}`);process.exitCode=1;});
