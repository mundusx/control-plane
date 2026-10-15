import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {streamOpenAiChatCompletion, relayControlPlaneOpenAiStream, configFromEnv} from '../src/main.js';
const config=configFromEnv({MUNDUSX_CONTROL_PLANE_URL:'https://gateway.test'});
function output(){const r=new EventEmitter();r.writableEnded=false;r.chunks=[];r.writeHead=()=>{};r.flushHeaders=()=>{};r.write=v=>r.chunks.push(v);r.end=v=>{if(v)r.chunks.push(v);r.writableEnded=true;};return r;}
const frame=delta=>'data: '+JSON.stringify({id:'chatcmpl-test',choices:[{delta,finish_reason:null}]})+'\n\n';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('repetition stops upstream and reports failure instead of success',async()=>{
 const r=output();let cancelled=false;
 const section='\nNote:\nThis code assumes the system supports the mkdir syscall.\nExample Output:\nAfter running the code, a folder named my_folder will be created in the current directory with permissions 0755.\n';
 await streamOpenAiChatCompletion(r,{messages:[]},config,async()=>new Response(new ReadableStream({
  start(c){c.enqueue(new TextEncoder().encode(frame({content:section.repeat(3)})));},
  cancel(){cancelled=true;}
 })));
 assert.equal(cancelled,true);assert.equal(r.writableEnded,true);
 assert.match(r.chunks.join(''),/Response stopped because it began repeating/);
 assert.equal(r.chunks.join('').split('data: [DONE]').length-1,1);
});
test('code streams before completion and preserves messages and tool chunks',async()=>{
 let source,sent;const r=output();const messages=[{role:'system',content:'Client rules'},{role:'user',content:'Create a complete Java program'}];const tools=[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{}}}}];
 const task=streamOpenAiChatCompletion(r,{stream:true,messages,tools},config,async(_url,init)=>{sent=JSON.parse(init.body);return new Response(new ReadableStream({start(c){source=c;}}));});
 await tick();source.enqueue(new TextEncoder().encode(frame({content:'public class App {'})));await tick();
 assert.match(r.chunks.join(''),/public class App/);assert.equal(r.writableEnded,false);
 source.enqueue(new TextEncoder().encode(frame({tool_calls:[{index:0,id:'call1',type:'function',function:{name:'read_file',arguments:'{}'}}]})+'data: [DONE]\n\n'));source.close();await task;
 assert.deepEqual(sent.messages,messages);assert.deepEqual(sent.tools,tools);assert.match(r.chunks.join(''),/read_file/);
});
test('client disconnect cancels pending upstream body',async()=>{
 let signal,cancelled=false;const r=output();const task=streamOpenAiChatCompletion(r,{messages:[{role:'user',content:'Create a complete program'}]},config,async(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}));});await tick();r.emit('close');await task;assert.equal(signal.aborted,true);assert.equal(cancelled,true);assert.equal(r.listenerCount('close'),0);
});
test('upstream failure preserves HTTP error and cleans close listener',async()=>{
 const r=output();await assert.rejects(streamOpenAiChatCompletion(r,{messages:[]},config,async()=>new Response('Unavailable',{status:503})),e=>e.statusCode===503);assert.equal(r.listenerCount('close'),0);
});
test('truncated upstream emits a stream error instead of silent success',async()=>{
 const r=output();await streamOpenAiChatCompletion(r,{messages:[]},config,async()=>new Response(frame({content:'partial'})));assert.match(r.chunks.join(''),/mundusx_stream_error/);
});

test('DONE completes the response without waiting for upstream socket closure',async()=>{
 let cancelled=false;const r=output();
 const task=streamOpenAiChatCompletion(r,{messages:[]},config,async()=>new Response(new ReadableStream({
  start(c){c.enqueue(new TextEncoder().encode(frame({content:'complete'})+'data: [DONE]\n\n'));},
  cancel(){cancelled=true;}
 })));
 let timer;
 try { await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('relay waited for socket after DONE')),500);})]); }
 finally {clearTimeout(timer);}
 assert.equal(r.writableEnded,true);assert.equal(cancelled,true);
 assert.equal(r.chunks.join('').split('data: [DONE]').length-1,1);
 assert.doesNotMatch(r.chunks.join(''),/mundusx_stream_error/);
});

test('upstream transport reset before DONE returns an explicit incomplete-stream error',async()=>{
 let source;const r=output();
 const task=streamOpenAiChatCompletion(r,{messages:[]},config,async()=>new Response(new ReadableStream({start(c){source=c;}})));
 await tick();source.enqueue(new TextEncoder().encode(frame({content:'partial'})));await tick();
 source.error(new TypeError('terminated'));await task;
 assert.equal(r.writableEnded,true);
 assert.match(r.chunks.join(''),/interrupted before completion: terminated/);
 assert.equal(r.chunks.join('').split('data: [DONE]').length-1,1);
});

