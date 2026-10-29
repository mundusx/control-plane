import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {eligibleMediaNode,rankMediaWorkers,mediaFleet} from '../src/features/media/routing.js';
import {MediaQueue} from '../src/features/media/queue.js';
import {mediaPlanner} from '../src/features/media/planner.js';
import {MediaClientService} from '../src/features/media/client-service.js';

const profile='qwen-image-fp8-832x480-v1', now=Date.now();
const live = id => ({node_id:id,public_key_hex:id,updated_at:String(now/1000),state:'ready',policy_allowed:true,
  worker_health:{healthy:true,media_budget_bytes:100*1024**3,media_profiles:[profile]}});
const candidate = (id,extra={}) => ({node_id:id,profiles:[profile],running:0,last_poll_at:new Date(now),completed:0,failed:0,mean_ms:null,last_assigned_at:null,...extra});

test('media eligibility excludes stale, paused, unverified and insufficient-budget nodes',()=>{
  assert.equal(eligibleMediaNode(live('a'),profile,now),true);
  for (const change of [{state:'paused'},{policy_allowed:false},{updated_at:String(now/1000-61)},
    {worker_health:{healthy:true,media_budget_bytes:0,media_profiles:[profile]}}])
    assert.equal(eligibleMediaNode({...live('a'),...change},profile,now),false);
  assert.equal(eligibleMediaNode(live('a'),'wan22-14b-480p-49f-v1',now),false);
});

test('ranking uses reliability and same-profile speed while reserving fair exploration',()=>{
  const reliable=candidate('reliable',{completed:10,mean_ms:1000,last_assigned_at:new Date(now)});
  const failing=candidate('failing',{completed:10,failed:20,mean_ms:100});
  const newcomer=candidate('new');
  assert.equal(rankMediaWorkers([failing,reliable,newcomer],profile,0,now)[0].node_id,'reliable');
  assert.equal(rankMediaWorkers([reliable,newcomer],profile,4,now)[0].node_id,'new');
  assert.equal(rankMediaWorkers([candidate('busy',{running:1}),candidate('stale',{last_poll_at:new Date(now-46000)})],profile,0,now).length,0);
  assert.equal(rankMediaWorkers([reliable,candidate('fast',{completed:10,mean_ms:500})],profile,0,now)[0].node_id,'fast');
});

test('fleet snapshot is cached briefly, traverses pages, and fails closed',async()=>{
  let calls=0;
  const fleet=mediaFleet({controlPlaneUrl:'https://control.example'},async url=>{
    calls++;return {ok:true,json:async()=>({items:url.includes('page=1&')?Array.from({length:100},(_,i)=>live(String(i))):[live('last')]})};
  },()=>now);
  assert.equal((await fleet()).length,101);await fleet();assert.equal(calls,2);
  await assert.rejects(mediaFleet({controlPlaneUrl:'https://control.example'},async()=>{throw Error('offline')})(),{statusCode:503});
});

test('real queue selects ranked worker, preserves one slot, and records failed/expired attempts',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create table users(id uuid primary key,status text default 'active');
    create table devices(node_id text primary key,public_key_hex text);
    create table jobs(job_id text primary key,request_id text,prompt text,preferred_backend text,model text,classification jsonb,status text,assigned_node_id text,submitted_at_epoch bigint,assigned_at_epoch bigint,error text);
    create table credits_ledger(id uuid primary key,device_id text,job_id text,entry_type text,amount numeric,currency text,metadata jsonb,created_at timestamptz);`);
  for (const name of ['0037_media_artifacts.sql','0038_media_compute_records.sql','0040_video_jobs.sql','0043_video_480p.sql','0044_media_routing.sql']) {
    const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
  }
  const owner=randomUUID();await db.query('insert into users(id) values($1)',[owner]);
  await db.exec("insert into devices values('fast','fast'),('slow','slow')");
  let clock=now, tail=Promise.resolve(),fleet=[live('fast'),live('slow')];
  const query=(sql,args)=>sql.startsWith('select pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args);
  const store={now:()=>clock,pool:{query},async transaction(fn){
    const prev=tail;let release;tail=new Promise(r=>release=r);await prev;
    try {await db.exec('begin');const r=await fn({query});await db.exec('commit');return r;}
    catch(e){await db.exec('rollback');throw e;}finally{release();}
  }};
  const queue=new MediaQueue(store,async()=>true,async()=>fleet);
  const submit=(extra={})=>queue.submit(owner,{profile_id:profile,prompt:'A teapot',idempotency_key:randomUUID(),...extra});
  const fast={node_id:'fast',public_key_hex:'fast'},slow={node_id:'slow',public_key_hex:'slow'};
  await queue.claim(fast,[profile]);await queue.claim(slow,[profile]);
  await db.query('update media_worker_presence set last_assigned_at=$1 where node_id=$2',[new Date(now),'slow']);
  const clientDelivery={action:'download_to_workspace',execution_owner:'client',tool_names:['run_in_terminal']};
  await submit({client_delivery:clientDelivery});
  const [lower,job]=await Promise.all([queue.claim(slow,[profile]),queue.claim(fast,[profile])]);
  assert.equal(lower,null);assert.ok(job);
  assert.equal((await queue.owned(owner,job.job_id)).request.client_delivery.execution_owner,'client');
  const originalKey=(await db.query('select idempotency_key from media_generation_jobs where job_id=$1',[job.job_id])).rows[0].idempotency_key;
  await assert.rejects(submit({idempotency_key:originalKey,client_delivery:{...clientDelivery,tool_names:['other_terminal']}}),{statusCode:409});
  assert.equal(await queue.claim(fast,[profile]),null);
  await queue.fail('fast',{job_id:job.job_id,lease_token:job.lease_token});
  assert.equal((await db.query('select state from media_execution_attempts')).rows[0].state,'failed');
  await submit();const other=await queue.claim(slow,[profile]);assert.ok(other);
  clock+=181000;fleet=fleet.map(n=>({...n,updated_at:String(clock/1000)}));
  await queue.claim(fast,[profile]);
  assert.equal((await db.query('select state from media_execution_attempts where job_id=$1 and attempt=1',[other.job_id])).rows[0].state,'expired');
  fleet=[];
  const waiting=await submit();assert.equal(waiting.state,'queued');
  clock+=1;
  queue.fleet=async()=>{throw new Error('fleet unavailable');};
  await assert.rejects(submit(),{statusCode:429});
  const retryKey=(await db.query('select idempotency_key from media_generation_jobs where job_id=$1',[waiting.job_id])).rows[0].idempotency_key;
  assert.equal((await queue.submit(owner,{profile_id:profile,prompt:'A teapot',idempotency_key:retryKey})).job_id,waiting.job_id);
  fleet=[live('fast'),live('slow')].map(n=>({...n,updated_at:String(clock/1000)}));
  queue.fleet=async()=>fleet;
  const recovered=await queue.claim(slow,[profile]);
  assert.equal(recovered.job_id,waiting.job_id);
});

test('media planner must return the exact async profile before submitting',async()=>{
  let submitted=0;
  const planner=mediaPlanner('http://planner/v1/media/plan',async()=>({ok:true,json:async()=>({execution_route:'media_queue',asynchronous:true,profile_id:profile})}));
  const service=new MediaClientService({submit:async()=>{submitted++;return {job_id:randomUUID(),state:'queued'};}},'https://chat.example',planner);
  await service.submit('owner',{kind:'image',prompt:'teapot'});assert.equal(submitted,1);
  await assert.rejects(service.submit('owner',{kind:'video',prompt:'teapot'}),{statusCode:503});assert.equal(submitted,1);
});
