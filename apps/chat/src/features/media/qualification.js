import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {mediaQuote} from './pricing.js';
import {validateMetadata} from './store.js';
import {validatePng} from './png.js';
import {validateVideo} from './video.js';
import {httpError} from '../../shared/http-error.js';
import {referenceImage} from './probe-image.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const secret=(v,h)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&typeof h==='string'&&timingSafeEqual(Buffer.from(hash(v),'hex'),Buffer.from(h,'hex'));
export function mediaFingerprint(device,profile) {
  const health=device.worker_health_json??device.worker_health??{};
  return hash(JSON.stringify([1,device.public_key_hex,device.agent_version,device.backend,
    device.contribution_percent,health.runtime_mode,health.media_budget_bytes,
    health.capabilities?.physical_memory_mb,health.capabilities?.usable_memory_mb,profile]));
}
export class MediaQualification {
  constructor(store,enabled=process.env.MUNDUSX_MEDIA_QUALIFICATION_MODE==='gradual') {this.store=store;this.enabled=enabled;}
  async claim(device,profiles) {
    if(!this.enabled)return null;
    return this.store.transaction(async db=>{
      await db.query('select node_id from public.devices where node_id=$1 for update',[device.node_id]);
      const now=new Date(this.store.now());
      await db.query("update public.media_qualification_probes set state='failed',reason='Probe lease expired',completed_at=$2 where node_id=$1 and state='running' and lease_until<=$2",[device.node_id,now]);
      if((await db.query("select 1 from public.media_qualification_probes where node_id=$1 and state='running'",[device.node_id])).rows.length ||
         (await db.query("select 1 from public.media_generation_jobs where node_id=$1 and state='running' and lease_until>$2",[device.node_id,now])).rows.length ||
         (await db.query("select 1 from public.jobs where assigned_node_id=$1 and status in ('assigned','running')",[device.node_id])).rows.length)return null;
      for(const profile of profiles) {
        const fingerprint=mediaFingerprint(device,profile),quote=mediaQuote(profile);
        await db.query('insert into public.media_qualification_probes(job_id,node_id,profile_id,fingerprint) values($1,$2,$3,$4) on conflict(node_id,profile_id,fingerprint) do nothing',[randomUUID(),device.node_id,profile,fingerprint]);
        const row=(await db.query('select * from public.media_qualification_probes where node_id=$1 and profile_id=$2 and fingerprint=$3 for update',[device.node_id,profile,fingerprint])).rows[0];
        if(row.state!=='pending')continue;
        const token=randomBytes(32).toString('hex');
        await db.query("update public.media_qualification_probes set state='running',lease_hash=$2,lease_until=$3 where job_id=$1",[row.job_id,hash(token),new Date(this.store.now()+180000)]);
        return {job_id:row.job_id,profile_id:profile,qualification:true,prompt:'A quiet green field beneath a blue sky, no people, no text.',seed:42,lease_token:token,lease_seconds:180,quote:{...quote,compute_credits:0,contributor_reward_credits:0}};
      }
      return null;
    });
  }
  async eligible(device,profiles) {
    if(!this.enabled||!(device.execution_history_json?.qualification_required))return profiles;
    const rows=(await this.store.pool.query("select profile_id,fingerprint from public.media_qualification_probes where node_id=$1 and state='passed'",[device.node_id])).rows;
    return profiles.filter(p=>rows.some(r=>r.profile_id===p&&r.fingerprint===mediaFingerprint(device,p)));
  }
  async lookup(id) {return (await this.store.pool.query('select * from public.media_qualification_probes where job_id=$1',[id])).rows[0];}
  async input(node,input) {return this.store.transaction(async db=>{const row=await this.lease(db,node,input);if(mediaQuote(row.profile_id).operation!=='image_to_video')throw httpError(404,'Probe has no reference image');const bytes=referenceImage();return {data:bytes.toString('base64'),sha256:hash(bytes)};});}
  async lease(db,node,input,completed=false) {
    const row=(await db.query('select * from public.media_qualification_probes where job_id=$1 for update',[input.job_id])).rows[0];
    if(!row||row.node_id!==node||!secret(input.lease_token,row.lease_hash)||
      !(completed&&row.state==='passed')&&(row.state!=='running'||new Date(row.lease_until).getTime()<=this.store.now()))throw httpError(409,'Qualification lease is invalid');
    const device=(await db.query('select * from public.devices where node_id=$1',[node])).rows[0];
    if(!device||mediaFingerprint(device,row.profile_id)!==row.fingerprint)throw httpError(409,'Contributor configuration changed');
    return row;
  }
  async heartbeat(node,input) {return this.store.transaction(async db=>{await this.lease(db,node,input);await db.query('update public.media_qualification_probes set lease_until=$2 where job_id=$1',[input.job_id,new Date(this.store.now()+180000)]);return {ok:true};});}
  async reserve(node,input) {return this.store.transaction(async db=>{
    const row=await this.lease(db,node,input),q=mediaQuote(row.profile_id);
    const metadata=validateMetadata({...input.metadata,width:q.width,height:q.height,frames:q.frames,fps:q.fps,content_type:q.operation==='text_to_image'?'image/png':'video/mp4'});
    const artifact=randomUUID(),token=randomBytes(32).toString('hex');
    await db.query('update public.media_qualification_probes set artifact_id=$2,upload_hash=$3,metadata=$4,uploaded=false where job_id=$1',[row.job_id,artifact,hash(token),metadata]);
    return {artifact_id:artifact,upload_ticket:{version:1,artifact_id:artifact,upload_path:`/api/media/artifacts/${artifact}/content`,upload_token:token,expires_at:row.lease_until.toISOString(),...metadata}};
  });}
  async artifact(id) {return (await this.store.pool.query('select * from public.media_qualification_probes where artifact_id=$1',[id])).rows[0];}
  authorizeUpload(row,token) {if(row.state!=='running'||!secret(token,row.upload_hash)||new Date(row.lease_until).getTime()<=this.store.now())throw httpError(404,'Qualification upload expired');}
  async upload(id,token,bytes) {
    const row=await this.artifact(id);if(!row)throw httpError(404,'Qualification upload not found');this.authorizeUpload(row,token);
    const m=row.metadata;if(bytes.length!==m.byte_size||hash(bytes)!==m.sha256)throw httpError(422,'Qualification artifact checksum mismatch');
    if(m.content_type==='video/mp4') {
      await mkdir(this.store.directory,{recursive:true,mode:0o700});const path=join(this.store.directory,`.qualification-${id}-${randomUUID()}.mp4`);
      try {await writeFile(path,bytes,{flag:'wx',mode:0o600});await validateVideo(path,m);} finally {await unlink(path).catch(()=>{});}
    } else validatePng(bytes,m.width,m.height);
    await this.store.transaction(async db=>{const current=(await db.query('select * from public.media_qualification_probes where artifact_id=$1 for update',[id])).rows[0];if(!current)throw httpError(409,'Upload changed');this.authorizeUpload(current,token);await db.query('update public.media_qualification_probes set uploaded=true where artifact_id=$1',[id]);});
    // Evidence only. No download link, account reservation or retained bytes.
    return {artifact_id:id,status:'ready',sha256:m.sha256,byte_size:m.byte_size,expires_at:row.lease_until.toISOString()};
  }
  async complete(node,input) {return this.store.transaction(async db=>{
    const row=await this.lease(db,node,input,true);if(row.state==='passed')return {ok:true,qualification:true,credits:0};
    if(!row.uploaded)throw httpError(409,'Upload a valid probe artifact first');
    if(!Number.isSafeInteger(input.generation_ms)||input.generation_ms<=0)throw httpError(400,'Measured generation time required');
    await db.query("update public.media_qualification_probes set state='passed',generation_ms=$2,completed_at=$3 where job_id=$1",[row.job_id,input.generation_ms,new Date(this.store.now())]);
    return {ok:true,qualification:true,credits:0};
  });}
  async fail(node,input) {return this.store.transaction(async db=>{await this.lease(db,node,input);await db.query("update public.media_qualification_probes set state='failed',reason='Worker failed the profile probe',completed_at=$2 where job_id=$1",[input.job_id,new Date(this.store.now())]);return {ok:true,qualification:true};});}
}
