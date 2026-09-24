import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {startServer} from '../src/server.mjs';

function controllerChild(t,dataDir,{barrier=false}={}){
  const script=`
    import {startServer} from ${JSON.stringify(new URL('../src/server.mjs',import.meta.url).href)};
    let app;
    process.on('message',async message=>{
      if(message==='start'){
        try{app=await startServer({port:0,dataDir:process.argv[1]});process.send({url:app.url});}
        catch(error){process.send({error:error.code||error.message});}
      }
      if(message==='close'){await app?.close();process.exit(0);}
    });
    process.send({waiting:true});
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,dataDir],{stdio:['ignore','ignore','ignore','ipc']});
  const waiting=once(child,'message');
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  });
  return {child,ready:waiting.then(async()=>{
    if(barrier)return;
    const result=once(child,'message');child.send('start');return (await result)[0];
  })};
}

test('a second controller cannot open the same data while its owner is active',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-owner-'));
  const dataDir=join(dir,'data');let first,second,restarted;
  t.after(async()=>{await Promise.all([first?.close(),second?.close(),restarted?.close()]);await rm(dir,{recursive:true,force:true});});
  await mkdir(join(dir,'repo'));await writeFile(join(dir,'repo','package.json'),'{}');
  first=await startServer({port:0,repo:join(dir,'repo'),dataDir});
  await assert.rejects(async()=>{second=await startServer({port:0,dataDir});},/already.*(using|owns)|controller.*running/i);
  await first.close();
  restarted=await startServer({port:0,dataDir});
  assert.equal((await fetch(restarted.url+'/api/state')).status,200);
});

test('data-directory aliases cannot bypass controller ownership',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-alias-'));
  await mkdir(join(dir,'actual'));await symlink(join(dir,'actual'),join(dir,'alias'));
  let first,second;
  t.after(async()=>{await Promise.all([first?.close(),second?.close()]);await rm(dir,{recursive:true,force:true});});
  first=await startServer({port:0,dataDir:join(dir,'actual')});
  await assert.rejects(async()=>{second=await startServer({port:0,dataDir:join(dir,'alias')});},/already.*(using|owns)|controller.*running/i);
});

test('an abrupt owner exit permits recovery of its persisted pipeline',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-recover-')),dataDir=join(dir,'data'),repo=join(dir,'repo');
  let restarted;
  t.after(async()=>{await restarted?.close();await rm(dir,{recursive:true,force:true});});
  await mkdir(repo);await writeFile(join(repo,'package.json'),'{}');
  const owner=controllerChild(t,dataDir),{url}=await owner.ready;
  const {token}=await (await fetch(url+'/api/session')).json();
  const post=(path,value)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perpetual-Token':token},body:JSON.stringify(value)});
  assert.equal((await post('/api/scan',{path:repo})).status,200);
  const added=await post('/api/pipeline/action',{repoPath:repo,action:'add-stage',name:'Beta'});
  assert.equal(added.status,200);
  const before=(await added.json()).pipeline;
  const other=controllerChild(t,dataDir);
  assert.equal((await other.ready).error,'CONTROLLER_ALREADY_RUNNING');
  const exited=once(owner.child,'exit');owner.child.kill('SIGKILL');await exited;
  restarted=await startServer({port:0,dataDir});
  assert.deepEqual((await (await fetch(restarted.url+'/api/state')).json()).pipeline,before);
});

test('simultaneous processes admit at most one controller and release rejected contenders',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-race-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const contenders=Array.from({length:4},()=>controllerChild(t,dir,{barrier:true}));
  await Promise.all(contenders.map(owner=>owner.ready));
  const decisions=contenders.map(({child})=>once(child,'message').then(([message])=>message));
  for(const {child} of contenders)child.send('start');
  const outcomes=await Promise.all(decisions);
  assert.ok(outcomes.filter(outcome=>outcome.url).length<=1,'Only one process may recover or write this data');
  for(const outcome of outcomes)if(!outcome.url)assert.equal(outcome.error,'CONTROLLER_ALREADY_RUNNING');
  await Promise.all(contenders.map(async({child})=>{const exited=once(child,'exit');child.send('close');await exited;}));
  const app=await startServer({port:0,dataDir:dir});await app.close();
});

test('failed startup releases ownership so a different port can retry',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-controller-start-failure-'));
  let first,retry;
  t.after(async()=>{await Promise.all([first?.close(),retry?.close()]);await rm(dir,{recursive:true,force:true});});
  first=await startServer({port:0,dataDir:join(dir,'first')});
  await assert.rejects(startServer({port:Number(new URL(first.url).port),dataDir:join(dir,'second')}),{code:'EADDRINUSE'});
  retry=await startServer({port:0,dataDir:join(dir,'second')});
  assert.equal((await fetch(retry.url+'/api/state')).status,200);
});
