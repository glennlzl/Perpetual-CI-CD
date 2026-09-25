import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {byteRange,sendVideo} from '../src/browser/video-file.ts';

test('a recording serves one requested byte range, as video seeking asks',()=>{
  assert.equal(byteRange(undefined,10),null);
  assert.deepEqual(byteRange('bytes=0-',10),{start:0,end:9});
  assert.deepEqual(byteRange('bytes=2-4',10),{start:2,end:4});
  assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});
  assert.deepEqual(byteRange('bytes=-30',10),{start:0,end:9});
  assert.deepEqual(byteRange('bytes=5-100',10),{start:5,end:9});
  for(const header of ['bytes=10-','bytes=12-20','bytes=-0'])assert.equal(byteRange(header,10),'unsatisfiable',header);
  // Anything else is answered with the whole file.
  for(const header of ['bytes=0-1,4-5','bytes=-','bytes=4-2','items=0-1','bytes=a-b'])assert.equal(byteRange(header,10),null,header);
});

test('recordings stream as webm with ranges, whole files and unsatisfiable ranges',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perpetual-video-')),path=join(dir,'page.webm');
  await writeFile(path,'0123456789');
  const server=createServer((req,res)=>sendVideo(req,res,{path,size:10}));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  // A server listening on a TCP port has an address.
  const get=(range?:string)=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`,{headers:range?{Range:range}:{}});
  let response=await get('bytes=2-4');
  assert.equal(response.status,206);
  assert.equal(response.headers.get('content-range'),'bytes 2-4/10');
  assert.equal(response.headers.get('content-type'),'video/webm');
  assert.equal(await response.text(),'234');
  response=await get();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('accept-ranges'),'bytes');
  assert.equal(response.headers.get('content-length'),'10');
  assert.equal(await response.text(),'0123456789');
  response=await get('bytes=10-');
  assert.equal(response.status,416);
  assert.equal(response.headers.get('content-range'),'bytes */10');
  assert.equal(await response.text(),'');
});
