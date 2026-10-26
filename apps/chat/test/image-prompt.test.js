import test from 'node:test';
import assert from 'node:assert/strict';
import {imagePromptPlanner} from '../src/features/media/image-prompt.js';
import {mediaChatIntent} from '../src/features/media/chat-intent.js';
import {MediaClientService} from '../src/features/media/client-service.js';
import {DREAMSHAPER_PROFILE,IMAGE_PROFILE} from '../src/features/media/pricing.js';

test('logo generation routes to images while advice and negation remain conversation',()=>{
 for(const text of ['design and generate me a logo for mundusx','design a logo for MundusX','please generate a wordmark']) assert.equal(mediaChatIntent(text)?.kind,'image');
 for(const text of ['how do I design a logo?','explain logo design principles',"do not generate a logo"]) assert.equal(mediaChatIntent(text),null);
});
test('LLM enhances both image profiles before queueing without changing model or seed',async()=>{
 for(const [model,profile] of [['Lykon/dreamshaper-8',DREAMSHAPER_PROFILE],['Qwen/Qwen-Image',IMAGE_PROFILE]]) {
  const calls=[];const brief='Design a blue MundusX logo, no globe';
  const prepare=imagePromptPlanner(async(text,system)=>{calls.push('plan');assert.equal(text,brief);assert.match(system,model.startsWith('Qwen')?/Qwen Image/:/DreamShaper/);return {prompt:'Clean blue geometric M and X symbol with generous negative space.'};});
  const service=new MediaClientService({submit:async(owner,input)=>{calls.push('queue');assert.equal(owner,'owner');assert.equal(input.profile_id,profile);assert.equal(input.seed,17);assert(input.prompt.includes(brief));assert.match(input.prompt,/geometric/);return {job_id:'job',state:'queued'};}},'https://chat.example',null,prepare);
  await service.submit('owner',{kind:'image',model,prompt:brief,seed:17,idempotency_key:'same-key'});assert.deepEqual(calls,['plan','queue']);
 }
});
test('refusal, malformed output and unavailable LLM fall back without blocking image dispatch',async()=>{
 for(const generate of [async()=>{throw Error('offline')},async()=>'{bad',async()=>({prompt:"I cannot generate images directly, use Canva instead."})]) {
  const result=await imagePromptPlanner(generate)({prompt:'MundusX logo, no text',profile_id:DREAMSHAPER_PROFILE});
  assert.equal(result.source,'fallback');assert.match(result.prompt,/MundusX logo, no text/);assert.doesNotMatch(result.prompt,/Canva/);
 }
});
test('prompt preparation is time bounded and preserves maximum length briefs',async()=>{
 const planner=imagePromptPlanner(()=>new Promise(()=>{}),{timeoutMs:5});
 assert.equal((await planner({prompt:'blue teapot',profile_id:IMAGE_PROFILE})).source,'fallback');
 const original='x'.repeat(4000);assert.equal((await imagePromptPlanner(async()=>({prompt:'A composed visual treatment of the requested subject.'}))({prompt:original,profile_id:IMAGE_PROFILE})).prompt,original);
 await assert.rejects(planner({prompt:'x'.repeat(4001),profile_id:IMAGE_PROFILE}),{statusCode:400});
});
test('video bypasses image prompting',async()=>{
 let count=0;const service=new MediaClientService({submit:async()=>({job_id:'v',state:'queued'})},'https://chat.example',null,()=>{count++;throw Error('must not run')});
 await service.submit('owner',{kind:'video',prompt:'sunset'});assert.equal(count,0);
});
