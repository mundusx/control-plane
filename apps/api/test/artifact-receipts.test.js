const test=require('node:test'),assert=require('node:assert/strict');
const {artifactSave,artifactSaveResult}=require('../src/artifact-delivery');
const {destination}=require('../src/artifact-jobs');
const id='e64cc3a4-9458-4f57-ac70-3131ea26ca03';
const artifact={url:'https://api.test/image',filename:'generated-image.png',sha256:'a'.repeat(64),byte_size:123,request_id:id};
const body={messages:[{role:'user',content:'<workspace_info>I am working in a workspace with the following folders:\n- D:\\project\nFiles</workspace_info>'}],tools:[{type:'function',function:{name:'run_in_terminal',parameters:{properties:{command:{type:'string'}}}}}]};
const assistant=artifactSave(body,artifact,'assets/cat.png').choices[0].message;
const call=assistant.tool_calls[0];const command=JSON.parse(call.function.arguments).command;
const target=JSON.parse(command.split('# EHDA_ARTIFACT_TARGET ')[1]);const receipt='EHDA_ARTIFACT_SAVED:'+JSON.stringify(target);
const ack=content=>artifactSaveResult({messages:[assistant,{role:'tool',tool_call_id:call.id,content}]});
test('actual terminal receipt survives ANSI mode changes, colours, CRLF and output wrappers',()=>{
 for(const content of [receipt,'\x1b[97mse\x1b[37m()}\r\r\n\x1b[0m'+receipt+'\x1b[?1004h\r\n',JSON.stringify({output:'Terminal output:\r\n'+receipt+'\x1b[?1004h'}),[{type:'text',text:receipt}]]) {
  const result=ack(content);assert.equal(result.mundusx.file_saved,true);assert.equal(result.mundusx.artifact_request_id,id);
 }
});
test('echoed commands, wrong hashes/requests and collisions never count as successful saves',()=>{
 assert.equal(ack(command+'\nDestination exists with different content; not overwritten\nCommand exited with code 1').mundusx.file_saved,false);
 assert.equal(ack(command).mundusx.file_saved,false);
 assert.equal(ack(JSON.stringify({command})).mundusx.file_saved,false);
 assert.equal(ack('EHDA_ARTIFACT_SAVED:'+JSON.stringify({...target,sha256:'b'.repeat(64)})).mundusx.file_saved,false);
 assert.equal(ack('EHDA_ARTIFACT_SAVED:'+JSON.stringify({...target,artifact_request_id:'other'})).mundusx.file_saved,false);
 const result=ack('Destination exists with different content; not overwritten');assert.equal(result.mundusx.save_error,'destination_exists');assert.match(result.choices[0].message.content,/Choose a new filename/);
});
test('folder-only destination is honored, default names avoid collisions and verified paths stay stable',()=>{
 const job={id,created_at:1793280000123,workspace:'D:\\project',intent:{format:'png',prompt:'generate me an image of monkey d luffy save in assets folder'}};
 assert.equal(destination(job),'assets/generated-image-1793280000-e64cc3a4.png');
 assert.equal(destination({...job,updated_at:1793380000123}),destination(job));
 assert.notEqual(destination(job),destination({...job,created_at:1793280001123}));
 assert.notEqual(destination(job),destination({...job,id:'f64cc3a4-9458-4f57-ac70-3131ea26ca03'}));
 assert.equal(destination({...job,intent:{...job.intent,path:'assets/luffy.png'}}),'assets/luffy.png');
 assert.equal(destination({...job,saved_path:'d:/project/already-saved.png'}),'already-saved.png');
});
