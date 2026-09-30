import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {streamOpenAiChatCompletion, configFromEnv} from '../src/main.js';
const config=configFromEnv({MUNDUSX_CONTROL_PLANE_URL:'https://gateway.test'});
function output(){const r=new EventEmitter();r.writableEnded=false;r.chunks=[];r.writeHead=()=>{};r.flushHeaders=()=>{};r.write=v=>r.chunks.push(v);r.end=v=>{if(v)r.chunks.push(v);r.writableEnded=true;};return r;}
const frame=delta=>'data: '+JSON.stringify({id:'chatcmpl-test',choices:[{delta,finish_reason:null}]})+'\n\n';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
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
