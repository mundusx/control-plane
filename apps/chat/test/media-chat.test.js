import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { mediaChatIntent } from '../src/features/media/chat-intent.js';
import { persistMediaChatTurn } from '../src/features/media/chat-history.js';
import { page } from '../src/main.js';

test('direct generation requests default to three seconds and enforce a ten-second maximum',()=>{
  for(const prompt of ['Create a video of a sunset','Can you generate a video of a cat?','I want a video of the ocean','please make me a video']) {
    assert.equal(mediaChatIntent(prompt).duration_seconds,3,prompt);
  }
  for(let seconds=1;seconds<=10;seconds++) assert.equal(mediaChatIntent(`Make a ${seconds}-second video of a sunrise`).duration_seconds,seconds);
  assert.equal(mediaChatIntent('I would like a ten second video of a train').duration_seconds,10);
  for(const prompt of ['Make a 20 second video','Create a 1 minute video','Make a 2.5s video']) assert.ok(mediaChatIntent(prompt).error,prompt);
  assert.equal(mediaChatIntent('Draw an image of a cat').kind,'image');
  for(const prompt of ['How do I generate a video?','Explain video generation','Create a video player component','Do not create a video','What is an image?','Write a script to generate a video']) assert.equal(mediaChatIntent(prompt),null,prompt);
});

test('chat has no separate video link, embeds parseable media UI and respects reduced motion',()=>{
  const html=page();
  assert.doesNotMatch(html,/href="\/video"/);
  assert.match(html,/Maximum 10 seconds/);
  assert.match(html,/prefers-reduced-motion:reduce/);
  assert.match(html,/media-chat-loader/);
  assert.match(html,/media-vector-turn/);
  assert.match(html,/Create another image/);
  assert.match(html,/compatible jobs ahead/);
  assert.match(html,/Updates every 30 seconds/);
  for(const match of html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)) if(match[1].trim()) assert.doesNotThrow(()=>new vm.Script(match[1]));
});

test('media history preserves both roles and reconnect metadata without duplicating retries',async t=>{
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`create table users(id uuid primary key);create table chat_conversations(conversation_id uuid primary key,last_message_at timestamptz,message_count integer default 0);
    create table chat_messages(id serial primary key,conversation_id uuid,role text,content text,job_id text unique,metadata jsonb);
    insert into users values('11111111-1111-4111-8111-111111111111');`);
  const store={transaction:action=>db.transaction(tx=>action(tx))};
  const owner='11111111-1111-4111-8111-111111111111', conversation='22222222-2222-4222-8222-222222222222';
  const job={job_id:'33333333-3333-4333-8333-333333333333'},intent=mediaChatIntent('Create a video of a sunset');
  await persistMediaChatTurn(store,owner,conversation,job,intent);
  await persistMediaChatTurn(store,owner,conversation,job,intent);
  const rows=(await db.query('select * from chat_messages order by id')).rows;
  assert.equal(rows.length,2);
  assert.equal(rows[0].role,'user');assert.equal(rows[0].job_id,null);
  assert.equal(rows[1].role,'assistant');assert.equal(rows[1].metadata.media_job.job_id,job.job_id);
  assert.equal(rows[1].metadata.media_job.duration_seconds,3);
  await assert.rejects(persistMediaChatTurn(store,owner,'44444444-4444-4444-8444-444444444444',job,intent),{statusCode:409});
});
