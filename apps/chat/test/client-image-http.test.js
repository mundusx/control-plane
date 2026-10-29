import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServerApp, configFromEnv } from '../src/main.js';

const key='client-image-test-key-12345678901234567890';
const owner='11111111-1111-4111-8111-111111111111';
const tools=[{type:'function',function:{name:'run_in_terminal',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}}}];
async function start(t,server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
test('disabled image delivery preserves image prompts; unbound accounts cannot queue media',async t=>{
  let generated=0,modelCalls=0;
  const upstream=await start(t,createServer(async(req,res)=>{
    for await(const _ of req){} modelCalls++;res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Existing response'},finish_reason:'stop'}]}));
  }));
  for(const enabled of [false,true]) {
    const base=await start(t,createServerApp({...configFromEnv({MUNDUSX_CONTROL_PLANE_URL:upstream,MUNDUSX_CLIENT_IMAGE_DELIVERY_ENABLED:String(enabled)}),authStore:{},mediaService:{submit:()=>{generated++;throw Error('unexpected');}}}));
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tools,messages:[{role:'user',content:'Create an image of a cat'}]})});
    assert.equal(response.status,enabled?403:200);
  }
  assert.equal(generated,0);assert.equal(modelCalls,1);
});
test('normal native chat keeps the exact upstream protocol when client image delivery is enabled',async t=>{
  let sent,generated=0;
  const upstream=await start(t,createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;sent=JSON.parse(text);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Hello'},finish_reason:'stop'}]}));
  }));
  const config={...configFromEnv({MUNDUSX_CONTROL_PLANE_URL:upstream,MUNDUSX_CLIENT_IMAGE_DELIVERY_ENABLED:'true'}),authStore:{},mediaService:{submit:()=>{generated++;throw Error('not expected');}}};
  const base=await start(t,createServerApp(config));
  const body={messages:[{role:'user',content:'Hello'}],tools,stream:false};
  const result=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(result.status,200);assert.equal((await result.json()).choices[0].message.content,'Hello');
  assert.deepEqual(sent.messages,body.messages);assert.deepEqual(sent.tools,tools);assert.equal(generated,0);
});
test('image handoff preserves native calls in JSON and SSE and never runs client commands on the server',async t=>{
  let modelTurn,generated=0;
  const completion={id:'chatcmpl-image-save',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'save1',type:'function',function:{name:'run_in_terminal',arguments:'{"command":"client download"}'}}]},finish_reason:'tool_calls'}]};
  const upstream=await start(t,createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;modelTurn=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(completion));
  }));
  const mediaService={submit:async()=>{generated++;return {job_id:'image',state:'completed',client_delivery:{action:'download_to_workspace',execution_owner:'client',tool_names:['run_in_terminal']}};},result:async()=>({content_type:'image/png',download_url:'https://chat.example/generated.png',expires_at:'tomorrow'})};
  const base=await start(t,createServerApp({...configFromEnv({MUNDUSX_CONTROL_PLANE_URL:upstream,MUNDUSX_CLIENT_IMAGE_DELIVERY_ENABLED:'true'}),authStore:{mcpSession:async request=>request.headers.authorization===`Bearer ${key}`?{id:owner}:null},mediaService}));
  for(const stream of [false,true]) {
    const body={tools,stream,messages:[{role:'user',content:'<environment_info>The user\'s current OS is: Windows</environment_info>\n<workspace_info>\nI am working in a workspace with the following folders:\n- D:\\projects\\converter\nI am working in a workspace</workspace_info>'},{role:'user',content:'<context>Editor context</context>\n<userRequest>Generate an image of a cat and save it as assets/cat.png</userRequest>'}]};
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);
    if(stream) {const text=await response.text();assert.match(text,/"tool_calls"/);assert.match(text,/run_in_terminal/);assert.match(text,/data: \[DONE\]/);}
    else {const result=await response.json();assert.equal(result.choices[0].message.tool_calls[0].function.name,'run_in_terminal');assert.equal(result.mundusx.file_saved,false);}
    assert.equal(modelTurn,undefined);
  }
  assert.equal(generated,2);
});
