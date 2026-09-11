import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {page} from "../src/main.js";
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/features/agent/progress-labels.js",import.meta.url),"utf8"),context);
const describe = context.describeAgentProgress;

test("queued tasks render before any progress event exists",()=>{
  assert.equal(describe(null).label,"Waiting for the connector");
  assert.equal(describe(undefined).label,"Waiting for the connector");
  const nodes=[];
  const element=()=>{const node={style:{},setAttribute(){},append(){},appendChild(){},replaceChildren(){}};nodes.push(node);return node;};
  const body=element();
  const runtime=vm.createContext({document:{createElement:element},describeAgentProgress:describe,activeHistoryId:"test",setStatus(){}});
  const html=page();
  vm.runInContext(html.slice(html.indexOf("    function renderLocalAgentProgress("),html.indexOf("    async function tryLiveChatTurn(")),runtime);
  for(const events of [undefined,[],[null,{event:null}]]) {
    runtime.renderLocalAgentProgress({querySelector:()=>body},{state:"queued",events},"Hermes");
  }
  assert.ok(nodes.some(node=>String(node.textContent).includes("Waiting for the connector")));
});

test("progress distinguishes model calls, program execution and verification",()=>{
  assert.equal(describe({type:"model_requested"}).source,"Model");
  const run=describe({type:"tool_started",metadata:{tool:"terminal",activity:"run"}});
  assert.equal(run.label,"Running the program"); assert.equal(run.source,"Tool");
  assert.match(describe({type:"tool_started",metadata:{activity:"test"}}).label,/Running tests/);
  assert.match(describe({type:"tool_started",metadata:{verification:true}}).label,/verification/);
});
test("failed and unknown tool results are never reported as successful",()=>{
  for (const [success,outcome] of [[false,"failed"],[null,"unknown"],[true,"succeeded"]]) {
    const result=describe({type:"tool_completed",metadata:{activity:"build",success}},true);
    assert.equal(result.outcome,outcome); assert.match(result.purpose,/tool has finished/);
    if(success!==true) assert.doesNotMatch(result.label,/succeeded/);
    if(success===null) assert.match(result.label,/ — finished$/);
    assert.doesNotMatch(result.label,/unconfirmed|verified/i);
  }
});
