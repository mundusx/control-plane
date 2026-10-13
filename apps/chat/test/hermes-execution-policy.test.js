import test from "node:test";
import assert from "node:assert/strict";
import {applyHermesExecutionPolicy} from "../src/features/agent/execution-policy.js";
import {PostgresAuthStore} from "../src/auth.js";
const task = prompt => ({runtime_selected:"hermes",allow_mutations:true,prompt});
test("ordinary new and large project requests use one worker without mutating the user prompt", () => {
  for (const prompt of ["Create a complete CRUD API", "Build a React frontend and backend from scratch", "What is wrong with Project Swarm?"]) {
    const original=task(prompt), result=applyHermesExecutionPolicy(original);
    assert.equal(original.prompt,prompt);
    assert.equal(result.execution_policy,"single-worker");
    assert.match(result.prompt,/Use one worker\. Do not use Project Swarm\./);
    assert.ok(result.prompt.endsWith(prompt));
  }
});
test("Swarm is explicitly enabled and an explicit single-worker instruction takes precedence", () => {
  const prompt="Use Project Swarm to build this API";
  assert.equal(applyHermesExecutionPolicy(task(prompt)).prompt,prompt);
  assert.equal(applyHermesExecutionPolicy(task(prompt+"; use one worker")).execution_policy,"single-worker");
});
test("file operations, read-only tasks, native workers and empty claims remain unchanged", () => {
  for (const value of [null, task('MUNDUSX_PROJECT_IO_V1:{"operation":"list"}'), {...task("hello"),allow_mutations:false}, {...task("hello"),runtime_selected:"native"}]) {
    assert.equal(applyHermesExecutionPolicy(value),value);
  }
});
test("task claims enforce policy in the worker response without writing a different stored prompt", async () => {
  const original=task("Create a complete API"), queries=[];
  const store=new PostgresAuthStore({}, {pool:{async query(sql){queries.push(sql); return {rows:[original],rowCount:1};}}});
  const result=await store.claimLocalAgentTask("11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222",false,false);
  assert.equal(result.execution_policy,"single-worker");
  assert.equal(original.prompt,"Create a complete API");
  assert.equal(queries.length,1);
});
