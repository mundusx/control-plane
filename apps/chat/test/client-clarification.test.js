import test from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_TYPE_QUESTION, clientMediaClarification } from '../src/features/media/client-clarification.js';
import { clientImageCompletion, clientImageRequest } from '../src/features/media/client-delivery.js';
const tools=[{type:'function',function:{name:'run_in_terminal',parameters:{properties:{command:{type:'string'}}}}}];
const request=text=>({tools,messages:[{role:'user',content:text}]});
const resume=choice=>({...request('create walking cat with hat'),messages:[...request('create walking cat with hat').messages,{role:'assistant',content:MEDIA_TYPE_QUESTION},{role:'user',content:choice}]});

test('ambiguous visual requests ask without submitting any work',async()=>{
 for(const prompt of ['create walking cat with hat','create garfiled cat in nija custom']) {
  const body=request(prompt);
  assert.equal(clientMediaClarification(body).action,'ask');
  const response=await clientImageCompletion(body,{service:{submit:()=>assert.fail('must not submit')}});
  assert.equal(response.choices[0].message.content,MEDIA_TYPE_QUESTION);
  assert.equal(response.mundusx.job_started,false);
 }
});
test('PNG resumes only a pending clarification and preserves original prompt',()=>{
 assert.equal(clientImageRequest(resume('PNG')).kind,'image');
 assert.match(clientImageRequest(resume('PNG')).prompt,/walking cat with hat/);
 assert.equal(clientImageRequest(request('PNG')),null);
 assert.equal(clientImageRequest({...resume('PNG'),messages:[{role:'user',content:'PNG'}]}),null);
 assert.equal(clientMediaClarification({...resume('PNG'),messages:[{role:'user',content:'create cat'},{role:'tool',content:MEDIA_TYPE_QUESTION},{role:'user',content:'PNG'}]}),null);
 for(const text of ['hello','create a file for my cat','create a cat component','how do I create a cat','do not create a cat','create a story about a cat'])assert.equal(clientImageRequest(request(text)),null,text);
});
test('explicit images bypass question; other types never enqueue PNG',async()=>{
 assert.equal(clientImageRequest(request('create an image of a cat')).kind,'image');
 assert.equal(clientImageRequest(request('create cat as PNG')).kind,'image');
 for(const type of ['animation','sb3','Scratch project']) {
  const result=await clientImageCompletion(resume(type),{service:{submit:()=>assert.fail('must not submit')}});
  assert.match(result.choices[0].message.content,/not connected yet/);
  assert.equal(result.mundusx.job_started,false);
 }
 assert.equal(clientMediaClarification(resume('cancel')),null);
});
test('PNG continuation submits the original scene once and carries original workspace into save',async()=>{
 const original='<environment_info>The current OS is: Windows</environment_info><workspace_info>I am working in a workspace with the following folders:\n- D:\\projects\\cats\nFiles</workspace_info><userRequest>create walking cat with hat</userRequest>';
 const body={tools,messages:[{role:'user',content:original},{role:'assistant',content:MEDIA_TYPE_QUESTION},{role:'user',content:'yes'},{role:'assistant',content:MEDIA_TYPE_QUESTION},{role:'user',content:'PNG'}]};
 const before=structuredClone(body);let submissions=0;
 const result=await clientImageCompletion(body,{owner:'user',service:{
  submit:async(owner,input)=>{submissions++;assert.match(input.prompt,/walking cat with hat/);return {job_id:'test',state:'completed',client_delivery:{action:'download_to_workspace',execution_owner:'client'}};},
  result:async()=>({content_type:'image/png',download_url:'https://example.com/cat.png'}),
 }});
 assert.equal(submissions,1);
 assert.equal(result.mundusx.file_saved,false);
 assert.equal(result.choices[0].finish_reason,'tool_calls');
 assert.match(result.choices[0].message.tool_calls[0].function.arguments,/projects/);
 assert.deepEqual(body,before);
 assert.equal(clientMediaClarification(body).originalMessage.content,original);
});
