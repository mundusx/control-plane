import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/features/media/png.js';
import { MediaClientService } from '../src/features/media/client-service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {MediaArtifactStore,RETENTION_SECONDS,validateMetadata} from '../src/features/media/store.js';
import {MediaQueue} from '../src/features/media/queue.js';
import {mediaQuote} from '../src/features/media/pricing.js';
const profile='wan22-14b-480p-33f-v1';
test('video metadata accepts exact old and new timing presets without mixing them',()=>{
 const metadata={content_type:'video/mp4',width:1280,height:704,sha256:'a'.repeat(64),byte_size:100};
 for(const [fps,frames] of [[24,49],[24,121],[24,241],[16,33],[16,81],[16,161]]) assert.equal(validateMetadata({...metadata,fps,frames}).frames,frames);
 for(const [fps,frames] of [[24,33],[16,50],[16,241],[24,161]]) assert.throws(()=>validateMetadata({...metadata,fps,frames}),{statusCode:400});
});
async function fixture(t){
 const db=new PGlite(),root=await mkdtemp(join(tmpdir(),'mx-video-'));
 await db.exec(`create table users(id uuid primary key,status text default 'active');
 create table devices(node_id text primary key,public_key_hex text,policy_allowed boolean default true);
 create table jobs(job_id text primary key,request_id text unique,prompt text,preferred_backend text,model text,classification jsonb,status text,assigned_node_id text references devices(node_id),submitted_at_epoch bigint,assigned_at_epoch bigint,completed_at_epoch bigint,error text);
 create table credits_ledger(id uuid primary key,device_id text references devices(node_id),job_id text references jobs(job_id),entry_type text,amount numeric,currency text,metadata jsonb,created_at timestamptz);`);
 for(const name of ['0037_media_artifacts.sql','0038_media_compute_records.sql','0040_video_jobs.sql','0041_video_14b_presets.sql','0042_media_integer_durations.sql','0043_video_480p.sql']){const sql=await readFile(new URL('../../../db/migrations/'+name,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);}
 const owner=randomUUID(),other=randomUUID();await db.query('insert into users(id) values($1),($2)',[owner,other]);
 const key=generateKeyPairSync('ed25519');const pub=key.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 await db.query("insert into devices(node_id,public_key_hex) values('gx10',$1),('other',$1)",[pub]);
 let tail=Promise.resolve(),now=Date.now();const pool={async connect(){const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {query:db.query.bind(db),release};},async query(sql,args){const c=await this.connect();try{return await c.query(sql,args);}finally{c.release();}}};
 const store=new MediaArtifactStore({pool,directory:root,now:()=>now}),queue=new MediaQueue(store),device={node_id:'gx10',policy_allowed:true};
 t.after(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
 return {db,root,owner,other,store,queue,device,key,advance:ms=>now+=ms,submit:(extra={})=>queue.submit(owner,{profile_id:profile,prompt:'A teapot',idempotency_key:randomUUID(),...extra})};
}
function video(root,frames=33){const path=join(root,'fixture.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=832x480:r=16','-frames:v',String(frames),'-c:v','libx264','-threads','2','-pix_fmt','yuv420p',path],{timeout:30000,windowsHide:true});return readFile(path);}
test('video queue is FIFO, idempotent, per-owner and allows one active job per contributor',async t=>{
 const f=await fixture(t),key=randomUUID();const first=await f.submit({idempotency_key:key});assert.equal((await f.submit({idempotency_key:key})).job_id,first.job_id);
 await assert.rejects(f.submit({idempotency_key:key,prompt:'different'}),{statusCode:409});
 f.advance(1);const second=await f.submit();const claimed=await f.queue.claim(f.device,[profile]);assert.equal(claimed.job_id,first.job_id);assert.equal(await f.queue.claim(f.device,[profile]),null);
 assert.equal((await f.queue.claim({node_id:'other',policy_allowed:true},[profile])).job_id,second.job_id);
 await assert.rejects(f.queue.owned(f.other,first.job_id),{statusCode:404});
 await assert.rejects(f.queue.heartbeat('other',{job_id:claimed.job_id,lease_token:claimed.lease_token}),{statusCode:409});
 const row=await f.queue.owned(f.owner,first.job_id);assert.equal(row.lease_hash,undefined);assert.equal(row.lease_token,undefined);
 assert.equal((await f.db.query('select status from jobs where job_id=$1',[first.job_id])).rows[0].status,'media_running');
});
test('expired leases requeue with a new token and cannot complete or upload through the old lease',async t=>{
 const f=await fixture(t);await f.submit();const first=await f.queue.claim(f.device,[profile]);f.advance(181000);const second=await f.queue.claim(f.device,[profile]);assert.equal(first.job_id,second.job_id);assert.notEqual(first.lease_token,second.lease_token);
 await assert.rejects(f.queue.complete('gx10',{...first,generation_ms:100}),{statusCode:409});await f.queue.fail('gx10',second);assert.equal((await f.queue.owned(f.owner,first.job_id)).state,'failed');assert.equal((await f.db.query('select * from credits_ledger')).rows.length,0);
});
test('signed workers reject tampering and replay before claiming work',async t=>{
 const f=await fixture(t),path='/api/media/worker/claim',body={profiles:[profile],_nonce:randomUUID()},timestamp=String(Math.floor(f.store.now()/1000));
 const signature=sign(null,Buffer.from('POST\n'+path+'\n'+timestamp+'\n'+JSON.stringify(body)),f.key.privateKey).toString('hex');
 const request={headers:{'x-mundusx-node-id':'gx10','x-mundusx-timestamp':timestamp,'x-mundusx-signature':signature}};
 await assert.rejects(f.queue.authenticate(request,path,{...body,profiles:[]}),{statusCode:401});
 assert.equal((await f.queue.authenticate(request,path,body)).node_id,'gx10');await assert.rejects(f.queue.authenticate(request,path,body),{statusCode:409});
});
test('video completion requires validated output, rewards exactly once, and retains jobs and credits after file expiry',async t=>{
 const f=await fixture(t),job=await f.submit(),claim=await f.queue.claim(f.device,[profile]);const bytes=await video(f.root);
 const ticket=await f.queue.reserve('gx10',{...claim,metadata:{sha256:createHash('sha256').update(bytes).digest('hex'),byte_size:bytes.length}});
 await assert.rejects(f.queue.complete('gx10',{...claim,generation_ms:208508}),{statusCode:409});
 const receipt=await f.store.upload(ticket.artifact_id,ticket.upload_ticket.upload_token,bytes);assert.equal(receipt.content_type,'video/mp4');
 const link=await f.store.renewLink(ticket.artifact_id,f.owner);assert.match(link.download_path,/video\.mp4/);const token=new URL(link.download_path,'https://example.test').searchParams.get('token');
 const download=await f.store.download(ticket.artifact_id,token);assert.deepEqual(await download.file.readFile(),bytes);await download.file.close();
 const settled=await f.queue.complete('gx10',{...claim,generation_ms:208508});assert.equal(settled.status,'settled');await f.queue.complete('gx10',{...claim,generation_ms:999999});
 let rows=(await f.db.query('select * from credits_ledger')).rows;assert.equal(rows.length,1);assert.equal(Number(rows[0].amount),mediaQuote(profile).compute_credits);assert.equal(rows[0].metadata.work_type,'video_generation');
 f.advance(RETENTION_SECONDS*1000);await assert.rejects(f.store.download(ticket.artifact_id,token),{statusCode:404});await f.store.cleanup();assert.equal((await f.queue.owned(f.owner,job.job_id)).artifact.media_available,false);
 assert.equal((await f.queue.complete('gx10',{...claim,generation_ms:208508})).ledger_id,settled.ledger_id);assert.equal((await f.db.query('select * from jobs')).rows.length,1);assert.equal((await f.db.query('select * from credits_ledger')).rows.length,1);
});
test('MP4 validation rejects corrupt files and a mismatched frame preset',async t=>{
 const f=await fixture(t),bytes=await video(f.root,33),metadata={content_type:'video/mp4',width:1280,height:704,frames:81,fps:16,byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const a=await f.store.reserve(f.owner,metadata);await assert.rejects(f.store.upload(a.artifact_id,a.upload_ticket.upload_token,bytes),{statusCode:422});
 const corrupt=Buffer.from('not video');const b=await f.store.reserve(f.owner,{...metadata,byte_size:corrupt.length,sha256:createHash('sha256').update(corrupt).digest('hex')});await assert.rejects(f.store.upload(b.artifact_id,b.upload_ticket.upload_token,corrupt),{statusCode:422});
});
test('video prices use fixed benchmark work and reject arbitrary profiles',()=>{assert.equal(mediaQuote('wan22-5b-704p-121f-v1').compute_credits,9);for (const unsupported of ['unbenchmarked', '__proto__', 'constructor']) assert.throws(()=>mediaQuote(unsupported),{statusCode:422});});

test('retired 5B jobs remain retrievable and claimable but cannot be newly submitted',async t=>{
 const f=await fixture(t),key=randomUUID(),job=await f.submit({idempotency_key:key});
 const legacy='wan22-5b-704p-49f-v1',quote=mediaQuote(legacy);
 assert.equal(await f.queue.claim(f.device,[legacy]),null);
 await f.db.query('update media_generation_jobs set request=$2 where job_id=$1',[job.job_id,{prompt:'A teapot',profile_id:legacy,seed:42}]);
 await f.db.query('update media_compute_records set quote=$2 where job_id=$1',[job.job_id,quote]);
 await f.db.query('update jobs set model=$2,classification=$3 where job_id=$1',[job.job_id,quote.model,{operation:'text_to_video',media_profile_id:legacy}]);
 assert.equal((await f.submit({profile_id:legacy,idempotency_key:key})).job_id,job.job_id);
 await assert.rejects(f.submit({profile_id:legacy}),{statusCode:422});
 assert.equal((await f.queue.claim(f.device,[legacy])).job_id,job.job_id);
 assert.equal((await f.queue.owned(f.owner,job.job_id)).quote.model,quote.model);
});

test('HTTP video flow authenticates users and signed workers then serves an anonymous download',async t=>{
 const f=await fixture(t);const {createServerApp}=await import('../src/main.js');
 const authStore={session:async req=>req.headers.cookie==='session=test'?{id:f.owner}:null,requireCsrf(req){if(req.headers['x-mundusx-csrf']!=='test')throw Object.assign(new Error('CSRF'),{statusCode:403});}};
 const server=createServerApp({auth:{required:true},authStore,mediaStore:f.store,mediaAdmission:async device=>device.policy_allowed===true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin='http://127.0.0.1:'+server.address().port;
 const user={Cookie:'session=test','X-MundusX-CSRF':'test','Content-Type':'application/json'};
 const presets=await (await fetch(origin+'/api/media/profiles',{headers:user})).json();
 assert.equal(presets.profiles.length,20);
 assert.equal(presets.profiles.filter(p=>p.steps===4).length,10);
 assert.ok(presets.profiles.every(p=>p.model==='Wan-AI/Wan2.2-T2V-A14B'&&p.fps===16&&p.width===832&&p.height===480));
 assert.equal((await fetch(origin+'/api/media/jobs')).status,401);
 assert.equal((await fetch(origin+'/api/media/worker/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const submitted=await fetch(origin+'/api/media/jobs',{method:'POST',headers:user,body:JSON.stringify({prompt:'HTTP test',profile_id:profile,idempotency_key:randomUUID()})});assert.equal(submitted.status,202);const job=await submitted.json();
 async function worker(action,input){const body=JSON.stringify({...input,_nonce:randomUUID()}),path='/api/media/worker/'+action,timestamp=String(Math.floor(f.store.now()/1000));const signature=sign(null,Buffer.from('POST\n'+path+'\n'+timestamp+'\n'+body),f.key.privateKey).toString('hex');const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-MundusX-Node-Id':'gx10','X-MundusX-Timestamp':timestamp,'X-MundusX-Signature':signature},body});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
 const claim=(await worker('claim',{profiles:[profile]})).job;assert.equal(claim.job_id,job.job_id);
 const bytes=await video(f.root),ticket=await worker('reserve',{...claim,metadata:{byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
 const uploaded=await fetch(origin+ticket.upload_ticket.upload_path,{method:'PUT',headers:{Authorization:'Bearer '+ticket.upload_ticket.upload_token,'Content-Type':'video/mp4'},body:bytes});assert.equal(uploaded.status,200,await uploaded.text());
 await worker('complete',{...claim,generation_ms:208508});
 const link=await (await fetch(origin+'/api/media/artifacts/'+ticket.artifact_id+'/link',{method:'POST',headers:user,body:'{}'})).json();
 const downloaded=await fetch(origin+link.download_path);assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
 const wrong=link.download_path.replace('video.mp4','image.png');assert.equal((await fetch(origin+wrong)).status,404);
});

test('image queue reuses the media job contract and video workers cannot claim images', async t => {
 const f=await fixture(t), profile_id='qwen-image-fp8-832x480-v1';
 const job=await f.submit({profile_id});
 assert.equal(job.quote.operation,'text_to_image');
 assert.equal(await f.queue.claim(f.device,[profile]),null);
 const claim=await f.queue.claim(f.device,[profile_id]);
 assert.equal(claim.job_id,job.job_id);
 const ticket=await f.queue.reserve('gx10',{...claim,metadata:{sha256:'a'.repeat(64),byte_size:100}});
 assert.equal((await f.store.lookup(ticket.artifact_id)).content_type,'image/png');
 assert.equal(ticket.upload_ticket.width,832);
 assert.equal(ticket.upload_ticket.height,480);
 await assert.rejects(f.queue.owned(f.other,job.job_id),{statusCode:404});
});
test('all integer video durations are priced and accepted without removing old presets',()=>{
 for(let s=1;s<=10;s++) {
  const frames=s*16+1,q=mediaQuote(`wan22-14b-480p-${frames}f-v1`);
  assert.equal(q.frames,frames);
  assert.ok(q.compute_credits>0);
  assert.equal(validateMetadata({content_type:'video/mp4',width:1280,height:704,sha256:'a'.repeat(64),byte_size:100,frames,fps:16}).frames,frames);
 }
});

function png(width = 8, height = width) {
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(height * (width * 3 + 1)))), chunk("IEND", Buffer.alloc(0))]);
}

for (const oldPrice of [false,true]) test('image result settles its saved '+(oldPrice?'previous':'megapixel-step')+' quote once',async t=>{
 const f=await fixture(t),service=new MediaClientService(f.queue,'https://chat.example');
 const key=randomUUID(),input={kind:'image',prompt:'A teapot',idempotency_key:key};
 const job=await service.submit(f.owner,input);
 if (oldPrice) {
   const saved={...job.quote,pricing_version:'image-compute-v2',compute_credits:4,contributor_reward_credits:4};
   await f.db.query('update media_compute_records set quote=$2 where job_id=$1',[job.job_id,saved]);
   assert.equal((await service.submit(f.owner,input)).quote.compute_credits,4);
 }
 const claim=await f.queue.claim(f.device,['qwen-image-fp8-832x480-v1']);
 assert.equal(claim.quote.compute_credits,oldPrice?4:1199);
 const bytes=png(832,480),ticket=await f.queue.reserve('gx10',{...claim,metadata:{byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
 await f.store.upload(ticket.artifact_id,ticket.upload_ticket.upload_token,bytes);
 await f.queue.complete('gx10',{...claim,generation_ms:1000});
 await f.queue.complete('gx10',{...claim,generation_ms:1000});
 const result=await service.result(f.owner,job.job_id);
 assert.equal(result.content_type,'image/png');
 const token=new URL(result.download_url).searchParams.get('token');
 const downloaded=await f.store.download(ticket.artifact_id,token);
 assert.deepEqual(await downloaded.file.readFile(),bytes);await downloaded.file.close();
 await assert.rejects(service.result(f.other,job.job_id),{statusCode:404});
 assert.equal((await f.db.query('select * from credits_ledger')).rows.length,1);
 assert.equal(Number((await f.db.query('select amount from credits_ledger')).rows[0].amount),oldPrice?4:1199);
 f.advance(RETENTION_SECONDS*1000);await f.store.cleanup();
 await assert.rejects(service.result(f.owner,job.job_id),{statusCode:410});
 assert.equal((await service.status(f.owner,job.job_id)).state,'completed');
 assert.equal((await f.db.query('select * from credits_ledger')).rows.length,1);
});

test('chat prompts queue three-second videos and persist resumable cards behind session and CSRF checks',async t=>{
 const f=await fixture(t),{createServerApp}=await import('../src/main.js');
 await f.db.exec(`create table chat_conversations(conversation_id uuid primary key,last_message_at timestamptz,message_count integer default 0);
 create table chat_messages(id serial primary key,conversation_id uuid,role text,content text,job_id text unique,metadata jsonb);`);
 const conversationId=randomUUID();
 const authStore={session:async req=>req.headers.cookie==='session=test'?{id:f.owner}:null,
 requireCsrf(req){if(req.headers['x-mundusx-csrf']!=='test')throw Object.assign(new Error('CSRF'),{statusCode:403});},
 async authorizeConversation(owner,id){assert.equal(owner,f.owner);if(id!==conversationId)throw Object.assign(new Error('Not available'),{statusCode:404});}};
 const server=createServerApp({auth:{required:true,publicOrigin:'https://chat.example'},authStore,mediaStore:f.store,mediaAdmission:async()=>true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin='http://127.0.0.1:'+server.address().port,path=origin+'/api/media/chat';
 const headers={Cookie:'session=test','Content-Type':'application/json','X-MundusX-CSRF':'test'};
 const body={message:'Create a video of the ocean',conversationId,idempotency_key:randomUUID()};
 assert.equal((await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
 assert.equal((await fetch(path,{method:'POST',headers:{Cookie:'session=test','Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
 const response=await fetch(path,{method:'POST',headers,body:JSON.stringify(body)}),job=await response.json();
 assert.equal(response.status,202,JSON.stringify(job));assert.equal(job.quote.frames,49);assert.equal(job.quote.fps,16);assert.equal(job.history_saved,true);
 assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify(body)})).status,202);
 const messages=(await f.db.query('select * from chat_messages order by id')).rows;assert.equal(messages.length,2);assert.equal(messages[1].metadata.media_job.duration_seconds,3);
 const status=await fetch(origin+'/api/media/chat/jobs/'+job.job_id,{headers});assert.equal(status.status,200);assert.equal((await status.json()).state,'queued');
 const rejected=await fetch(path,{method:'POST',headers,body:JSON.stringify({...body,message:'Make a 30 second video',idempotency_key:randomUUID()})});assert.equal(rejected.status,400);
 assert.equal((await f.db.query('select * from media_generation_jobs')).rows.length,1);
});


test('legacy image jobs stay claimable with their original dimensions and credits', async t => {
 const f=await fixture(t), key=randomUUID(), legacy='qwen-image-fp8-1024-v1';
 const job=await f.submit({profile_id:'qwen-image-fp8-832x480-v1',idempotency_key:key});
 const quote=mediaQuote(legacy);
 await f.db.query('update media_generation_jobs set request=$2 where job_id=$1',[job.job_id,{prompt:'A teapot',profile_id:legacy,seed:42}]);
 await f.db.query('update media_compute_records set quote=$2 where job_id=$1',[job.job_id,quote]);
 assert.equal((await f.submit({profile_id:legacy,idempotency_key:key})).job_id,job.job_id);
 await assert.rejects(f.submit({profile_id:legacy}),{statusCode:422});
 assert.equal(await f.queue.claim(f.device,['qwen-image-fp8-832x480-v1']),null);
 const claim=await f.queue.claim(f.device,[legacy]);
 assert.equal(claim.job_id,job.job_id);
 assert.equal(claim.quote.width,1024); assert.equal(claim.quote.height,1024);
 assert.equal(claim.quote.compute_credits,4);
 const ticket=await f.queue.reserve('gx10',{...claim,metadata:{sha256:'a'.repeat(64),byte_size:100}});
 assert.equal(ticket.upload_ticket.width,1024); assert.equal(ticket.upload_ticket.height,1024);
});


test('480p migration preserves old artifacts and can be replayed with new rows', async t => {
 const f=await fixture(t);
 const base={content_type:'video/mp4',sha256:'a'.repeat(64),byte_size:100};
 for(const [width,height,fps,frames] of [[1280,704,24,49],[1280,704,16,33],[832,480,16,49]]) {
   await f.store.reserve(f.owner,{...base,width,height,fps,frames});
 }
 const sql=await readFile(new URL('../../../db/migrations/0043_video_480p.sql',import.meta.url),'utf8');
 await f.db.exec(sql);
 assert.equal((await f.db.query('select * from media_artifacts')).rows.length,3);
 for(const extra of [{width:832,height:480,fps:24,frames:49},{width:832,height:704,fps:16,frames:49}]) {
   assert.throws(()=>validateMetadata({...base,...extra}),{statusCode:400});
 }
});

test('old 704p queue jobs retain their quote and can only be claimed by matching workers', async t => {
 const f=await fixture(t), key=randomUUID(), job=await f.submit({idempotency_key:key});
 const legacy='wan22-14b-704p-33f-v1',quote=mediaQuote(legacy);
 await f.db.query('update media_generation_jobs set request=$2 where job_id=$1',[job.job_id,{prompt:'A teapot',profile_id:legacy,seed:42}]);
 await f.db.query('update media_compute_records set quote=$2 where job_id=$1',[job.job_id,quote]);
 assert.equal((await f.submit({profile_id:legacy,idempotency_key:key})).job_id,job.job_id);
 assert.equal(await f.queue.claim(f.device,[profile]),null);
 const claim=await f.queue.claim(f.device,[legacy]);
 assert.equal(claim.job_id,job.job_id);assert.equal(claim.quote.width,1280);assert.equal(claim.quote.height,704);
 assert.equal(mediaQuote(profile).compute_credits,quote.compute_credits);
});


test('fast I2V requires owned references, fences downloads, and settles video once',async t=>{
 const f=await fixture(t),service=new MediaClientService(f.queue,'https://chat.example');
 const reference=png(64,128);
 const reserved=await f.store.reserve(f.owner,{width:64,height:128,byte_size:reference.length,sha256:createHash('sha256').update(reference).digest('hex')});
 await f.store.upload(reserved.artifact_id,reserved.upload_ticket.upload_token,reference);
 const input={kind:'video',prompt:'The subject turns',duration_seconds:2,input_artifact_id:reserved.artifact_id,idempotency_key:randomUUID()};
 await assert.rejects(service.submit(f.other,input),{statusCode:404});
 const job=await service.submit(f.owner,input);
 assert.equal(job.quote.operation,'image_to_video');assert.equal(job.quote.steps,4);
 assert.equal(await f.queue.claim(f.device,[profile]),null);
 const claim=await f.queue.claim(f.device,[job.quote.profile_id]);
 const downloaded=await f.queue.input('gx10',claim);
 assert.deepEqual(Buffer.from(downloaded.data,'base64'),reference);
 await assert.rejects(f.queue.input('other',claim),{statusCode:409});
 await assert.rejects(f.queue.input('gx10',{...claim,lease_token:'wrong'}),{statusCode:409});
 const bytes=await video(f.root),ticket=await f.queue.reserve('gx10',{...claim,metadata:{byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
 await f.store.upload(ticket.artifact_id,ticket.upload_ticket.upload_token,bytes);
 await f.queue.complete('gx10',{...claim,generation_ms:146360});
 await f.queue.complete('gx10',{...claim,generation_ms:146360});
 assert.equal((await service.result(f.owner,job.job_id)).content_type,'video/mp4');
 const ledger=(await f.db.query('select * from credits_ledger where job_id=$1',[job.job_id])).rows;
 assert.equal(ledger.length,1);assert.equal(ledger[0].metadata.work_type,'video_generation');
});

test('OpenAI HTTP multipart I2V supports polling, idempotency and protected content',async t=>{
 const f=await fixture(t),{createServerApp}=await import('../src/main.js');
 const authStore={session:async()=>null,mcpSession:async req=>req.headers.authorization==='Bearer user-token'?{id:f.owner}:null};
 const server=createServerApp({auth:{required:true,publicOrigin:'https://chat.example'},authStore,mediaStore:f.store,mediaAdmission:async()=>true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin='http://127.0.0.1:'+server.address().port;
 const headers={Authorization:'Bearer user-token','Idempotency-Key':randomUUID()};
 const reference=png(64,128);
 async function submit() {
   const form=new FormData();form.set('model','Wan-AI/Wan2.2-I2V-A14B-Lightning');form.set('prompt','A teapot turns');
   form.set('seconds','2');form.set('size','832x480');form.set('input_reference',new Blob([reference],{type:'image/png'}),'input.png');
   const response=await fetch(origin+'/v1/videos',{method:'POST',headers,body:form});
   assert.equal(response.status,200);return response.json();
 }
 const created=await submit();assert.equal(created.object,'video');assert.equal(created.status,'queued');assert.equal(created.seconds,'2');
 assert.equal((await submit()).id,created.id);
 assert.equal((await fetch(origin+'/v1/videos/'+created.id)).status,401);
 assert.equal((await fetch(origin+'/v1/videos/'+created.id+'/content',{headers})).status,409);
 const job=await f.queue.owned(f.owner,created.id),claim=await f.queue.claim(f.device,[job.quote.profile_id]);
 const bytes=await video(f.root),ticket=await f.queue.reserve('gx10',{...claim,metadata:{byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
 await f.store.upload(ticket.artifact_id,ticket.upload_ticket.upload_token,bytes);
 await f.queue.complete('gx10',{...claim,generation_ms:146360});
 const status=await (await fetch(origin+'/v1/videos/'+created.id,{headers})).json();assert.equal(status.status,'completed');assert.equal(status.progress,100);
 const content=await fetch(origin+'/v1/videos/'+created.id+'/content',{headers});assert.equal(content.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await content.arrayBuffer()),bytes);
 assert.equal((await fetch(origin+'/v1/videos/'+created.id+'/content?variant=thumbnail',{headers})).status,400);
});