test('Continue file protocol streams arguments before completion through public relay',async()=>{
 let source;const r=output();
 const messages=[{role:'system',content:'<tool_use_instructions> TOOL_NAME: create_new_file BEGIN_ARG: contents'}];
 const task=streamOpenAiChatCompletion(r,{messages,stream:true},config,async()=>new Response(new ReadableStream({start(c){source=c;}})));
 await tick();source.enqueue(new TextEncoder().encode(frame({content:'```tool\nTOOL_NAME: create_new_file\nBEGIN_ARG: filepath\nhello.js\nEND_ARG\nBEGIN_ARG: contents\n// live code\n'})));await tick();
 assert.match(r.chunks.join(''),/tool_calls/);assert.match(r.chunks.join(''),/live code/);assert.equal(r.writableEnded,false);
 source.enqueue(new TextEncoder().encode(frame({content:'END_ARG\n```\n'})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));source.close();await task;
 const events=r.chunks.join('').split('\n\n').filter(s=>s.startsWith('data: {')).map(s=>JSON.parse(s.slice(6)));
 const calls=events.flatMap(e=>e.choices?.[0]?.delta?.tool_calls || []);
 assert.deepEqual(JSON.parse(calls.map(c=>c.function.arguments).join('')),{filepath:'hello.js',contents:'// live code'});
 assert.equal(events.at(-1).choices[0].finish_reason,'tool_calls');
});

function segment(content,reason){return new Response(frame({content})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:reason}]})+'\n\ndata: [DONE]\n\n');}

test('anchored code continuations preserve fence context and caller sampling',async()=>{
 const repeated='// This implementation provides create read update delete endpoints for student records. It validates request data and returns the appropriate HTTP response.\n';
 const first='```rust\n'+('// initial context\n'.repeat(25));
 for(const temperature of [undefined,0,0.7]) {
  const r=output();const requests=[];
  const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Provide a Rust CRUD API'}],...(temperature===undefined?{}:{temperature})},config,async(_url,init)=>{
   const body=JSON.parse(init.body);requests.push(body);
   return requests.length===1?segment(first,'length'):segment(first.slice(-256)+repeated.repeat(4)+'```\nDone.','stop');
  },{continueOnLength:true});
  assert.equal(requests.length,2);
  assert.equal(requests[1].temperature,temperature);
  assert.equal(Object.hasOwn(requests[1],'temperature'),temperature!==undefined);
  assert.equal(result.finishReason,'stop');
  assert.doesNotMatch(r.chunks.join(''),/mundusx_repetition_detected/);
 }
});

test('real prose loops still fail after a code continuation closes its fence',async()=>{
 const r=output();let requests=0;
 const first='```rust\n'+('// initial context\n'.repeat(25));
 const prose='This demonstration implements the student API with validation and structured responses. The server stores records in memory and supports the expected create read update and delete operations.\n';
 await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Provide a Rust CRUD API'}]},config,async()=>++requests===1?segment(first,'length'):segment(first.slice(-256)+'```\n'+prose.repeat(4),'stop'),{continueOnLength:true});
 assert.equal(requests,2);
 assert.match(r.chunks.join(''),/Response stopped because it began repeating/);
});

test('repetition cancels only the current resumable continuation segment',async()=>{
 const r=output();const calls=[];
 const first='Initial answer '+('unique context '.repeat(30));
 const prose='This demonstration implements the student API with validation and structured responses. The server stores records in memory and supports the expected create read update and delete operations.\n';
 await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Provide a Rust CRUD API'}]},config,async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/cancel'))return new Response('{}');
  const n=calls.length;
  const response=segment(n===1?first:first.slice(-256)+prose.repeat(4),n===1?'length':'stop');
  response.headers.set('x-mundusx-completion-id','segment-'+n);
  response.headers.set('x-mundusx-resume-token','test-resume-'+n);
  return response;
 },{continueOnLength:true});
 assert.equal(calls.length,3);
 assert.equal(calls[2].url,'https://gateway.test/v1/chat/completions/segment-2/cancel');
 assert.equal(calls[2].init.headers['X-MundusX-Resume-Token'],'test-resume-2');
 assert.match(r.chunks.join(''),/Response stopped because it began repeating/);
 assert.doesNotMatch(r.chunks.join(''),/test-resume/);
});

test('code loops cancel the first segment without starting continuations',async()=>{
 const r=output();const calls=[];
 const block='axum = "0.6.1"\nserde_json = "1.0"\ntokio = { version = "1.0", features = ["full"] }\ntokio_postgres = { version = "0.7", features = ["tls"] }\ntokio_rds = "0.1"\n';
 await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Provide a Rust CRUD API'}]},config,async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/cancel'))return new Response('{}');
  const response=segment('```toml\n'+block.repeat(8),'length');
  response.headers.set('x-mundusx-completion-id','looping-code');
  response.headers.set('x-mundusx-resume-token','test-loop-resume');
  return response;
 },{continueOnLength:true});
 assert.equal(calls.length,2);
 assert.equal(calls[1].url,'https://gateway.test/v1/chat/completions/looping-code/cancel');
 assert.equal(calls[1].init.headers['X-MundusX-Resume-Token'],'test-loop-resume');
 assert.match(r.chunks.join(''),/Response stopped because it began repeating/);
});

