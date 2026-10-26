import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaClientService} from '../src/features/media/client-service.js';
import {MediaQueue} from '../src/features/media/queue.js';
import {EDIT_PROFILE,mediaQuote} from '../src/features/media/pricing.js';
import {mediaChatIntent} from '../src/features/media/chat-intent.js';
import {createOpenAiMediaHttpController} from '../src/features/media/openai-http.js';
import {eligibleMediaNode} from '../src/features/media/routing.js';
const id='11111111-1111-4111-8111-111111111111';

test('owned reference selects edit model; text generation stays separate',async()=>{
 let got;const service=new MediaClientService({submit:async(_,input)=>{got=input;return {job_id:id,state:'queued'}}},'https://chat.example',null,async({prompt,profile_id})=>{assert.equal(profile_id,EDIT_PROFILE);return {prompt:'Change only the background to blue. '+prompt}});
 await service.submit('owner',{kind:'image',prompt:'blue background',input_artifact_id:id,idempotency_key:id});
 assert.equal(got.profile_id,EDIT_PROFILE);assert.equal(got.input_artifact_id,id);assert.match(got.prompt,/Change only/);
 await assert.rejects(service.submit('owner',{kind:'image',model:'Qwen/Qwen-Image-Edit-2509',prompt:'blue'}),{statusCode:400});
 await assert.rejects(service.submit('owner',{kind:'image',model:'Lykon/dreamshaper-8',prompt:'blue',input_artifact_id:id}),{statusCode:400});
 assert.equal(mediaQuote(EDIT_PROFILE).operation,'image_edit');
});
test('reference ownership and expiry are checked before queue admission',async()=>{
 for(const expired of [false,true]) {
  let transactions=0;const queue=new MediaQueue({owned:async(artifact,owner)=>{assert.equal(owner,'other');if(!expired)throw Object.assign(Error('Not found'),{statusCode:404});return {media_available:false,content_type:'image/png'}},transaction:()=>{transactions++;}});
  await assert.rejects(queue.submit('other',{profile_id:EDIT_PROFILE,prompt:'edit',idempotency_key:id,input_artifact_id:id}),{statusCode:expired?422:404});assert.equal(transactions,0);
 }
});
test('editing admission needs separate verified profile and 48 GiB budget',()=>{
 const node={policy_allowed:true,state:'ready',updated_at:Date.now()/1000,worker_health:{healthy:true,media_profiles:[EDIT_PROFILE],media_budget_bytes:48*1024**3}};
 assert.equal(eligibleMediaNode(node,EDIT_PROFILE),true);node.worker_health.media_budget_bytes--;assert.equal(eligibleMediaNode(node,EDIT_PROFILE),false);
});
test('short edit instructions require a reference; discussion stays text',()=>{
 assert.equal(mediaChatIntent('change the background to blue',true)?.kind,'image');
 assert.equal(mediaChatIntent('change the background to blue'),null);
 assert.equal(mediaChatIntent('how should I change the background?',true),null);
 assert.equal(mediaChatIntent('do not change this image',true),null);
});
test('OpenAI edit endpoint uses owned reference and separate model',async()=>{
 let submitted;let response;
 const handler=createOpenAiMediaHttpController({authStore:{mcpSession:async()=>({id:'owner'})},readJsonBody:async()=>({prompt:'change background',input_artifact_id:id,model:'Qwen/Qwen-Image-Edit-2509'}),service:{submit:async(owner,input)=>{assert.equal(owner,'owner');submitted=input;return {job_id:id,state:'completed'}},result:async()=>({download_url:'https://chat.example/owned.png'})},sendJson:(_,status,body)=>{response={status,body}}});
 assert.equal(await handler({request:{method:'POST',headers:{}},response:{setHeader(){}},url:new URL('https://chat.example/v1/images/edits')}),true);
 assert.equal(response.status,200);assert.equal(submitted.input_artifact_id,id);assert.equal(submitted.model,'Qwen/Qwen-Image-Edit-2509');
});

test('queued image edits reserve PNG output with the edit dimensions',async()=>{
 const q=new MediaQueue({reserve:async(owner,m)=>{assert.equal(owner,'owner');assert.equal(m.content_type,'image/png');assert.equal(m.width,832);assert.equal(m.height,480);return {artifact_id:id}},transaction:async fn=>fn({query:async()=>({rows:[{status:'quoted'}]})})});
 q.lease=async()=>({owner_user_id:'owner',request:{profile_id:EDIT_PROFILE}});
 assert.equal((await q.reserve('node',{job_id:id,lease_token:'lease',metadata:{byte_size:100,sha256:'x'}})).artifact_id,id);
});
