import test from 'node:test';
import assert from 'node:assert/strict';
import { activeImagePrompt, nativeImageSave, imageSaveResult } from '../src/features/media/native-image-save.js';
import { clientImageRequest } from '../src/features/media/client-delivery.js';
import { execFileSync } from 'node:child_process';

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