test('duplicate JSON property loops cancel before any continuation',async()=>{
 const r=output();const calls=[];
 await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Provide a TypeScript CRUD API'}]},config,async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/cancel'))return new Response('{}');
  const response=segment('```json\n{\n'+('    "strictPropertyInitialization": true,\n'.repeat(30)),'length');
  response.headers.set('x-mundusx-completion-id','looping-json');
  response.headers.set('x-mundusx-resume-token','test-json-resume');
  return response;
 },{continueOnLength:true});
 assert.equal(calls.length,2);
 assert.equal(calls[1].url,'https://gateway.test/v1/chat/completions/looping-json/cancel');
 assert.match(r.chunks.join(''),/Response stopped because it began repeating/);
});

test('new fenced continuation after prose starts on its own line',async()=>{
 const r=output();let requests=0;const first='Setup instructions for the student API.\n3. Install dependencies';
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Create the API'}]},config,async()=>++requests===1?segment(first,'length'):segment('```bash\nnpm install\n```','stop'),{continueOnLength:true});
 assert.equal(result.content,first+'\n\n```bash\nnpm install\n```');
 assert.equal(result.finishReason,'stop');
});
test('restarted controller is discarded before a valid continuation is attached',async()=>{
 const r=output();let requests=0;
 const controller="```javascript\nconst Student = require('../models/Student');\n// Get all students\nexports.getAllStudents = async (req, res) => {};\n```";
 const first=controller+'\n\n3. Install dependencies';
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Create the API'}]},config,async()=>{
  requests++;return requests===1?segment(first,'length'):requests===2?segment(controller,'stop'):segment(first.slice(-256)+'\n\n```bash\nnpm install\n```','stop');
 },{continueOnLength:true});
 assert.equal(requests,3);assert.equal(result.finishReason,'stop');
 assert.equal(result.content.split("const Student = require").length-1,1);
 assert.match(result.content,/dependencies\n\n```bash/);
});

test('presentation repair closes the actual outer and nested delimiters',async()=>{
 for(const [first,closing] of [['````rust\nfn main() {}','\n````\n'],['~~~rust\nfn main() {}','\n~~~\n'],['````markdown\n# README\n```bash\nnpm install','\n```\n````\n']]){
  const r=output();const result=await relayControlPlaneOpenAiStream(r,{messages:[]},config,async()=>segment(first,'stop'),{continueOnLength:true});
  assert.equal(result.content,first+closing);assert.equal(result.finishReason,'stop');
 }
});
test('an echoed anchor cannot unlock streaming of a restarted controller',async()=>{
 const r=output();let requests=0;
 const controller="```javascript\nconst Student = require('../models/Student');\n// Get all students\nexports.getAllStudents = async (req, res) => {};\n```";
 const first=controller+'\n\n3. Install dependencies';
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'Create the API'}]},config,async()=>{
  requests++;
  if(requests===1)return segment(first,'length');
  if(requests===3)return segment(first.slice(-256)+'\n\n```bash\nnpm install\n```','stop');
  const head=first.slice(-256)+"\n\n```javascript\nconst Student = require('../models/Student');\n";
  const tail='// Get all students\nexports.getAllStudents = async (req, res) => {};\n```';
  return new Response(frame({content:head})+frame({content:tail})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 },{continueOnLength:true});
 assert.equal(requests,3);assert.equal(result.content.split('const Student = require').length-1,1);
 assert.equal(r.chunks.join('').split('const Student = require').length-1,1);
 assert.equal(result.finishReason,'stop');
});
test('a new declared file may share its header with an earlier file',async()=>{
 const r=output();let n=0;
 const source='import express from "express";\nimport cors from "cors";\nconst app = express();\n';
 const first='## src/one.js\n```js\n'+source+'export default app;\n```';
 const second='\n\n## src/two.js\n```js\n'+source+'export const second = app;\n```';
 const result=await relayControlPlaneOpenAiStream(r,{messages:[]},config,async()=>++n===1?segment(first,'length'):segment(first.slice(-256)+second,'stop'),{continueOnLength:true});
 assert.equal(n,2);assert.equal(result.content,first+second);assert.equal(result.finishReason,'stop');
});

