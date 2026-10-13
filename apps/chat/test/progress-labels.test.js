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
