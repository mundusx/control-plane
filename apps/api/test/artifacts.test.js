const test=require('node:test'),assert=require('node:assert/strict');
const sharp=require('sharp');
const {encodeImage,scratchProject,validateScratch}=require('../src/artifact-pack');
const {clientMediaClarification,MEDIA_TYPE_QUESTION,FORMAT_QUESTION}=require('../src/client-clarification');
const {artifactSave,artifactSaveResult}=require('../src/artifact-delivery');
const {Artifacts}=require('../src/artifacts');
const {mkdtemp,readFile,symlink}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile);
const http=require('node:http');
const {createApi}=require('../src/server');
const image=()=>sharp({create:{width:32,height:24,channels:3,background:'#0077ff'}}).png().toBuffer();
const request=text=>({messages:[{role:'user',content:text}],tools:[{type:'function',function:{name:'run_in_terminal',parameters:{properties:{command:{type:'string'},explanation:{type:'string'},goal:{type:'string'},mode:{type:'string'}}}}}]});
test('encoders produce real file signatures and decodable images',async()=>{
 const png=await image();
 for(const format of ['png','jpeg','webp','tiff','gif','avif']) {
  const bytes=await encodeImage(png,format);assert.equal((await sharp(bytes).metadata()).format,format==='avif'?'heif':format);
 }
 const bmp=await encodeImage(png,'bmp');assert.equal(bmp.toString('ascii',0,2),'BM');assert.equal(bmp.readUInt32LE(2),bmp.length);assert.equal(bmp.readInt32LE(18),32);assert.equal(bmp.readInt32LE(22),24);
});
test('Scratch archive loads in official VM and walking blocks execute',async()=>{
 const sb3=await scratchProject(await image(),'walk');await validateScratch(sb3,'walk',true);
 assert.equal(sb3.toString('ascii',0,2),'PK');
});
test('requested formats, typo aliases and unknown types stay in their own conversation',()=>{
 for(const [input,output] of [['jpg','jpeg'],['webpn','webp'],['sb3','sb3'],['tif','tiff']]) {
  const body=request('create walking cat with hat');body.messages.push({role:'assistant',content:MEDIA_TYPE_QUESTION},{role:'user',content:input});
  assert.equal(clientMediaClarification(body).format,output);
 }
 const original=request('create walking cat with hat');original.messages.push({role:'assistant',content:MEDIA_TYPE_QUESTION},{role:'user',content:'xyz'});
 assert.equal(clientMediaClarification(original).message,FORMAT_QUESTION);
 original.messages.push({role:'assistant',content:FORMAT_QUESTION},{role:'user',content:'webp'});assert.match(clientMediaClarification(original).prompt,/walking cat/);
 assert.equal(clientMediaClarification(request('create an image and save as assets/cat.xyz')).action,'ask');
 assert.equal(clientMediaClarification(request('create walking cat as assets/cat.sb3')).path,'assets/cat.sb3');
 assert.equal(clientMediaClarification(request('webp')),null);
});
test('unsupported formats and Scratch capabilities do not submit or forward a job',async t=>{
 let plans=0,generations=0;
 const server=createApi({upstreamUrl:'http://127.0.0.1:1',mediaUpstreamUrl:'http://127.0.0.1:1',upstreamToken:'test',authenticate:()=>({id:'test'}),recordUsage:()=>{},artifacts:{
  plan:async()=>{plans++;return {action:'unsupported',reason:'Complex Scratch projects require a coding generator'}},
  generate:async()=>{generations++;throw Error('must not generate')},download:async()=>false,
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
 for(const text of ['Create an image and save as assets/cat.xyz','Create a Scratch game as assets/cat.sb3']) {
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request(text),model:'mundusx-agnostic'})});
  assert.equal(r.status,200);const b=await r.json();assert.equal(b.mundusx.job_started,false);
 }
 assert.equal(plans,1);assert.equal(generations,0);
});
test('signed storage verifies links; client download saves exact bytes and refuses overwrite',async t=>{
 const root=await mkdtemp(tmpdir()+'/ehda-artifact-test-');
 const png=await image();let submissions=0;
 const storage=new Artifacts({secret:'test-only',root,origin:'http://placeholder',mediaUpstream:'https://chat.mundusx.ai',plannerUrl:'https://planner.test',fetchImpl:async url=>{
  if(String(url).includes('chat/completions')){submissions++;return Response.json({mundusx:{media_artifact:{job_id:'job',content_type:'image/png',url:'https://chat.mundusx.ai/generated.png'}}})}
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 }});
 const server=http.createServer((req,res)=>storage.download(new URL(req.url,'http://localhost'),res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});storage.origin='http://127.0.0.1:'+server.address().port;
 const workspace=await mkdtemp(tmpdir()+'/ehda-save-test-');
 const body=request('create cat as jpg');body.messages.unshift({role:'user',content:'<workspace_info>I am working in a workspace with the following folders:\n- '+workspace+'\nFiles</workspace_info>'});
 const result=await storage.generate({id:'test'},body,{format:'jpeg',prompt:'create cat',path:'assets/cat.jpg'},{motion:null},new AbortController().signal);
 assert.equal(submissions,1);assert.equal(result.choices[0].finish_reason,'tool_calls');
 const artifact=result.mundusx.artifact;assert.equal((await fetch(artifact.url.replace('signature=','signature=0'))).status,403);
 const call=result.choices[0].message.tool_calls[0];const command=JSON.parse(call.function.arguments).command;
 let stdout;
 if(process.platform==='win32') {
  // Windows native delivery is exercised with a Windows workspace below.
  const windowsBody=request('create cat');windowsBody.messages.unshift({role:'user',content:'<workspace_info>I am working in a workspace with the following folders:\n- '+workspace.replaceAll('/','\\')+'\nFiles</workspace_info>'});
  const native=artifactSave(windowsBody,artifact,'assets/cat.jpg');const nativeCall=native.choices[0].message.tool_calls[0];const nativeCommand=JSON.parse(nativeCall.function.arguments).command;
  stdout=(await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',nativeCommand],{encoding:'utf8'})).stdout;
  await assert.rejects(execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',nativeCommand]));
  const ack=artifactSaveResult({messages:[native.choices[0].message,{role:'tool',tool_call_id:nativeCall.id,content:stdout.trim()}]});assert.equal(ack.mundusx.file_saved,true);
 } else {stdout=(await execute('/bin/sh',['-c',command],{encoding:'utf8'})).stdout;assert.match(stdout,/EHDA_ARTIFACT_SAVED/);await assert.rejects(execute('/bin/sh',['-c',command]));}
 const bytes=await readFile(workspace+'/assets/cat.jpg');assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);assert.equal((await sharp(bytes).metadata()).format,'jpeg');
 const outside=await mkdtemp(tmpdir()+'/ehda-outside-test-');await symlink(outside,workspace+'/linked',process.platform==='win32'?'junction':'dir');
 const linked=artifactSave(body,artifact,'linked/cat.jpg');const linkedCommand=JSON.parse(linked.choices[0].message.tool_calls[0].function.arguments).command;
 await assert.rejects(process.platform==='win32'?execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',linkedCommand]):execute('/bin/sh',['-c',linkedCommand]));
 await assert.rejects(readFile(outside+'/cat.jpg'));
});
