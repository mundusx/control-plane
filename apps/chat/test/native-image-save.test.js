import test from 'node:test';
import assert from 'node:assert/strict';
import { activeImagePrompt, nativeImageSave, imageSaveResult } from '../src/features/media/native-image-save.js';
import { clientImageRequest } from '../src/features/media/client-delivery.js';
import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const prompt='Generate an image of a blue mountain landscape and save it as assets/mountains.png in my current workspace.';
const body={tools:[{type:'function',function:{name:'run_in_terminal',parameters:{type:'object',properties:{command:{type:'string'},explanation:{type:'string'},goal:{type:'string'},mode:{type:'string',enum:['sync','async']},isBackground:{type:'boolean'},timeout:{type:'number'}},required:['command','explanation','goal','mode']}}}],messages:[
  {role:'system',content:'Large Copilot system context '.repeat(2000)},
  {role:'user',content:'<environment_info>The user\'s current OS is: Windows</environment_info>\n<workspace_info>\nI am working in a workspace with the following folders:\n- D:\\projects\\converter\nI am working in a workspace with files</workspace_info>'},
  {role:'user',content:`<context>Terminal Cwd: D:\\other-project</context>\n<reminderInstructions>Unrelated edit instructions</reminderInstructions>\n<userRequest>\n${prompt}\n</userRequest>`},
]};
const artifact={url:"https://chat.example/image.png?token=opaque&name=o'hare",suggested_filename:'generated-image.png'};

test('Copilot wrapped request routes only its active userRequest',()=>{
  assert.equal(activeImagePrompt(body),prompt);assert.equal(clientImageRequest(body).kind,'image');
  for(const text of ['Hello','How do I generate an image?','Do not generate an image']) {
    assert.equal(clientImageRequest({...body,messages:[{role:'user',content:`<context>${prompt}</context><userRequest>${text}</userRequest>`}]}),null);
  }
  assert.equal(clientImageRequest({...body,messages:[{role:'user',content:`<userRequest>${prompt}</userRequest><userRequest>Hello</userRequest>`}]}),null);
});
test('native save uses supplied schema and current workspace without inference or server execution',()=>{
  const result=nativeImageSave(body,artifact);
  assert.equal(result.choices[0].finish_reason,'tool_calls');
  const call=result.choices[0].message.tool_calls[0];const args=JSON.parse(call.function.arguments);
  assert.equal(call.function.name,'run_in_terminal');assert.equal(args.mode,'sync');assert.equal(args.isBackground,false);
  assert.match(args.command,/D:\\projects\\converter/);assert.doesNotMatch(args.command,/other-project/);
  assert.match(args.command,/assets\/mountains.png/);assert.match(args.command,/FileMode\]::CreateNew/);
  assert.match(args.command,/ReparsePoint/);assert.match(args.command,/o''hare/);assert.match(args.command,/EHDA_IMAGE_SAVED:/);
  if(process.platform==='win32') {
    const errors=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      '$ehdaTokens=$null; $ehdaErrors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$ehdaTokens,[ref]$ehdaErrors)|Out-Null; if($ehdaErrors){$ehdaErrors|ForEach-Object {$_.Message};exit 1}'],{input:args.command,encoding:'utf8'});
    assert.equal(errors.trim(),'');
  }
  for(const required of body.tools[0].function.parameters.required) assert.ok(required in args);
  assert.equal(nativeImageSave({...body,messages:[{role:'user',content:prompt}]},artifact),null);
});
test('save completion requires matching nonempty-file evidence and does not create another image',()=>{
  const assistant=nativeImageSave(body,artifact).choices[0].message;
  const id=assistant.tool_calls[0].id;
  const saved={role:'tool',tool_call_id:id,content:'EHDA_IMAGE_SAVED:'+JSON.stringify({path:'D:\\projects\\converter\\assets\\mountains.png',byte_size:1000})};
  assert.equal(imageSaveResult({messages:[...body.messages,assistant,saved]}).mundusx.file_saved,true);
  for(const content of ['download failed','EHDA_IMAGE_SAVED:'+JSON.stringify({path:'C:/elsewhere.png',byte_size:1000}),'EHDA_IMAGE_SAVED:'+JSON.stringify({path:'D:/projects/converter/assets/mountains.png',byte_size:0})])
    assert.equal(imageSaveResult({messages:[assistant,{...saved,content}]}).mundusx.file_saved,false);
  assert.equal(imageSaveResult({messages:[{role:'tool',tool_call_id:'unrelated',content:'saved'}]}),null);
});

test('Windows save command downloads a real response, verifies the file and refuses an overwrite', {skip:process.platform!=='win32'}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ehda-image-save-'));
  const file=path.join(root,'assets','mountains.png');
  t.after(async()=>{await unlink(file).catch(()=>{});await rmdir(path.join(root,'assets')).catch(()=>{});await rmdir(root);});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'image/png'});res.end(png);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const localBody=structuredClone(body);
  localBody.messages[1].content=localBody.messages[1].content.replace('D:\\projects\\converter',root);
  const result=nativeImageSave(localBody,{...artifact,url:`http://127.0.0.1:${server.address().port}/image.png`});
  const command=JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).command;
  const run=()=>promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{timeout:20000});
  const first=await run();assert.match(first.stdout,/EHDA_IMAGE_SAVED:/);assert.deepEqual(await readFile(file),png);
  await assert.rejects(run());assert.deepEqual(await readFile(file),png);
});
