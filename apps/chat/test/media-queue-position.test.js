import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MediaQueue } from '../src/features/media/queue.js';

test('owned queue status ranks compatible waiting jobs and keeps separate requests visible', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create table media_generation_jobs(job_id text primary key,owner_user_id text,state text,request jsonb,error text,created_at timestamptz,completed_at timestamptz);
    create table media_compute_records(job_id text primary key,quote jsonb,artifact_id text,status text,ledger_id text);`);
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
  assert.equal(waiting.max_pending_requests, 4);
  const running = await queue.owned('me','d');
  assert.equal(running.queue_position, null);
  assert.equal(running.jobs_ahead, null);
  await assert.rejects(queue.owned('other','c'), {statusCode: 404});
  await db.query("update media_generation_jobs set state='running' where job_id='a'");
  assert.equal((await queue.owned('me','c')).queue_position, 1);
});
