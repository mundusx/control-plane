import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaClientService } from '../src/features/media/client-service.js';
import { createMediaClientHttpController } from '../src/features/media/client-http.js';

const id = '11111111-1111-4111-8111-111111111111';
test('client contract bounds durations, maps image/video profiles and does not poll the GPU', async () => {
  const submitted = [];
  const service = new MediaClientService({ async submit(owner, input) {
    submitted.push({owner, input}); return {job_id:id,state:'queued'};
  } }, 'https://chat.example');
  for (let seconds=1;seconds<=10;seconds++) {
    const result = await service.submit('owner',{kind:'video',duration_seconds:seconds,prompt:'test',idempotency_key:id});
    assert.equal(result.poll_after_seconds,30);
    assert.equal(result.terminal,false);
    assert.equal(result.status_url,`https://chat.example/v1/media/jobs/${id}`);
    assert.equal(submitted.at(-1).input.profile_id,`wan22-14b-480p-${seconds*16+1}f-v1`);
  }
  await service.submit('owner',{kind:'image',prompt:'test',idempotency_key:id});
  assert.equal(submitted.at(-1).input.profile_id,'qwen-image-fp8-832x480-v1');
  for (const duration_seconds of [0,11,2.5,'5']) await assert.rejects(service.submit('owner',{kind:'video',duration_seconds}),{statusCode:400});
  await assert.rejects(service.submit('owner',{kind:'image',duration_seconds:5}),{statusCode:400});
});

test('status does not rotate links; result checks ownership, completion and expiry',async()=>{
  let state='running',available=true,rotations=0;
  const service=new MediaClientService({
    async owned(owner,job) {
      if(owner!=='owner') throw Object.assign(new Error('Not found'),{statusCode:404});
      return {job_id:job,state,artifact_id:id,artifact:{media_available:available}};
    },
    store:{async renewLink(artifact,owner) {
      assert.equal(owner,'owner'); rotations++;
      return {download_path:'/media/result?token=secret',preview_path:'/media/result?token=secret&inline=1',expires_at:'tomorrow',content_type:'image/png'};
    }},
  },'https://chat.example');
  await assert.rejects(service.result('other',id),{statusCode:404});
  await assert.rejects(service.result('owner',id),{statusCode:409});
  state='completed';
  assert.equal((await service.status('owner',id)).terminal,true);
  assert.equal(rotations,0);
  assert.equal((await service.result('owner',id)).download_url,'https://chat.example/media/result?token=secret');
  assert.equal(rotations,1);
  const chatResult = await service.result('owner',id,{ownerOnly:true});
  assert.equal(chatResult.preview_url, `/media/owned/${id}/image.png?inline=1`);
  assert.equal(chatResult.download_url, `/media/owned/${id}/image.png`);
  assert.equal(rotations,1);
  assert.deepEqual(await service.result('owner',id,{ownerOnly:true}), chatResult);
  assert.equal(rotations,1);
  available=false;
  await assert.rejects(service.result('owner',id),{statusCode:410});
  assert.equal(rotations,1);
});

test('HTTP actions require a user token and return 202 with polling location',async()=>{
  let session=null,called=false;
  const headers={},response={setHeader:(key,value)=>headers[key]=value};
  const results=[];
  const controller=createMediaClientHttpController({
    authStore:{mcpSession:async()=>session},readJsonBody:async()=>({kind:'image'}),
    service:{submit:async owner=>{called=true;assert.equal(owner,'owner');return {job_id:id,status_url:`https://chat.example/v1/media/jobs/${id}`};}},
    sendJson:(response,status,body)=>results.push({status,body}),
  });
  const request={method:'POST'},url=new URL('https://chat.example/v1/media/jobs');
  await assert.rejects(controller({request,response,url}),{statusCode:401});
  assert.equal(called,false);
  session={id:'owner'};
  assert.equal(await controller({request,response,url}),true);
  assert.equal(results[0].status,202);
  assert.equal(headers.Location,results[0].body.status_url);
  assert.equal(headers['Retry-After'],'30');
});
