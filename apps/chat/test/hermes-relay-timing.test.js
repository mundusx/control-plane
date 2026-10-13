import test from 'node:test';
import assert from 'node:assert/strict';
import {relayNativeHermesToolStream,configFromEnv,resetAgentProviderCircuits} from '../src/main.js';
const encoder=new TextEncoder();
const event='data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
function response(){return {writableEnded:false,chunks:[],writeHead(){},flushHeaders(){},write(v){this.chunks.push(Buffer.from(v).toString());return true},end(){this.writableEnded=true}}}
const config=()=>configFromEnv({MUNDUSX_AGENT_MODEL_BASE_URLS:'https://primary.test/v1,https://backup.test/v1'});
test('Hermes relay reports timings without logging messages or credentials',async()=>{
 resetAgentProviderCircuits();const r=response(),timings=[];
 await relayNativeHermesToolStream(r,{request_id:'turn-1',messages:[{role:'user',content:'private project prompt'}],tools:[{}]},config(),async()=>new Response(event+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),t=>timings.push(t));
 assert.equal(timings.length,1);assert.equal(timings[0].outcome,'completed');assert.equal(timings[0].request_id,'turn-1');assert.ok(timings[0].first_event_ms>=0);assert.ok(!JSON.stringify(timings).includes('private project prompt'));assert.ok(r.chunks.join('').includes('hello'));
});
test('Hermes relay never exposes an interrupted tool turn',async()=>{
 resetAgentProviderCircuits();const r=response(),timings=[];let calls=0,pulls=0;
 await assert.rejects(relayNativeHermesToolStream(r,{messages:[],tools:[{}]},config(),async()=>{calls++;return new Response(new ReadableStream({pull(c){if(pulls++===0)c.enqueue(encoder.encode(event));else c.error(new Error('socket failed'));}}),{headers:{'content-type':'text/event-stream'}})},t=>timings.push(t)),/providers failed/);
 assert.equal(calls,2);assert.equal(timings[0].outcome,'providers_failed');assert.equal(r.chunks.length,0);
});
test('disconnecting the project runner aborts its upstream model request',async()=>{
 resetAgentProviderCircuits();const {EventEmitter}=await import('node:events');const r=Object.assign(new EventEmitter(),response());const timings=[];let aborted=false;
 await relayNativeHermesToolStream(r,{messages:[],tools:[{}]},config(),async(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'))},{once:true});queueMicrotask(()=>r.emit('close'));}),t=>timings.push(t));
 assert.equal(aborted,true);assert.equal(timings[0].outcome,'cancelled');assert.equal(r.listenerCount('close'),0);
});
