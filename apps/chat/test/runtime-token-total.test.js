import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

test('runtime call ledger and public counter update atomically and deduplicate report retries',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec("create table devices(node_id text primary key);create table jobs(job_id text primary key,model text);insert into devices values('node');insert into jobs values('job','qwen');");
  const migration=await readFile(new URL('../../../db/migrations/0045_runtime_token_usage.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  const sql=await readFile(new URL('../../../db/statements/record_runtime_token_usage.sql',import.meta.url),'utf8');
  const call=[randomUUID(),'job','node','worker',0,100,50];
  await db.query(sql,call);await db.query(sql,call);
  await db.query(sql,[randomUUID(),'job','node','worker',0,100,50]);
  let totals=(await db.query('select * from runtime_token_totals')).rows[0];
  assert.equal(Number(totals.completion_tokens),100);assert.equal(Number(totals.prompt_tokens),50);assert.equal(Number(totals.measured_calls),1);
  await db.exec('begin');await db.query(sql,[randomUUID(),'job','node','worker',1,200,null]);await db.exec('rollback');
  totals=(await db.query('select * from runtime_token_totals')).rows[0];assert.equal(Number(totals.completion_tokens),100);
  assert.equal((await db.query('select * from runtime_token_usage')).rows.length,1);
  await db.query(sql,[randomUUID(),'job','node','worker',1,200,null]);
  totals=(await db.query('select * from runtime_token_totals')).rows[0];assert.equal(Number(totals.completion_tokens),300);assert.equal(Number(totals.measured_calls),2);
});
