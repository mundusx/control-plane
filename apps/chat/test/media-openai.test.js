import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiMediaHttpController, videoObject } from '../src/features/media/openai-http.js';
import { mediaChatIntent } from '../src/features/media/chat-intent.js';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(service, authorized=true) {
  const out = { headers: {}, setHeader(k,v) { this.headers[k]=v; } };
  const handle = createOpenAiMediaHttpController({ service, authStore: { mcpSession:async()=>authorized?{id:'owner'}:null },
    readJsonBody:async req=>req.body, sendJson:(_,status,body)=>Object.assign(out,{status,body}), wait:async()=>{} });
  return { out, call:async(path,body,method='POST')=>handle({request:{method,headers:{},body},response:out,url:new URL('https://chat.example'+path)}) };
}
test('image waits for completion and returns ImagesResponse',async()=>{
  let polled=0;
  const f=fixture({submit:async(owner,input)=>{assert.equal(owner,'owner');assert.equal(input.kind,'image');return {job_id:id,state:'queued'};},
    status:async()=>{polled++;return {job_id:id,state:'completed'};}, result:async()=>({download_url:'https://chat.example/result.png'})});
  await f.call('/v1/images/generations',{model:'Qwen/Qwen-Image',prompt:'a cat'});
  assert.equal(f.out.status,200);assert.equal(polled,1);assert.deepEqual(f.out.body.data,[{url:'https://chat.example/result.png'}]);assert.equal(f.out.body.job_id,undefined);
});
test('video creation and polling expose SDK-compatible shape',async()=>{
  const job={job_id:id,state:'queued',quote:{model:'Wan-AI/Wan2.2-T2V-A14B',operation:'text_to_video',width:832,height:480,frames:161,fps:16}};
  const f=fixture({submit:async(owner,input)=>{assert.equal(input.duration_seconds,10);return job;},status:async()=>({...job,state:'running'})});
  await f.call('/v1/videos',{prompt:'a cat',seconds:'10',model:job.quote.model});
  assert.equal(f.out.status,200);assert.equal(f.out.body.object,'video');assert.equal(f.out.body.seconds,'10');assert.equal(f.out.body.id,id);
  await f.call('/v1/videos/'+id,undefined,'GET');assert.equal(f.out.body.status,'in_progress');assert.equal(f.out.body.progress,0);
  assert.equal(videoObject({...job,state:'completed'}).progress,100);
});
test('unsupported options are rejected before queueing',async()=>{
  const f=fixture({submit:async()=>assert.fail('must not queue')});
  for(const body of [{model:'gpt-image-1',prompt:'cat'},{n:2,prompt:'cat'},{size:'1024x1024',prompt:'cat'},{quality:'high',prompt:'cat'}]) {
    await f.call('/v1/images/generations',body);assert.equal(f.out.status,400);assert.equal(f.out.body.error.type,'invalid_request_error');
  }
  await f.call('/v1/videos',{prompt:'cat',seconds:'11'});assert.equal(f.out.status,400);
});
test('authentication and media type boundaries prevent disclosure',async()=>{
  const f=fixture({},false);await f.call('/v1/videos/'+id,undefined,'GET');assert.equal(f.out.status,401);
  const image=fixture({status:async()=>({state:'completed',quote:{operation:'text_to_image'}})});
  await image.call('/v1/videos/'+id+'/content',undefined,'GET');assert.equal(image.out.status,404);
});
test('multilingual requests preserve prompts and exclude questions and negations',()=>{
  for(const [prompt,kind] of [['Stwórz obraz kota','image'],['Wygeneruj wideo kota','video'],['Gumawa ng larawan ng pusa','image'],['Crea un vídeo de un gato','video'],['Crée une image de chat','image'],['Erstelle ein Video einer Katze','video'],['生成一个视频','video'],['画像を生成してください','image'],['Создай видео кота','video'],['أنشئ صورة لقطة','image'],['वीडियो बनाओ','video']]) {
    assert.equal(mediaChatIntent(prompt)?.kind,kind,prompt);assert.equal(mediaChatIntent(prompt).prompt,prompt);
  }
  for(const prompt of ['Nie twórz obrazu','Jak wygenerować wideo?','No crea un video','不要生成视频','Paano gumawa ng video?']) assert.equal(mediaChatIntent(prompt),null,prompt);
});


test('semantic fallback supports an unseen language and fails closed on unclear intent', async()=>{
 const { resolveMediaIntent } = await import('../src/features/media/intent-resolver.js');
 const text='Tengeneza video ya paka';
 const resolved=await resolveMediaIntent(text,async(message,instructions)=>{
   assert.equal(message,text);assert.match(instructions,/original language/);return {kind:'video',explicit_request:true,seconds:7};
 });
 assert.deepEqual(resolved,{kind:'video',prompt:text,duration_seconds:7});
 assert.equal(await resolveMediaIntent('Discuss visual art',async()=>({kind:'image',explicit_request:false})),null);
 assert.equal(await resolveMediaIntent('Unknown request',async()=>{throw Error('No LLM contributor');}),null);
 assert.ok((await resolveMediaIntent(text,async()=>({kind:'video',explicit_request:true,seconds:20}))).error);
});
