import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaQuote,DREAMSHAPER_PROFILE,IMAGE_PROFILE} from '../src/features/media/pricing.js';
import {eligibleMediaNode} from '../src/features/media/routing.js';
import {MediaClientService} from '../src/features/media/client-service.js';
const ready=()=>({policy_allowed:true,state:'ready',updated_at:Date.now()/1000,worker_health:{healthy:true,media_profiles:[DREAMSHAPER_PROFILE],media_budget_bytes:8*1024**3}});
test('DreamShaper gets its own fixed workflow and measured quote',()=>{
 const q=mediaQuote(DREAMSHAPER_PROFILE);assert.equal(q.model,'Lykon/dreamshaper-8');assert.equal(q.width,512);assert.equal(q.height,512);assert.equal(q.steps,20);assert.equal(q.compute_credits,3);
 assert.equal(eligibleMediaNode(ready(),DREAMSHAPER_PROFILE),true);
 assert.equal(eligibleMediaNode(ready(),IMAGE_PROFILE),false);
 const low=ready();low.worker_health.media_budget_bytes--;assert.equal(eligibleMediaNode(low,DREAMSHAPER_PROFILE),false);
});
test('automatic image request uses eligible DreamShaper without changing explicit Qwen requests',async()=>{
 const requests=[];let plans=0;
 const queue={fleet:async()=>[ready()],submit:async(owner,input)=>{requests.push(input);return {job_id:'test',state:'queued'}}};
 const service=new MediaClientService(queue,'https://chat.example',async()=>{plans++;return {profile_id:IMAGE_PROFILE}});
 await service.submit('owner',{kind:'image',prompt:'teapot',idempotency_key:'id'});
 assert.equal(requests[0].profile_id,DREAMSHAPER_PROFILE);assert.equal(plans,0);
 await service.submit('owner',{kind:'image',model:'Qwen/Qwen-Image',prompt:'teapot',idempotency_key:'id2'});
 assert.equal(requests[1].profile_id,IMAGE_PROFILE);assert.equal(plans,1);
 await assert.rejects(service.submit('owner',{kind:'image',model:'unknown'}),{statusCode:400});
 assert(service.profiles().profiles.some(p=>p.profile_id===DREAMSHAPER_PROFILE));
});

test('DreamShaper qualification ignores changing free RAM but binds resource policy',async()=>{
 const {mediaFingerprint}=await import('../src/features/media/qualification.js');
 const device={public_key_hex:'key',agent_version:'0.2.51',backend:'cuda',contribution_percent:80,worker_health:{runtime_mode:'media',media_budget_bytes:8*1024**3,capabilities:{physical_memory_mb:32768,total_vram_mb:4096,usable_memory_mb:12000}}};
 const before=mediaFingerprint(device,DREAMSHAPER_PROFILE);
 device.worker_health.capabilities.usable_memory_mb=8000;assert.equal(mediaFingerprint(device,DREAMSHAPER_PROFILE),before);
 device.contribution_percent=70;assert.notEqual(mediaFingerprint(device,DREAMSHAPER_PROFILE),before);
});
