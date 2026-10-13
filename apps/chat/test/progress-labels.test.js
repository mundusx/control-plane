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
  const runtime=vm.createContext({document:{createElement:element},describeAgentProgress:describe,meaningfulAgentProgressEvents:context.meaningfulAgentProgressEvents,activeHistoryId:"test",setStatus(){}});
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

test("an expired worker lease replaces stale model progress and recovers after reconnect",()=>{
  const nodes=[];
  const element=()=>{const node={style:{},setAttribute(){},append(){},appendChild(){},replaceChildren(){}};nodes.push(node);return node;};
  const body=element(), statuses=[];
  const runtime=vm.createContext({document:{createElement:element},describeAgentProgress:describe,meaningfulAgentProgressEvents:context.meaningfulAgentProgressEvents,activeHistoryId:"test",setStatus(...args){statuses.push(args);}});
  const html=page();
  vm.runInContext(html.slice(html.indexOf("    function renderLocalAgentProgress("),html.indexOf("    async function tryLiveChatTurn(")),runtime);
  const payload={state:"running",worker_connected:false,events:[{sequence:1131,event:{type:"model_requested"}}]};
  runtime.renderLocalAgentProgress({querySelector:()=>body},payload,"Hermes");
  assert.ok(nodes.some(node=>String(node.textContent).includes("Local worker disconnected")));
  assert.ok(nodes.some(node=>String(node.textContent).includes("Reconnect the MundusX agent")));
  assert.equal(nodes.find(node=>node.className==="agent-progress-dot").style.animation,"none");
  assert.equal(statuses.at(-1)[0],"ready");
  runtime.renderLocalAgentProgress({querySelector:()=>body},{...payload,worker_connected:true},"Hermes");
  assert.equal(statuses.at(-1)[0],"working");
  assert.equal(statuses.at(-1)[1],"Waiting for the model response");
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

test("fallback replaces stale Swarm planning even when sequence ranges are inverted", () => {
  const events = [
    {sequence:1001,created_at:"2026-10-13T10:02:00Z",event:{type:"model_requested"}},
    {sequence:19999,created_at:"2026-10-13T10:01:00Z",event:{type:"swarm_fallback"}},
    {sequence:20000,created_at:"2026-10-13T10:00:00Z",event:{type:"swarm_planning",summary:"Project Swarm is planning independent work"}},
  ];
  const current = context.meaningfulAgentProgressEvents(events).at(-1);
  assert.equal(current.event.type,"model_requested");
  assert.equal(describe({type:"swarm_fallback"},true).label,"Continuing with one Hermes worker");
});

test("generic heartbeat updates do not reset the last meaningful activity marker", () => {
  const payload={state:"running",events:[{sequence:1001,event:{type:"model_requested"}}]};
  const marker=context.agentProgressActivityMarker(payload);
  payload.events.push({sequence:1002,event:{type:"agent_progress",summary:"Hermes is working"}});
  assert.equal(context.agentProgressActivityMarker(payload),marker);
  payload.events.push({sequence:1003,event:{type:"tool_started",metadata:{tool:"read_file"}}});
  assert.notEqual(context.agentProgressActivityMarker(payload),marker);
});

test("restoring an old task uses its actual event time rather than page reload time", () => {
  const at="2026-10-13T10:00:00Z";
  const payload={events:[{sequence:1001,created_at:at,event:{type:"model_requested"}}]};
  assert.equal(context.agentProgressLastActivityAt(payload,Date.parse("2026-10-13T11:00:00Z")),Date.parse(at));
});
