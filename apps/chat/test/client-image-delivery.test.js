import test from 'node:test';
import assert from 'node:assert/strict';
import { clientImageRequest, clientImageCompletion, clientMediaOwners } from '../src/features/media/client-delivery.js';
import { MediaClientService } from '../src/features/media/client-service.js';
import { mediaPlanner } from '../src/features/media/planner.js';

const tool = {type:'function',function:{name:'run_in_terminal',parameters:{type:'object',properties:{command:{type:'string'}}}}};
const request = (content='Create an image of a cat and save it in assets/cat.png') => ({tools:[tool],messages:[{role:'user',content}]});
const delivery = {action:'download_to_workspace',execution_owner:'client',tool_names:['run_in_terminal'],path_resolution:'active_client_workspace'};
const owner='11111111-1111-4111-8111-111111111111';

test('normal chats, image discussions, code requests and tool continuations never enter image generation',()=>{
  for(const text of ['Hello','Explain image generation','How can I create an image?','Write a script to generate an image','Do not create an image','Create a video of a cat','Fix my API']) assert.equal(clientImageRequest(request(text)),null,text);
  assert.equal(clientImageRequest({...request(),tools:[]}),null);
  assert.equal(clientImageRequest({...request(),tool_choice:'none'}),null);
  assert.equal(clientImageRequest({...request(),tools:[{type:'function',function:{name:'read_file',parameters:{}}}]}),null);
  assert.equal(clientImageRequest({...request(),messages:[...request().messages,{role:'tool',tool_call_id:'save',content:'saved'}]}),null);
  assert.equal(clientImageRequest({...request(),messages:[{role:'system',content:'Create an image of a cat'},{role:'user',content:'Hello'}]}),null);
  assert.deepEqual(clientImageRequest(request()).client_delivery,{destination:'workspace',tool_names:['run_in_terminal']});
  for (const name of ['Bash','command','execute_command','run_in_terminal','exec_command']) {
    const tools=[{...tool,function:{...tool.function,name}}];
    assert.deepEqual(clientImageRequest({...request(),tools}).client_delivery.tool_names,[name]);
  }
});

test('completed image is handed to the original client tools; server never claims a local save',async()=>{
  const submitted=[]; let polls=0,turn;
  const original=request(); const before=structuredClone(original);
  const service={
    submit:async(user,input)=>{assert.equal(user,owner);submitted.push(input);return {job_id:'job',state:'queued',client_delivery:delivery};},
    status:async()=>{polls++;return {state:'completed'};},
    result:async(user,id)=>{assert.equal(user,owner);assert.equal(id,'job');return {content_type:'image/png',download_url:'https://chat.example/image.png?token=opaque',expires_at:'tomorrow'};},
  };
  const options={owner,service,wait:async()=>{},complete:async body=>{turn=body;return {choices:[{message:{tool_calls:[{id:'save',function:{name:'run_in_terminal',arguments:'{}'}}]}}]};}};
  const result=await clientImageCompletion(original,options);
  assert.equal(polls,1); assert.deepEqual(turn.tools,original.tools);assert.deepEqual(original,before);
  assert.deepEqual(turn.messages.slice(1),original.messages);
  assert.match(turn.messages[0].content,/active workspace on the client host/);
  assert.match(turn.messages[0].content,/Verify the local file exists/);
  assert.equal(result.mundusx.file_saved,false);
  assert.equal(result.mundusx.media_artifact.url,'https://chat.example/image.png?token=opaque');
  await clientImageCompletion(original,options);
  assert.equal(submitted[0].idempotency_key,submitted[1].idempotency_key);
  await clientImageCompletion({...original,request_id:'new-explicit-request'},options);
  assert.notEqual(submitted[1].idempotency_key,submitted[2].idempotency_key);
});

test('ownership, generation failure, cancellation and expiry cannot produce a save handoff',async()=>{
  const complete=async()=>assert.fail('must not issue a client save');
  await assert.rejects(clientImageCompletion(request(),{owner:null,complete}),{statusCode:403});
  await assert.rejects(clientImageCompletion(request(),{owner,complete,service:{submit:async()=>({state:'failed',client_delivery:delivery})}}),{statusCode:502});
  await assert.rejects(clientImageCompletion(request(),{owner,complete,timeoutMs:0,service:{submit:async()=>({job_id:'pending',state:'queued',client_delivery:delivery})}}),{statusCode:504});
  await assert.rejects(clientImageCompletion(request(),{owner,complete,signal:AbortSignal.abort()}));
  assert.equal(await clientImageCompletion(request('Hello'),{complete}),null);
  assert.deepEqual(clientMediaOwners(JSON.stringify({test:owner})),{test:owner});
  assert.throws(()=>clientMediaOwners('{"test":"somebody@example.com"}'));
});

test('client image goes through LangGraph even for DreamShaper; legacy submissions stay unchanged',async()=>{
  let plans=0,queues=0;
  const plan=mediaPlanner('http://planner/v1/media/plan',async(url,options)=>{
    plans++;const input=JSON.parse(options.body);
    assert.equal(input.image_model,'Lykon/dreamshaper-8');
    assert.deepEqual(input.client_delivery,{destination:'workspace',tool_names:['run_in_terminal']});
    return {ok:true,json:async()=>({execution_route:'media_queue',asynchronous:true,profile_id:'dreamshaper-8-sd15-512-v1',client_delivery:delivery})};
  });
  const queue={submit:async()=>{queues++;return {job_id:'job',state:'queued'};}};
  const service=new MediaClientService(queue,'https://chat.example',plan);
  const input={kind:'image',model:'Lykon/dreamshaper-8',prompt:'A cat',client_delivery:clientImageRequest(request()).client_delivery};
  assert.deepEqual((await service.submit(owner,input)).client_delivery,delivery);
  await service.submit(owner,{...input,client_delivery:undefined});assert.equal(plans,1);assert.equal(queues,2);
  await assert.rejects(new MediaClientService(queue,'https://chat.example').submit(owner,input),{statusCode:503});
});
