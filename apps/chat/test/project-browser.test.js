import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import { PostgresAuthStore } from "../src/auth.js";

test("opening a project closes the other tree; arrows do not change the working project", async () => {
  const source = readFileSync(new URL("../src/features/project-browser-ui.js", import.meta.url), "utf8");
  const context = vm.createContext({ expandedProject:"old", expandedProjectPaths:new Set(["old:src"]), selected:"old", renders:0, loaded:[],
    setActiveProject(project) { context.selected = project.slug; }, setWorkspaceDestination() {},
    renderSidebarProjects() { context.renders++; }, async loadProjectDirectory(...args) { context.loaded.push(args); },
    projectTreeKey:(slug,path) => slug + ":" + path,
  });
  vm.runInContext(source.slice(source.indexOf("async function handleProjectTreeClick"), source.indexOf("sidebarProjectListEl?.addEventListener")), context);
  const click = (slug, action) => context.handleProjectTreeClick({target:{closest:()=>({dataset:{treeAction:action,projectSlug:slug,path:""},closest:()=>({dataset:{}})})}});
  await click("fe", "select");
  assert.equal(context.expandedProject, "fe"); assert.equal(context.selected, "fe"); assert.equal(context.expandedProjectPaths.size, 0);
  await click("frontendtest", "toggle");
  assert.equal(context.expandedProject, "frontendtest"); assert.equal(context.selected, "fe");
  await click("frontendtest", "toggle"); assert.equal(context.expandedProject, null);
});

test("file operations preserve coding tasks and are only claimed by capable connectors", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table users (id uuid primary key)");
    for (const name of ["0026_local_agent_bridge.sql", "0030_hermes_agent_runtime.sql", "0031_local_agent_workspace_boundary.sql"]) {
      await db.exec(readFileSync(new URL("../../../db/migrations/" + name, import.meta.url), "utf8"));
    }
    const user = randomUUID(), old = randomUUID(), current = randomUUID();
    await db.query("insert into users values ($1)", [user]);
    await db.query("insert into local_agent_connections (connection_id,user_id,device_name,capabilities) values ($1,$3,'old','{}'),($2,$3,'new','{\"project_browser\":true}')", [old,current,user]);
    const query = async (sql,args) => { const result = await db.query(sql,args); return {...result,rowCount:result.rows.length || result.affectedRows || 0}; };
    const store = new PostgresAuthStore({}, {pool:{query}});
    const code = await store.createLocalAgentTask(user, {prompt:"Build a frontend",workspace_relative:"fe"});
    const request = "MUNDUSX_PROJECT_IO_V1:" + JSON.stringify({operation:"list",connection_id:current});
    const browse = await store.createLocalAgentTask(user, {prompt:request,workspace_relative:"fe"});
    assert.equal((await query("select state from local_agent_tasks where task_id=$1",[code.task_id])).rows[0].state,"queued");
    assert.equal(await store.claimLocalAgentTask(user,old,true),null);
    assert.equal((await store.claimLocalAgentTask(user,current,true)).task_id,browse.task_id);
    assert.equal(await store.claimLocalAgentTask(user,current,true),null,"busy worker cannot claim another model task");
    assert.equal((await store.claimLocalAgentTask(user,current)).task_id,code.task_id);
    assert.equal((await store.localAgentTask(user,code.task_id)).worker_connected,true);
    await query("update local_agent_tasks set lease_expires_at=now()-interval '1 second' where task_id=$1",[code.task_id]);
    const disconnected = await store.localAgentTask(user,code.task_id);
    assert.equal(disconnected.worker_connected,false,"expired leases cannot appear to be live workers");
    assert.equal(disconnected.state,"running","reading status must retain reconnect recovery eligibility");
    await store.heartbeatLocalAgentTask(user,current,code.task_id);
    assert.equal((await store.localAgentTask(user,code.task_id)).worker_connected,true);
    const pending = await store.createLocalAgentTask(user,{prompt:request,workspace_relative:"fe"});
    await store.createLocalAgentTask(user,{prompt:"Continue the frontend",workspace_relative:"fe"});
    assert.equal((await query("select state from local_agent_tasks where task_id=$1",[pending.task_id])).rows[0].state,"queued");
    await query("insert into local_agent_task_events(task_id,sequence,event) select $1::uuid,n,'{\"type\":\"tool_completed\"}'::jsonb from generate_series(1,550) n",[pending.task_id]);
    const recent = await store.localAgentTask(user,pending.task_id);
    assert.equal(recent.events.length,500);
    assert.equal(Number(recent.events[0].sequence),51);
    assert.equal(Number(recent.events.at(-1).sequence),550,"long tasks retain their newest progress");
    await query("update local_agent_task_events set event=$2::jsonb where task_id=$1 and sequence=1",[pending.task_id,JSON.stringify({type:"assistant_snapshot",metadata:{text:"Earlier answer"}})]);
    assert.equal((await store.localAgentTask(user,pending.task_id)).answer.event.metadata.text,"Earlier answer","refresh recovers answer outside latest 500 progress events");
    await assert.rejects(store.localAgentTask(randomUUID(),pending.task_id),/not found/);
  } finally { await db.close(); }
});

test("a stopped project task holds the next writer until the connector acknowledges shutdown", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table users (id uuid primary key)");
    for (const name of ["0026_local_agent_bridge.sql", "0030_hermes_agent_runtime.sql", "0031_local_agent_workspace_boundary.sql"]) {
      await db.exec(readFileSync(new URL("../../../db/migrations/" + name, import.meta.url), "utf8"));
    }
    const user = randomUUID(), connection = randomUUID();
    await db.query("insert into users values ($1)", [user]);
    await db.query("insert into local_agent_connections (connection_id,user_id,device_name,capabilities) values ($1,$2,'Hermes','{\"agent_runtimes\":[\"hermes\"],\"preferred_agent\":\"hermes\"}')", [connection,user]);
    const query = async (sql,args) => { const result = await db.query(sql,args); return {...result,rowCount:result.rows.length || result.affectedRows || 0}; };
    const store = new PostgresAuthStore({}, {pool:{query}});

    const first = await store.createLocalAgentTask(user, {prompt:"Fix the API",runtime:"hermes",workspace_relative:"marketapp"});
    assert.equal((await store.claimLocalAgentTask(user,connection)).task_id,first.task_id);
    const stopped = await store.cancelLocalAgentTask(user,first.task_id);
    assert.equal(stopped.state,"cancelled");
    assert.equal(stopped.completed_at,null,"a running cancellation waits for connector shutdown");

    const next = await store.createLocalAgentTask(user, {prompt:"Fix the lint errors",runtime:"hermes",workspace_relative:"marketapp"});
    assert.equal(next.waiting_for_previous_task,true);
    assert.equal(await store.claimLocalAgentTask(user,connection),null,"the next writer cannot overlap the stopping task");

    const acknowledged = await store.completeLocalAgentTask(user,first.task_id,{status:"failed",error:"cancelled by user"});
    assert.equal(acknowledged.state,"cancelled");
    assert.ok(acknowledged.completed_at);
    const repeated = await store.completeLocalAgentTask(user,first.task_id,{status:"failed",error:"retry after a lost response"});
    assert.equal(repeated.state,"cancelled","terminal completion acknowledgements are idempotent");
    assert.equal(repeated.error,"cancelled by user","a retry cannot replace the recorded terminal result");
    assert.equal((await store.claimLocalAgentTask(user,connection)).task_id,next.task_id);
  } finally { await db.close(); }
});
