import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MediaQueue } from '../src/features/media/queue.js';

test('owned queue status ranks compatible waiting jobs and keeps separate requests visible', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create table media_generation_jobs(job_id text primary key,owner_user_id text,state text,request jsonb,error text,created_at timestamptz,completed_at timestamptz);
    create table media_compute_records(job_id text primary key,quote jsonb,artifact_id text,status text,ledger_id text);
    create table media_worker_presence(node_id text,public_key_hex text,last_poll_at timestamptz,profiles jsonb);
    create table jobs(job_id text,status text,completed_at_epoch bigint);`);
  for (const [id, owner, state, profile] of [
    ['a', 'other', 'queued', 'image'], ['b', 'other', 'queued', 'video'],
    ['c', 'me', 'queued', 'image'], ['d', 'me', 'running', 'image'],
    ['e', 'other', 'completed', 'image'],
  ]) {
    await db.query('insert into media_generation_jobs values($1,$2,$3,$4,null,$5,null)',
      [id, owner, state, {profile_id: profile}, '2026-10-06T00:00:00Z']);
    await db.query("insert into media_compute_records values($1,'{}',null,'quoted',null)", [id]);
  }
  const queue = new MediaQueue({pool: db});
  const waiting = await queue.owned('me','c');
  assert.equal(waiting.queue_position, 2);
  assert.equal(waiting.jobs_ahead, 1);
  assert.equal(waiting.pending_requests, 2);
  assert.equal(waiting.max_pending_requests, 2);
  const running = await queue.owned('me','d');
  assert.equal(running.queue_position, null);
  assert.equal(running.jobs_ahead, null);
  await assert.rejects(queue.owned('other','c'), {statusCode: 404});
  await db.query("update media_generation_jobs set state='running' where job_id='a'");
  assert.equal((await queue.owned('me','c')).queue_position, 1);
  await db.exec('alter table media_generation_jobs add column node_id text');
  const now=Date.parse('2026-10-06T00:00:00Z');
  queue.store.now=()=>now;
  queue.store.transaction=action=>db.transaction(action);
  let nodes=[];queue.fleet=async()=>nodes;
  assert.equal((await queue.owned('me','c')).worker_availability,'offline');
  const node={node_id:'worker',public_key_hex:'key',policy_allowed:true,state:'ready',updated_at:now/1000,worker_health:{healthy:true,media_budget_bytes:128*1024**3,media_profiles:['image']}};
  nodes=[node];
  await db.query('insert into media_worker_presence values($1,$2,$3,$4)',['worker','key',new Date(now),['image']]);
  assert.equal((await queue.owned('me','c')).worker_availability,'available');
  await db.query("update media_generation_jobs set node_id='worker' where job_id='d'");
  assert.equal((await queue.owned('me','c')).worker_availability,'busy');
  await db.query('update media_worker_presence set last_poll_at=$1',[new Date(now-60000)]);
  assert.equal((await queue.owned('me','c')).worker_availability,'offline');
  queue.fleet=async()=>{throw Error('Unavailable')};
  assert.equal((await queue.owned('me','c')).worker_availability,'unknown');
  await assert.rejects(queue.cancel('other','c'),{statusCode:404});
  await assert.rejects(queue.cancel('me','d'),{statusCode:409});
  assert.equal((await queue.cancel('me','c')).state,'cancelled');
  assert.equal((await queue.owned('me','c')).pending_requests,1);
  assert.equal((await queue.cancel('me','c')).state,'cancelled');
});