test('placeholder detection covers assembly without rejecting real code or documentation', async()=>{
 const {isPlaceholderOnlyCodeAnswer}=await import('../src/main.js');
 assert.equal(isPlaceholderOnlyCodeAnswer('```assembly\n;\nWindows console program using WinAPI\n```\nThis is intentionally simplified and incomplete since implementations depend on the platform.\n```\n```'),true);
 assert.equal(isPlaceholderOnlyCodeAnswer('```python\n# implementation goes here\n```'),true);
 assert.equal(isPlaceholderOnlyCodeAnswer('```python\nprint("hello")\n```'),false);
 assert.equal(isPlaceholderOnlyCodeAnswer('```markdown\n# Usage\n```'),false);
 assert.equal(isPlaceholderOnlyCodeAnswer('```rust\nfn main() {}\n```'),false);
 assert.equal(isPlaceholderOnlyCodeAnswer('```assembly\n   \n```'),true);
});

test('coding repetition cancels the failed job and replaces the answer once',async()=>{
 const r=output();let calls=0,cancels=0;const bodies=[];
 const loop='```rust\nfn main() {\n'+'.configure(web::scope("")'.repeat(100);
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'write Rust code'}]},config,async(url,init)=>{
  if(url.endsWith('/cancel')){cancels++;return new Response('{}');}
  bodies.push(JSON.parse(init.body));calls++;
  const content=calls===1?loop:'```rust\nfn main() { println!("Hello"); }\n```';
  return new Response(frame({content})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'x-mundusx-completion-id':'chatcmpl-'+calls,'x-mundusx-resume-token':'test-secret'}});
 },{continueOnLength:true,recoverCodeQuality:true});
 assert.equal(cancels,1);assert.equal(calls,2);assert.equal(result.finishReason,'stop');assert.match(result.content,/println!/);assert.doesNotMatch(result.content,/configure/);
 assert.match(r.chunks.join(''),/replace_content/);assert.equal(bodies[1].temperature,0.6);
});

test('placeholder regeneration is bounded and does not publish a successful placeholder',async()=>{
 const r=output();let calls=0;
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'write assembly'}]},config,async()=>{
  calls++;return new Response(frame({content:'```assembly\n; TODO implementation\n```'})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 },{continueOnLength:true,recoverCodeQuality:true});
 assert.equal(calls,2);assert.equal(result.finishReason,'error');assert.match(result.error,/placeholder after one retry/);
});

test('a second repeating answer fails without an unbounded retry loop',async()=>{
 const r=output();let calls=0,cancels=0;
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'write Rust'}]},config,async(url)=>{
  if(url.endsWith('/cancel')){cancels++;return new Response('{}');}
  calls++;return new Response(frame({content:'```rust\n'+'.configure(web::scope("")'.repeat(100)}),{headers:{'x-mundusx-completion-id':'chatcmpl-'+calls,'x-mundusx-resume-token':'test-secret'}});
 },{continueOnLength:true,recoverCodeQuality:true});
 assert.equal(calls,2);assert.equal(cancels,2);assert.equal(result.finishReason,'error');
});

test('failed cancellation prevents starting a replacement job',async()=>{
 const r=output();let calls=0;
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'write Rust'}]},config,async(url)=>{
  if(url.endsWith('/cancel'))return new Response('{}',{status:503});
  calls++;return new Response(frame({content:'```rust\n'+'.configure(web::scope("")'.repeat(100)}),{headers:{'x-mundusx-completion-id':'chatcmpl-1','x-mundusx-resume-token':'test-secret'}});
 },{continueOnLength:true,recoverCodeQuality:true});
 assert.equal(calls,1);assert.equal(result.finishReason,'error');
});

test('a prose-only refusal is preserved as incomplete rather than a successful coding result',async()=>{
 const r=output();let calls=0;
 const content='I cannot generate Windows x64 assembly. Instead, here is a high-level description.';
 const result=await relayControlPlaneOpenAiStream(r,{messages:[{role:'user',content:'write assembly'}]},config,async()=>{
  calls++;return new Response(frame({content})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 },{continueOnLength:true,recoverCodeQuality:true});
 assert.equal(calls,1);assert.equal(result.finishReason,'error');assert.equal(result.content,content);assert.match(result.error,/implementation is incomplete/);
});
