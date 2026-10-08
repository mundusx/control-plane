import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const restoreCode = source.slice(source.indexOf("    async function restoreActiveConversation()"), source.indexOf("    function reattachConversationStream("));

function browser({ id = "selected", history = [{ conversationId: "selected" }], cached = [], fetchMessages = async () => [{ role: "user", content: "Saved question" }] } = {}) {
  const rendered = [];
  const storage = new Map();
  const context = vm.createContext({
    activeHistoryId: id, activeHistoryLoadToken: 0, loadingHistoryConversationId: null,
    conversationIdKey: "user-scoped-key", localStorage: { setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    readHistory: () => history, readCachedConversation: () => cached,
    conversationCachePrefix: "cache:", writeHistory: (items) => { history = items; },
    newChatEl: { click: () => { context.activeHistoryId = "fresh"; context.activeHistoryLoadToken++; storage.set("user-scoped-key", "fresh"); } },
    fetchConversationMessages: fetchMessages, promptEl: { value: "" },
    renderHistory() {}, setStatus() {}, clearConversation() { rendered.length = 0; },
    renderStoredTurn: (turn) => rendered.push(turn.content), addMessage: (text) => rendered.push(text),
    syncNetworkRuntimeStatus() {}, reattachConversationStream() {}, scrollChatToLatest() {},
  });
  vm.runInContext(restoreCode, context);
  return { context, rendered, storage, restore: () => context.restoreActiveConversation() };
}

test("authentication restores the user-scoped selection before recovering a pending prompt", () => {
  const bootstrap = source.slice(source.indexOf("    async function bootstrapAuthentication()"), source.indexOf("    function openAuthentication()"));
  assert.ok(bootstrap.indexOf("activeHistoryId = localStorage.getItem(conversationIdKey)") < bootstrap.indexOf("await restoreActiveConversation()"));
  assert.ok(bootstrap.indexOf("await restoreActiveConversation()") < bootstrap.indexOf("const pendingPrompt"));
});

test("refresh restores the selected conversation, not the first history entry", async () => {
  const app = browser({ history: [{ conversationId: "other" }, { conversationId: "selected" }], fetchMessages: async (id) => {
    assert.equal(id, "selected");
    return [{ content: "Saved question" }, { content: "Saved answer" }];
  } });
  await app.restore();
  assert.deepEqual(app.rendered, ["Saved question", "Saved answer"]);
  assert.equal(app.storage.get("user-scoped-key"), "selected");
});

test("refresh keeps New Chat blank even with older conversations", async () => {
  const app = browser({ id: "new-chat", fetchMessages: async () => { assert.fail("must not fetch an empty chat"); } });
  await app.restore();
  assert.deepEqual(app.rendered, []);
  assert.equal(app.context.activeHistoryId, "new-chat");
});

test("first visit without a selection stays blank", async () => {
  const app = browser({ id: null });
  await app.restore();
  assert.deepEqual(app.rendered, []);
});

test("refresh restores cached messages when the backend is unavailable", async () => {
  const app = browser({ history: [], cached: [{ content: "Cached discussion" }], fetchMessages: async () => { throw new Error("offline"); } });
  await app.restore();
  assert.deepEqual(app.rendered, ["Cached discussion"]);
});

test("selecting another chat while restoration is pending wins", async () => {
  let finish;
  const app = browser({ fetchMessages: (id) => id === "selected" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve([{ content: "Other discussion" }]) });
  const restoring = app.restore();
  await app.context.loadHistoryItem({ conversationId: "other" });
  finish([{ content: "Old discussion" }]);
  await restoring;
  assert.equal(app.context.activeHistoryId, "other");
  assert.deepEqual(app.rendered, ["Other discussion"]);
});

test("New Chat cancels a pending restoration", async () => {
  let finish;
  const app = browser({ fetchMessages: () => new Promise((resolve) => { finish = resolve; }) });
  const restoring = app.restore();
  app.context.activeHistoryLoadToken += 1;
  app.context.activeHistoryId = "new-chat";
  finish([{ content: "Old discussion" }]);
  await restoring;
  assert.deepEqual(app.rendered, []);
});

const resumeCode = source.slice(source.indexOf("    async function resumePersistedLocalAgentTask()"), source.indexOf("    async function resumeLocalAgentPolling("));

test("task recovery does not reopen an old chat after selecting another chat or New Chat", async () => {
  for (const selected of ["other", "new-chat"]) {
    const context = vm.createContext({
      activeHistoryId: selected, activeAgentTaskKey: "task",
      localStorage: { getItem: () => JSON.stringify({ taskId: "task-1", conversationId: "old" }) },
      fetch: async () => assert.fail("must not resume an unselected conversation"),
    });
    vm.runInContext(resumeCode, context);
    assert.equal(await context.resumePersistedLocalAgentTask(), false);
    assert.equal(context.activeHistoryId, selected);
  }
});

test("switching chats while task recovery fetches does not switch back", async () => {
  let finish;
  const context = vm.createContext({
    activeHistoryId: "old", activeAgentTaskKey: "task",
    localStorage: { getItem: () => JSON.stringify({ taskId: "task-1", conversationId: "old" }) },
    fetch: () => new Promise((resolve) => { finish = resolve; }),
    readApiPayload: async () => ({ state: "running" }),
    readHistory: () => assert.fail("must not restore the old chat after switching"),
  });
  vm.runInContext(resumeCode, context);
  const recovering = context.resumePersistedLocalAgentTask();
  context.activeHistoryId = "other";
  finish({ ok: true });
  assert.equal(await recovering, false);
  assert.equal(context.activeHistoryId, "other");
});


test("a rejected history selection discards its local cache and opens a fresh chat", async () => {
  const app = browser({ cached: [{ content: "Must not render a rejected conversation" }],
    fetchMessages: async () => { throw Object.assign(new Error("Conversation is not available to this user"), { statusCode: 404 }); } });
  app.storage.set("cache:selected", "stale cache");
  await app.restore();
  assert.deepEqual(app.rendered, []);
  assert.equal(app.context.activeHistoryId, "fresh");
  assert.equal(app.storage.get("user-scoped-key"), "fresh");
  assert.equal(app.storage.has("cache:selected"), false);
  assert.equal(app.context.readHistory().length, 0);
});

test("a late access rejection cannot reset a newly selected conversation", async () => {
  let reject;
  const app = browser({ fetchMessages: (id) => id === "selected" ? new Promise((_, no) => { reject = no; }) : Promise.resolve([{ content: "Other discussion" }]) });
  const restoring = app.restore();
  await app.context.loadHistoryItem({ conversationId: "other" });
  reject(Object.assign(new Error("not available"), { statusCode: 404 }));
  await restoring;
  assert.equal(app.context.activeHistoryId, "other");
  assert.deepEqual(app.rendered, ["Other discussion"]);
});
