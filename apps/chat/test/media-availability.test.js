import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityAvailability} from '../src/features/media/availability.js';

const now=Date.now();
const profiles=['qwen-image-fp8-832x480-v1','wan22-14b-480p-49f-v1','wan22-i2v-lightning-14b-480p-81f-v3'];
const node={node_id:'gx10',public_key_hex:'key',state:'ready',policy_allowed:true,updated_at:String(now/1000),
  capabilities:{ready_for_jobs:false},worker_health:{runtime_mode:'media',healthy:true,media_budget_bytes:100*1024**3,media_profiles:profiles}};
const presence={node_id:'gx10',public_key_hex:'key',profiles,last_poll_at:new Date(now)};

test('availability separates image, T2V, I2V and LLM and reports verified durations',()=>{
  const a=capabilityAvailability([node],[presence],[],now);
  assert.equal(a.chat.state,'unavailable');
  for (const kind of ['image','video','image_to_video']) {assert.equal(a[kind].state,'available');assert.equal(a[kind].free_slots,1);}
  assert.deepEqual(a.video.duration_seconds,[3]);assert.deepEqual(a.image_to_video.duration_seconds,[5]);
});
test('installed profiles alone, stale polls, paused policy and identity mismatch are unavailable',()=>{
  for (const [n,p] of [[node,[]],[node,[{...presence,last_poll_at:new Date(now-46000)}]],
    [{...node,state:'paused'},[presence]],[node,[{...presence,public_key_hex:'other'}]],
    [{...node,updated_at:String(now/1000-61)},[presence]]])
    assert.equal(capabilityAvailability([n],p,[],now).image.state,'unavailable');
});
test('a valid running media lease remains busy even while its worker is not polling for another job',()=>{
  const a=capabilityAvailability([node],[{...presence,last_poll_at:new Date(now-120000)}],[{node_id:'gx10',media_running:1}],now);
  assert.equal(a.image.state,'busy');assert.equal(a.video.state,'busy');assert.equal(a.image.free_slots,0);
});
test('LLM capability requires LLM readiness and subtracts active slots',()=>{
  const llm={...node,capabilities:{ready_for_jobs:true,parallel_slots:8},worker_health:{runtime_mode:'vllm'}};
  assert.equal(capabilityAvailability([llm],[],[{node_id:'gx10',llm_running:8}],now).chat.state,'busy');
  assert.equal(capabilityAvailability([llm],[],[{node_id:'gx10',llm_running:7}],now).chat.free_slots,1);
});
