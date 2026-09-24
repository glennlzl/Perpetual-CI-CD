import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';

// One byte range per request, as <video> seeking sends; any other Range header gets the whole file.
export function byteRange(header,size){
  const m=/^bytes=(\d*)-(\d*)$/.exec(header||'');
  if(!m||(!m[1]&&!m[2])||(m[1]&&m[2]&&Number(m[2])<Number(m[1])))return null;
  if(!m[1])return Number(m[2])?{start:Math.max(0,size-Number(m[2])),end:size-1}:'unsatisfiable';
  const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),size-1):size-1;
  return start>=size?'unsatisfiable':{start,end};
}

export async function sendVideo(req,res,{path,size}){
  const range=byteRange(req.headers.range,size);
  res.setHeader('Content-Type','video/webm');res.setHeader('Accept-Ranges','bytes');
  if(range==='unsatisfiable'){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
  const {start,end}=range||{start:0,end:size-1};
  res.writeHead(range?206:200,{'Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  // A viewer seeking elsewhere aborts this response.
  await pipeline(createReadStream(path,{start,end}),res).catch(()=>{});
}
