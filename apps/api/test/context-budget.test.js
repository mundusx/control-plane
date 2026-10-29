const test = require('node:test');
const assert = require('node:assert/strict');
const {budgetContext} = require('../src/context-budget');
const tool = {type:'function',function:{name:'run_in_terminal',description:'Required tool guidance',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}}};
const agent = messages => ({model:'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',messages,tools:[tool]});

test('first-turn fixed overhead is rejected with counts only, without deleting instructions or tools', () => {
  const body=agent([{role:'system',content:'private-rule '.repeat(10000)},{role:'user',content:'hello'}]);
  const original=structuredClone(body);
  assert.throws(()=>budgetContext(body),e=>{
    assert.equal(e.status,400);assert.equal(e.code,'context_budget_exceeded');
    assert.equal(e.contextBudget.dropped_turns,0);
    assert.ok(e.contextBudget.before.components_bytes.instructions>100000);
    assert.ok(!JSON.stringify(e.contextBudget).includes('private-rule'));
    return true;
  });
  assert.deepEqual(body,original);
});

test('old turns are evicted together while instructions, active tool exchanges and schema stay intact', () => {
  const system={role:'system',content:'Always preserve this instruction'};
  const active=[{role:'user',content:'Fix current file'},
    {role:'assistant',content:null,tool_calls:[{id:'active',type:'function',function:{name:'run_in_terminal',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'active',content:'current result'}];
  const body=agent([system,{role:'user',content:'old '.repeat(12000)},
    {role:'assistant',tool_calls:[{id:'old',type:'function',function:{name:'run_in_terminal',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'old',content:'old output'},...active]);
  const {body:prepared,report}=budgetContext(body,{}, {inputTokens:1000,totalTokens:8000,outputTokens:1000});
  assert.equal(report.dropped_turns,1);
  assert.ok(prepared.messages.some(m=>m.content===system.content));
  assert.deepEqual(prepared.messages.slice(-3),active);
  assert.deepEqual(prepared.tools,body.tools);
  assert.ok(report.after.estimated_tokens<=1000);
  assert.equal(body.messages.length,7);
});

test('output reservation constrains input and explicit limits are preserved', () => {
  const body={...agent([{role:'user',content:'hello'}]),max_tokens:1000};
  const result=budgetContext(body,{}, {inputTokens:3000,totalTokens:4096,outputTokens:500});
  assert.equal(result.report.input_budget_tokens,2072);
  assert.equal(result.body.max_tokens,1000);
  assert.throws(()=>budgetContext({...body,max_tokens:4096},{},{inputTokens:3000,totalTokens:4096,outputTokens:500}),{code:'context_budget_exceeded'});
});

test('a late tool result never loses its call when a user interrupts', () => {
  const body=agent([{role:'user',content:'old '.repeat(10000)},
    {role:'assistant',tool_calls:[{id:'cross',type:'function',function:{name:'run_in_terminal',arguments:'{}'}}]},
    {role:'user',content:'continue'}, {role:'tool',tool_call_id:'cross',content:'done'}]);
  assert.throws(()=>budgetContext(body,{}, {inputTokens:1000,totalTokens:8000,outputTokens:1000}),{code:'context_budget_exceeded'});
});

test('ordinary API chats stay unchanged and UTF-8 overhead is counted', () => {
  const body={model:'other',messages:[{role:'user',content:'你好'.repeat(20000)}]};
  const result=budgetContext(body);
  assert.equal(result.body,body);assert.equal(result.report.applied,false);
  assert.ok(result.report.before.bytes>120000);
  const ide=budgetContext({model:'other',messages:[{role:'user',content:'hello'}]}, {'user-agent':'vscode-copilot'});
  assert.equal(ide.body.max_tokens,4096);
});
