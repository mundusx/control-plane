const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {artifactSave,completion,workspaceOf}=require('./artifact-delivery');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const active=job=>!['ready','failed','expired'].includes(job.state);
const workspaceKey=value=>{const normalized=(value||'').replaceAll('\\','/').replace(/\/$/,'');return /^[a-z]:/i.test(normalized)?normalized.toLowerCase():normalized};
function identity(key,body,intent) {
  const bytes=createHash('sha256').update(JSON.stringify([key.id,body.request_id||null,intent.format,
    intent.prompt.trim().replace(/\s+/g,' '),intent.path||null,workspaceKey(workspaceOf(body))])).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
class ArtifactJobs {
  constructor(artifacts,{root=path.join(artifacts.root,'jobs'),retryMs=10000,sweepMs=30000,now=Date.now}={}) {
    Object.assign(this,{artifacts,root,retryMs,now});this.running=new Map();this.closed=false;this.serial=Promise.resolve();
    this.ready=fs.mkdir(root,{recursive:true}).then(()=>this.recover());
    this.timer=setInterval(()=>this.ready.then(()=>this.recover()).catch(()=>{}),sweepMs);this.timer.unref();
  }
  file(id){if(!ID.test(id))throw Error('Invalid artifact request ID');return path.join(this.root,id+'.json')}
  async read(id,owner){const job=JSON.parse(await fs.readFile(this.file(id),'utf8'));if(owner&&job.owner!==owner)throw Error('Artifact request not found');return job}
  async write(job) {
    const temp=path.join(this.root,job.id+'.'+randomUUID()+'.tmp');
    await fs.writeFile(temp,JSON.stringify(job),{mode:0o600});
    try{for(let attempt=0;;attempt++){try{await fs.rename(temp,this.file(job.id));break}catch(e){if(!['EACCES','EPERM','EBUSY'].includes(e.code)||attempt>=12)throw e;await new Promise(r=>setTimeout(r,20*(attempt+1)))}}}
    finally{await fs.unlink(temp).catch(()=>{})}
  }
  async records(){const names=(await fs.readdir(this.root)).filter(n=>ID.test(n.slice(0,-5))&&n.endsWith('.json'));return (await Promise.allSettled(names.map(n=>this.read(n.slice(0,-5))))).filter(r=>r.status==='fulfilled').map(r=>r.value)}
  async recover(){if(this.closed)return;for(const job of await this.records())if(active(job)&&(!job.next_attempt_at||job.next_attempt_at<=this.now()))this.kick(job.id)}
  async ensure(key,body,intent,plan) {
    await this.ready;
    const operation=this.serial.then(async()=>{
      const id=identity(key,body,intent);
      try{const existing=await this.read(id,key.id);this.kick(id);return existing}catch(e){if(e.code!=='ENOENT')throw e}
      const records=await this.records();
      if(records.filter(j=>j.owner===key.id&&active(j)).length>=2)throw Error('You already have two pending artifact requests. Resume an existing request before creating another.');
      if(records.length>=10000)throw Error('Artifact request history storage is full; no job was submitted');
      const terminal=body.tools.find(t=>t.type==='function'&&/(?:^|[_.:])(?:run_in_terminal|execute_command|run_command|command|bash|powershell|exec_command)$/i.test(t.function?.name||''));
      const job={id,owner:key.id,state:'pending',created_at:this.now(),updated_at:this.now(),attempts:0,intent,plan,workspace:workspaceOf(body),
        // Freeze source input and idempotency once; never persist editor history or credentials.
        body:{model:body.model,request_id:id,tools:[terminal],messages:[]}};
      await this.write(job);this.kick(id);return job;
    });
    this.serial=operation.catch(()=>{});return operation;
  }
  kick(id) {
    if(this.closed||this.running.has(id))return;
    const controller=new AbortController();
    const promise=this.run(id,controller.signal).catch(()=>console.error('Artifact request checkpoint failed; recovery will retry')).finally(()=>this.running.delete(id));
    this.running.set(id,{promise,controller});
  }
  async run(id,signal) {
    const lock=path.join(this.root,id+'.lock');let handle,heartbeat;
    try {
      try{handle=await fs.open(lock,'wx',0o600)}catch(e){if(e.code!=='EEXIST')throw e;const stat=await fs.stat(lock).catch(()=>null);if(stat&&this.now()-stat.mtimeMs>120000){await fs.unlink(lock).catch(()=>{});handle=await fs.open(lock,'wx',0o600)}else return}
      heartbeat=setInterval(()=>fs.utimes(lock,new Date(),new Date()).catch(()=>{}),30000);heartbeat.unref();
      let job=await this.read(id);if(!active(job)||job.next_attempt_at>this.now())return;
      job.state='pending';job.updated_at=this.now();job.attempts++;await this.write(job);
      try {
        const checkpoint=async patch=>{job={...job,...patch,updated_at:this.now()};await this.write(job)};
        const result=await this.artifacts.generate({id:job.owner},job.body,job.intent,job.plan,signal,{source:job.source,checkpoint});
        if(!result.mundusx?.artifact)throw Error('Artifact generation did not return a durable result');
        job={...job,state:'ready',artifact:result.mundusx.artifact,body:undefined,source:undefined,error:null,updated_at:this.now()};
      }catch(e){
        if(signal.aborted||e.retryable||e instanceof TypeError){job={...job,state:'pending',error:signal.aborted?'Server restarted; request will resume':e.message,next_attempt_at:this.now()+this.retryMs,updated_at:this.now()}}
        else job={...job,state:'failed',error:e.message,body:undefined,updated_at:this.now()};
      }
      await this.write(job);
    } finally {clearInterval(heartbeat);if(handle){await handle.close();await fs.unlink(lock).catch(()=>{})}}
  }
  async wait(id,owner,{timeoutMs=20000,signal}={}) {
    const deadline=this.now()+timeoutMs;
    while(true){const job=await this.read(id,owner);if(!active(job)||this.now()>=deadline||signal?.aborted)return job;await new Promise(r=>setTimeout(r,Math.min(200,timeoutMs||1)))}
  }
  response(job,body) {
    const marker='Artifact request '+job.id;
    let result;
    if(job.state==='ready'&&Number(new URL(job.artifact.url).searchParams.get('expires'))>this.now()) {
      const workspace=workspaceOf(body);
      if(job.workspace&&workspaceKey(workspace)!==workspaceKey(job.workspace))result=completion(marker+' is ready. Reopen its original workspace to resume saving, or download it: '+job.artifact.url+'\nNo file has been saved in the current workspace.');
      else result=artifactSave(body,{...job.artifact,request_id:job.id},job.intent.path);
    } else if(job.state==='ready'||job.state==='expired')result=completion(marker+' has expired output. Its history remains; no replacement job was created. Explicitly request a new generation if needed.');
    else if(job.state==='failed')result=completion(marker+' failed: '+job.error+'. No successful local save is claimed. Explicitly request a new generation if you want a replacement.');
    else result=completion(marker+' is still pending, waiting for image generation or conversion. It will continue in the background even if this chat disconnects. Ask “check image status” in this conversation to resume saving. No file has been saved yet.');
    if(!result.choices[0].message.content.startsWith(marker))result.choices[0].message.content=marker+'. '+result.choices[0].message.content;
    result.mundusx={...result.mundusx,artifact_request_id:job.id,request_state:job.state,source_job_id:job.source?.job_id||job.artifact?.job_id||null,...(job.saved_path?{previously_verified_path:job.saved_path}:{})};
    return result;
  }
  async receipt(owner,result){const id=result.mundusx?.artifact_request_id;if(!id||!result.mundusx.file_saved)return;const job=await this.read(id,owner);if(job.artifact?.sha256!==result.mundusx.sha256)throw Error('Artifact save receipt does not match the request');await this.write({...job,saved_path:result.mundusx.saved_path,saved_at:this.now()})}
  async close(){this.closed=true;clearInterval(this.timer);await this.ready;for(const {controller} of this.running.values())controller.abort();await Promise.all([...this.running.values()].map(r=>r.promise))}
}
function resumeRequest(body) {
  const {textOf}=require('./client-clarification');const last=body.messages?.at(-1);
  if(last?.role!=='user'||! /^(?:retry|try again|resume|continue|check(?: image|artifact|job)? status|status)(?:\s+[a-f0-9-]{36})?[.!]?$/i.test(textOf(last)))return null;
  const explicit=textOf(last).match(/[a-f0-9-]{36}/i)?.[0];if(explicit&&ID.test(explicit))return explicit;
  for(const m of [...body.messages.slice(0,-1)].reverse())if(m.role==='assistant') {
    const id=(typeof m.content==='string'?m.content:'').match(/Artifact request ([a-f0-9-]{36})\b/)?.[1];
    return id&&ID.test(id)?id:null;
  }
  return null;
}
module.exports={ArtifactJobs,identity,resumeRequest};
