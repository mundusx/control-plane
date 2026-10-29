const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp}=require('node:fs/promises');const {tmpdir}=require('node:os');
const {ArtifactJobs,identity,resumeRequest}=require('../src/artifact-jobs');
const key={id:'owner'},intent={format:'webp',prompt:'Create a walking cat with hat',path:'assets/cat.webp'},plan={action:'generate'};
const body={model:'mundusx-agnostic',tools:[{type:'function',function:{name:'run_in_terminal',parameters:{properties:{command:{type:'string'}}}}}],messages:[{role:'user',content:'<workspace_info>I am working in a workspace with the following folders:\n- D:\\project\nFiles</workspace_info>'}]};
const artifact={url:'https://api.test/v1/artifacts/a?expires='+String(Date.now()+172800000),filename:'cat.webp',content_type:'image/webp',byte_size:123,sha256:'a'.repeat(64),job_id:'source-job'};
const result={mundusx:{artifact}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(jobs,id){for(let i=0;i<100;i++){const job=await jobs.read(id);if(job.state==='ready')return job;await sleep(10)}throw Error('Job did not complete')}

test('identity excludes dates and changing editor history, but isolates owners/workspaces/new request IDs',()=>{
 const changed={...body,messages:[{role:'system',content:'Different date and context'},...body.messages,{role:'user',content:'retry'}]};
 assert.equal(identity(key,body,intent),identity(key,changed,intent));
 assert.notEqual(identity(key,body,intent),identity({id:'other'},body,intent));
 assert.notEqual(identity(key,body,intent),identity(key,{...body,request_id:'explicit-new'},intent));
 assert.notEqual(identity(key,body,intent),identity(key,{...body,messages:[{role:'user',content:body.messages[0].content.replace('project','another-project')}]},intent));
});
test('concurrent retries join one source request; a lost client does not abort background work',async()=>{
 const root=await mkdtemp(tmpdir()+'/ehda-durable-');let calls=0,finish;
 const backend={root,generate:async()=>{calls++;return new Promise(r=>finish=()=>r(result))}};
 const jobs=new ArtifactJobs(backend,{sweepMs:100000});
 try {
  const records=await Promise.all(Array.from({length:8},()=>jobs.ensure(key,body,intent,plan)));
  assert.equal(new Set(records.map(r=>r.id)).size,1);
  while(!finish)await sleep(5);
  const cancelled=new AbortController();cancelled.abort();const pending=await jobs.wait(records[0].id,key.id,{timeoutMs:1000,signal:cancelled.signal});
  assert.equal(pending.state,'pending');assert.equal(calls,1);finish();
  const completed=await ready(jobs,records[0].id);assert.equal(completed.artifact.job_id,'source-job');
  const nextDay=await jobs.ensure(key,{...body,messages:[...body.messages,{role:'user',content:'retry tomorrow'}]},intent,plan);assert.equal(nextDay.id,completed.id);assert.equal(calls,1);
  await assert.rejects(jobs.read(completed.id,'another-owner'),/not found/);
 } finally {await jobs.close()}
});
test('restart recovers checkpointed source and continues conversion without a new source job',async()=>{
 const root=await mkdtemp(tmpdir()+'/ehda-recover-');let sourceCheckpoint;
 const first=new ArtifactJobs({root,generate:async(k,b,i,p,signal,resume)=>{
  assert.match(b.request_id,/^[a-f0-9-]{36}$/);assert.equal(b.messages.length,0);
  await resume.checkpoint({source:{job_id:'existing-source',url:'https://source.test/png'}});sourceCheckpoint=true;
  return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));
 }},{retryMs:0,sweepMs:100000});
 const original=await first.ensure(key,body,intent,plan);while(!sourceCheckpoint)await sleep(5);await first.close();
 let conversions=0;
 const second=new ArtifactJobs({root,generate:async(k,b,i,p,signal,resume)=>{assert.equal(resume.source.job_id,'existing-source');assert.equal(b.request_id,original.id);conversions++;return result}},{retryMs:0,sweepMs:100000});
 try {await second.ready;const completed=await ready(second,original.id);assert.equal(conversions,1);assert.equal(completed.state,'ready');assert.equal(completed.body,undefined);assert.match(second.response(completed,body).choices[0].message.content,/Artifact request/)}finally{await second.close()}
});
test('request history resumes only explicit status turns and preserves expired outputs without regeneration',async()=>{
 const root=await mkdtemp(tmpdir()+'/ehda-expiry-');let calls=0;
 const jobs=new ArtifactJobs({root,generate:async()=>{calls++;return {mundusx:{artifact:{...artifact,url:'https://api.test/file?expires=1'}}}}},{sweepMs:100000});
 try {
  const job=await jobs.ensure(key,body,intent,plan);const completed=await ready(jobs,job.id);const response=jobs.response(completed,body);
  assert.match(response.choices[0].message.content,/expired output/);assert.equal(calls,1);
  const history=[{role:'assistant',content:'Artifact request '+job.id+' is pending.'},{role:'user',content:'check image status'}];assert.equal(resumeRequest({messages:history}),job.id);
  assert.equal(resumeRequest({messages:[...history,{role:'assistant',content:'Unrelated conversation'},{role:'user',content:'retry'}]}),null);
  assert.equal(resumeRequest({messages:[{role:'user',content:'hello'}]}),null);
 }finally{await jobs.close()}
});

