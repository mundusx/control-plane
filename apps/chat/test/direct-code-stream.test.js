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
