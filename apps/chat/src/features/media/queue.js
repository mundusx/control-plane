import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { mediaQuote, VIDEO_PROFILES } from './pricing.js';
import { MediaAccounting } from './accounting.js';
import { httpError } from '../../shared/http-error.js';
const hash = v => createHash('sha256').update(String(v)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class MediaQueue {
  constructor(store) { this.store=store; this.accounting=new MediaAccounting(store); }
  async authenticate(request, path, body) {
    const h=request.headers, node=String(h['x-mundusx-node-id']??''), timestamp=String(h['x-mundusx-timestamp']??''), signature=String(h['x-mundusx-signature']??'');
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Number(timestamp)*1000-this.store.now())>120000 || !/^[0-9a-f]{128}$/.test(signature) || !uuid.test(body?._nonce??'')) throw httpError(401,'Invalid worker signature');
    const device=(await this.store.pool.query('select * from public.devices where node_id=$1',[node])).rows[0];
    if (!device || !/^[0-9a-f]{64}$/.test(device.public_key_hex??'')) throw httpError(401,'Register this contributor first');
    const key=createPublicKey({key:Buffer.from('302a300506032b6570032100'+device.public_key_hex,'hex'),format:'der',type:'spki'});
    if (!verify(null,Buffer.from(`POST\n${path}\n${timestamp}\n${JSON.stringify(body)}`),key,Buffer.from(signature,'hex'))) throw httpError(401,'Invalid worker signature');
    try { await this.store.pool.query('insert into public.media_worker_nonces(node_id,nonce,expires_at) values($1,$2,$3)',[node,body._nonce,new Date(this.store.now()+300000)]); }
    catch(e) { if(e.code==='23505') throw httpError(409,'Worker request already used'); throw e; }
    return device;
  }
  async submit(owner,input) {
    const quote=mediaQuote(input.profile_id);
    if (quote.operation!=='text_to_video') throw httpError(422,'Choose a video preset');
    if (typeof input.prompt!=='string' || !input.prompt.trim() || input.prompt.length>4000 || !uuid.test(input.idempotency_key??'')) throw httpError(400,'Expected prompt, profile_id and UUID idempotency_key');
    const seed=input.seed??42;
    if(!Number.isSafeInteger(seed)||seed<0||seed>2147483647) throw httpError(400,'Invalid seed');
    const task={prompt:input.prompt.trim(),profile_id:quote.profile_id,seed};
    return this.store.transaction(async db=>{
      await db.query("select id from public.users where id=$1 and status='active' for update",[owner]);
      const old=(await db.query('select * from public.media_generation_jobs where owner_user_id=$1 and idempotency_key=$2',[owner,input.idempotency_key])).rows[0];
      if(old) { if(JSON.stringify(old.request)!==JSON.stringify(task) && (old.request.prompt!==task.prompt || old.request.profile_id!==task.profile_id || old.request.seed!==seed)) throw httpError(409,'Idempotency key already used for another request'); const saved=(await db.query('select quote from public.media_compute_records where job_id=$1',[old.job_id])).rows[0]; return {job_id:old.job_id,state:old.state,quote:saved.quote}; }
      const pending=(await db.query("select count(*)::int n from public.media_generation_jobs where owner_user_id=$1 and state in ('queued','running')",[owner])).rows[0].n;
      if(pending>=4) throw httpError(429,'You already have four pending video requests');
      // Media-prefixed states are excluded by the legacy LLM restore/claim query.
      const id=randomUUID(), now=new Date(this.store.now());
      await db.query(`insert into public.jobs(job_id,request_id,prompt,preferred_backend,model,classification,status,submitted_at_epoch) values($1,$1,$2,'auto',$3,$4,'media_queued',$5)`,[id,task.prompt,quote.model,{operation:quote.operation,media_profile_id:quote.profile_id},Math.floor(this.store.now()/1000)]);
      await db.query('insert into public.media_compute_records(job_id,owner_user_id,quote) values($1,$2,$3)',[id,owner,quote]);
      await db.query('insert into public.media_generation_jobs(job_id,owner_user_id,idempotency_key,request,created_at) values($1,$2,$3,$4,$5)',[id,owner,input.idempotency_key,task,now]);
      return {job_id:id,state:'queued',quote};
    });
  }
  async claim(device,profiles) {
    if(!device.policy_allowed) throw httpError(403,'Contributor policy does not allow work');
    const supported=Array.isArray(profiles)?profiles.filter(x=>Object.hasOwn(VIDEO_PROFILES,x)):[];
    if(!supported.length) throw httpError(422,'No supported video presets');
    return this.store.transaction(async db=>{
      // Serialize claims per node across processes; SKIP LOCKED distributes jobs across nodes.
      await db.query('select node_id from public.devices where node_id=$1 for update',[device.node_id]);
      const now=new Date(this.store.now());
      const expired=await db.query("update public.media_generation_jobs set state=case when attempts>=3 then 'failed' else 'queued' end,lease_hash=null,lease_until=null,node_id=null,error='Worker lease expired' where state='running' and lease_until<=$1 returning job_id,state",[now]);
      for(const x of expired.rows) {
        await db.query('update public.jobs set status=$2,assigned_node_id=null where job_id=$1',[x.job_id,'media_'+x.state]);
        await db.query("update public.media_compute_records set artifact_id=null,node_id=null where job_id=$1 and status='quoted'",[x.job_id]);
      }
      await db.query('delete from public.media_worker_nonces where expires_at<=$1',[now]);
      if((await db.query("select 1 from public.media_generation_jobs where node_id=$1 and state='running'",[device.node_id])).rows.length) return null;
      const row=(await db.query("select * from public.media_generation_jobs where state='queued' and request->>'profile_id'=any($1::text[]) order by created_at,job_id for update skip locked limit 1",[supported])).rows[0];
      if(!row) return null;
      const token=randomBytes(32).toString('hex');
      await db.query("update public.media_generation_jobs set state='running',node_id=$2,lease_hash=$3,lease_until=$4,attempts=attempts+1,error=null where job_id=$1",[row.job_id,device.node_id,hash(token),new Date(this.store.now()+180000)]);
      await db.query("update public.jobs set status='media_running',assigned_node_id=$2,assigned_at_epoch=$3 where job_id=$1",[row.job_id,device.node_id,Math.floor(this.store.now()/1000)]);
      const saved=(await db.query('select quote from public.media_compute_records where job_id=$1',[row.job_id])).rows[0];
      return {job_id:row.job_id,...row.request,lease_token:token,lease_seconds:180,quote:saved.quote};
    });
  }
  async lease(db,node,input,allowCompleted=false) {
    const row=(await db.query('select * from public.media_generation_jobs where job_id=$1 for update',[input.job_id])).rows[0];
    if(!row || row.node_id!==node || !row.lease_hash || !timingSafeEqual(Buffer.from(hash(input.lease_token)),Buffer.from(row.lease_hash)) ||
       !(allowCompleted&&row.state==='completed') && (row.state!=='running'||new Date(row.lease_until).getTime()<=this.store.now())) throw httpError(409,'Media lease is no longer valid');
    return row;
  }
  async heartbeat(node,input) { return this.store.transaction(async db=>{
    await this.lease(db,node,input);
    await db.query('update public.media_generation_jobs set lease_until=$2 where job_id=$1',[input.job_id,new Date(this.store.now()+180000)]);
    return {ok:true};
  }); }
  async reserve(node,input) {
    const row=await this.store.transaction(db=>this.lease(db,node,input));
    const q=mediaQuote(row.request.profile_id);
    const reservation=await this.store.reserve(row.owner_user_id,{...input.metadata,content_type:'video/mp4',width:q.width,height:q.height,frames:q.frames,fps:q.fps});
    try { await this.store.transaction(async db=>{
      await this.lease(db,node,input);
      const record=(await db.query('select * from public.media_compute_records where job_id=$1 for update',[row.job_id])).rows[0];
      if(record.status!=='quoted') throw httpError(409,'Already settled');
      // A retry may replace an unuploaded ticket; ready output must be completed instead.
      if(record.artifact_id) {
        const old=(await db.query('select status from public.media_artifacts where artifact_id=$1',[record.artifact_id])).rows[0];
        if(old?.status==='ready') throw httpError(409,'Output is already uploaded; complete the job');
      }
      await db.query('update public.media_compute_records set artifact_id=$2,node_id=$3 where job_id=$1',[row.job_id,reservation.artifact_id,node]);
    }); } catch(e) { throw e; }
    return {artifact_id:reservation.artifact_id,upload_ticket:reservation.upload_ticket};
  }
  async complete(node,input) {
    if(!Number.isSafeInteger(input.generation_ms)||input.generation_ms<0) throw httpError(400,'Invalid generation telemetry');
    await this.store.transaction(async db=>{
      const row=await this.lease(db,node,input,true);
      if(row.state==='completed') return;
      const a=(await db.query(`select a.* from public.media_artifacts a join public.media_compute_records c on c.artifact_id=a.artifact_id where c.job_id=$1 and c.node_id=$2 for update of a`,[row.job_id,node])).rows[0];
      if(!a||a.status!=='ready'||a.file_deleted_at||new Date(a.expires_at).getTime()<=this.store.now()) throw httpError(409,'Upload a valid video before completion');
      await db.query("update public.jobs set status='media_completed',completed_at_epoch=$2 where job_id=$1",[row.job_id,Math.floor(this.store.now()/1000)]);
      await db.query("update public.media_generation_jobs set state='completed',completed_at=$2 where job_id=$1",[row.job_id,new Date(this.store.now())]);
    });
    return this.accounting.settle(input);
  }
  async fail(node,input) { return this.store.transaction(async db=>{
    await this.lease(db,node,input);
    await db.query("update public.media_generation_jobs set state='failed',error='Video generation failed',lease_until=null,completed_at=$2 where job_id=$1",[input.job_id,new Date(this.store.now())]);
    await db.query("update public.jobs set status='media_failed',error='Video generation failed' where job_id=$1",[input.job_id]);
    return {ok:true};
  }); }
  async owned(owner,id) {
    const row=(await this.store.pool.query(`select q.job_id,q.state,q.request,q.error,q.created_at,q.completed_at,c.quote,c.artifact_id,c.status as settlement_status,c.ledger_id
      from public.media_generation_jobs q join public.media_compute_records c using(job_id) where q.job_id=$1 and q.owner_user_id=$2`,[id,owner])).rows[0];
    if(!row) throw httpError(404,'Video job not found');
    if(row.artifact_id) row.artifact=await this.store.owned(row.artifact_id,owner);
    return row;
  }
}