test('real API disconnect continues generation; a retry with changed history returns the same artifact',async t=>{
 const {createApi}=require('../src/server'),{Artifacts}=require('../src/artifacts');const sharp=require('sharp');
 const root=await mkdtemp(tmpdir()+'/ehda-http-resume-');let sourceCalls=0,finish;
 const png=await sharp({create:{width:20,height:20,channels:3,background:'#ffaa00'}}).png().toBuffer();
 const artifacts=new Artifacts({root,origin:'https://api.test',secret:'test',mediaUpstream:'https://chat.mundusx.ai',plannerUrl:'https://planner.test',fetchImpl:async(url,options)=>{
  if(String(url).includes('planner.test'))return Response.json({action:'generate',format:JSON.parse(options.body).format,planner_provider:'langgraph'});
  if(String(url).includes('chat/completions')){sourceCalls++;return new Promise(resolve=>{finish=()=>resolve(Response.json({mundusx:{media_artifact:{job_id:'one-source',content_type:'image/png',url:'https://chat.mundusx.ai/source.png'}}}))})}
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 }});
 const server=createApi({upstreamUrl:'http://127.0.0.1:1',mediaUpstreamUrl:'https://chat.mundusx.ai',upstreamToken:'test',artifacts,artifactWaitMs:50,authenticate:()=>key,recordUsage:()=>{}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();server.close();await server.artifactJobs.close()});
 const request={...body,messages:[...body.messages,{role:'user',content:'Create an image of a cat as assets/cat.webp'}]};
 const abort=new AbortController();const endpoint='http://127.0.0.1:'+server.address().port+'/v1/chat/completions';
 const pending=fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:abort.signal}).then(r=>r.text()).catch(()=>null);
 while(!finish)await sleep(5);abort.abort();await pending;
 const records=await server.artifactJobs.records();assert.equal(records.length,1);finish();await ready(server.artifactJobs,records[0].id);
 const retry={...request,messages:[{role:'system',content:'A new date and changed editor context'},...request.messages]};
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(retry)});const result=await response.json();
 assert.equal(result.choices[0].finish_reason,'tool_calls');assert.equal(result.mundusx.artifact_request_id,records[0].id);assert.equal(sourceCalls,1);
 const status=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,messages:[...request.messages,result.choices[0].message,{role:'user',content:'check image status'}]})});
 assert.equal((await status.json()).mundusx.artifact_request_id,records[0].id);assert.equal(sourceCalls,1);
});

test('upstream timeout reuses stable source identity; conversion retry reuses its source checkpoint',async()=>{
 const {Artifacts}=require('../src/artifacts'),sharp=require('sharp');const root=await mkdtemp(tmpdir()+'/ehda-source-retry-');
 const png=await sharp({create:{width:8,height:8,channels:3,background:'#ff0000'}}).png().toBuffer();let submissions=0,downloads=0;const ids=[];
 const backend=new Artifacts({root,origin:'https://api.test',secret:'test',mediaUpstream:'https://chat.mundusx.ai',plannerUrl:'https://planner.test',fetchImpl:async(url,options)=>{
  if(String(url).includes('chat/completions')){submissions++;ids.push(JSON.parse(options.body).request_id);if(submissions===1)return Response.json({error:{message:'pending'}},{status:504});return Response.json({mundusx:{media_artifact:{job_id:'same-source-job',content_type:'image/png',url:'https://chat.mundusx.ai/source.png'}}})}
  downloads++;if(downloads===1)throw TypeError('Network interrupted after checkpoint');return new Response(png,{headers:{'Content-Type':'image/png'}});
 }});
 const jobs=new ArtifactJobs(backend,{retryMs:0,sweepMs:100000});
 try {
  const job=await jobs.ensure(key,body,intent,plan);
  for(let i=0;i<3;i++){while(jobs.running.has(job.id))await sleep(5);const current=await jobs.read(job.id);if(current.state==='ready')break;jobs.kick(job.id)}
  const completed=await ready(jobs,job.id);assert.equal(completed.state,'ready');assert.equal(submissions,2);assert.equal(new Set(ids).size,1);assert.equal(ids[0],job.id);assert.equal(downloads,2);
 }finally{await jobs.close()}
});
