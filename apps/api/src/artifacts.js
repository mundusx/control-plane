const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,createHmac,timingSafeEqual}=require('node:crypto');
const {TYPES,EXT,encodeImage,scratchProject}=require('./artifact-pack');
const {mediaHeaders}=require('./client-media');
const {artifactSave}=require('./artifact-delivery');
const MAX=20*1024*1024;
class Artifacts {
  constructor({secret,root,origin,mediaUpstream,plannerUrl,fetchImpl=fetch}) {
    Object.assign(this,{secret,root,origin,mediaUpstream,plannerUrl,fetchImpl});
  }
  signature(id,expires){return createHmac('sha256',this.secret).update(id+'\n'+expires).digest('hex')}
  async download(url,res) {
    const match=url.pathname.match(/^\/v1\/artifacts\/([a-f0-9]{64})$/);if(!match)return false;
    const expires=url.searchParams.get('expires')||'',sig=url.searchParams.get('signature')||'';
    const expected=this.signature(match[1],expires);
    if(!/^\d{13}$/.test(expires)||Number(expires)<Date.now()||Number(expires)>Date.now()+172801000||!/^[a-f0-9]{64}$/.test(sig)||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected))){res.writeHead(403);res.end('Artifact link expired or invalid');return true;}
    try {
      const meta=JSON.parse(await fs.readFile(path.join(this.root,match[1]+'.json'),'utf8'));
      const bytes=await fs.readFile(path.join(this.root,match[1]+'.bin'));
      if(bytes.length!==meta.byte_size||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('Corrupt artifact');
      res.writeHead(200,{'Content-Type':meta.content_type,'Content-Length':bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="'+meta.filename+'"'});res.end(bytes);
    }catch{res.writeHead(404);res.end('Artifact is unavailable');}
    return true;
  }
  async plan(format,prompt,signal){
    const r=await this.fetchImpl(this.plannerUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,prompt}),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
    if(!r.ok)throw Error('Artifact planner is unavailable; no generation was started');
    const plan=await r.json();
    if(plan.planner_provider!=='langgraph'||plan.format!==format||!['generate','unsupported'].includes(plan.action))throw Error('Invalid artifact capability plan');
    return plan;
  }
  async generate(key,body,intent,plan,signal,resume={}) {
    const format=intent.format;if(!TYPES[format])throw Error('Unsupported artifact format');
    const sourcePrompt=format==='sb3'?'Create an image of a single isolated sprite on a plain white background, no text or computer screen. Subject: '+intent.prompt:intent.prompt;
    const sourceBody={...body,stream:false,messages:[...body.messages,{role:'user',content:'Create an image in PNG format. '+sourcePrompt}]};
    const raw=JSON.stringify(sourceBody);
    let source=resume.source;
    if(!source) {
      const r=await this.fetchImpl(new URL('v1/chat/completions',this.mediaUpstream.replace(/\/?$/,'/')),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.secret,...mediaHeaders(key,raw,this.secret)},body:raw,signal});
      if(!r.ok){const error=Error('Image source is still pending or unavailable (HTTP '+r.status+'); no output file was saved');error.retryable=[409,429,503,504].includes(r.status);throw error}
      const generated=await r.json();source=generated.mundusx?.media_artifact;
    }
    const url=new URL(source?.url||'https://invalid.invalid');
    const allowed=new Set(['https://chat.mundusx.ai',new URL(this.mediaUpstream).origin]);
    if(source?.content_type!=='image/png'||!source.job_id||!allowed.has(url.origin)||url.username||url.password)throw Error('Untrusted generated image artifact');
    if(!resume.source&&resume.checkpoint)await resume.checkpoint({source});
    const image=await this.fetchImpl(url,{redirect:'error',signal});
    if(!image.ok||!/^image\/png(?:;|$)/i.test(image.headers.get('content-type')||''))throw Error('Invalid source image response');
    const chunks=[];let size=0;for await(const chunk of image.body){size+=chunk.length;if(size>MAX)throw Error('Source image exceeds artifact size limit');chunks.push(chunk);}
    const png=Buffer.concat(chunks);if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Source image is not PNG');
    const bytes=format==='sb3'?await scratchProject(png,plan.motion):await encodeImage(png,format);
    if(bytes.length>MAX)throw Error('Output artifact exceeds size limit');
    const digest=createHash('sha256').update(bytes).digest('hex');
    const id=createHash('sha256').update(key.id+'\n'+source.job_id+'\n'+format+'\n'+digest).digest('hex');
    const filename='generated-'+(format==='sb3'?'sprite':'image')+'.'+(EXT[format]||format);
    const meta={filename,content_type:TYPES[format],sha256:digest,byte_size:bytes.length,created_at:Date.now()};
    await fs.mkdir(this.root,{recursive:true});
    // Bound persistent storage, and expire only files created by this module.
    const names=(await fs.readdir(this.root)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));let occupied=0;
    for(const name of names){const record=JSON.parse(await fs.readFile(path.join(this.root,name),'utf8'));if(record.created_at<Date.now()-172800000){await fs.unlink(path.join(this.root,name.replace('.json','.bin'))).catch(()=>{});await fs.unlink(path.join(this.root,name));}else occupied+=record.byte_size;}
    if(occupied+bytes.length>512*1024*1024)throw Error('Artifact storage is full; no output file was saved');
    await fs.writeFile(path.join(this.root,id+'.bin'),bytes);await fs.writeFile(path.join(this.root,id+'.json'),JSON.stringify(meta));
    const expires=String(Date.now()+172800000);
    const artifact={...meta,job_id:source.job_id,url:this.origin+'/v1/artifacts/'+id+'?expires='+expires+'&signature='+this.signature(id,expires)};
    const requested=intent.path?.replace(/\.webpn$/i,'.webp');
    if(requested&&!new RegExp('\\.(?:'+(format==='jpeg'?'jpe?g':format==='tiff'?'tiff?':format)+')$','i').test(requested))throw Error('Requested filename does not match artifact encoding');
    const result=artifactSave(body,artifact,requested);
    result.mundusx={...result.mundusx,artifact,artifact_plan:plan};
    return result;
  }
}
module.exports={Artifacts};
