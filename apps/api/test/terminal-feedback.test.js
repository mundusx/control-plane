const test=require('node:test');const assert=require('node:assert/strict');
const {terminalFeedbackPolicy:apply}=require('../src/terminal-feedback');
const tools=[{type:'function',function:{name:'run_in_terminal'}}];
test('stop-server policy scopes the port and explains success, missing processes and connection states',()=>{
 const body={tools,messages:[{role:'user',content:'kill this http://localhost:3000/'},{role:'assistant',tool_calls:[{id:'call',function:{name:'run_in_terminal',arguments:'{}'}}]},{role:'tool',tool_call_id:'call',content:'SUCCESS: terminated node.exe'}]};
 const result=apply(body);assert.deepEqual(result.messages.slice(0,-1),body.messages);assert.deepEqual(result.tools,tools);
 for(const evidence of ['-LocalPort 3000 -State Listen','verified listener PID','process-not-found','ESTABLISHED','TIME_WAIT','already stopped'])assert.ok(result.messages.at(-1).content.includes(evidence));
});
test('old stop requests cannot activate the policy for a different task or injected command',()=>{
 for(const content of ['hello','explain how to stop localhost:3000','kill localhost:3000; Remove-Item x','kill localhost:99999']){
 const body={tools,messages:[{role:'user',content:'stop localhost:3000'},{role:'user',content}]};assert.equal(apply(body),body);
 }
});
