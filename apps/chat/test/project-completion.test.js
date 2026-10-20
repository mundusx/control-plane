import test from "node:test";
import assert from "node:assert/strict";
import { apiImplementationGaps, projectCompletionGaps } from "../src/project-completion.js";
import { configFromEnv, streamChatTurn } from "../src/main.js";

const prompt = "i want a fulld nodejs code of CRUD api with swagger , carwash backend";
const readme = "## README.md\n```markdown\n# CarWash Backend API\n\n## Setup\n1. Install dependencies: npm install\n2. Create .env from .env.example\n3. Start MongoDB\n4. Run npm start\n\n## API Documentation\nVisit http://localhost:3000/api-docs\n\n## License\nMIT\n```";
const summary = "\n\n## Delivery summary\n\nDelivered the CRUD API and Swagger documentation. Follow the README to start it and check /api-docs. This generated code has not been executed or tested here.\n";

test("README ending at MIT needs a wrap-up outside the file", () => {
  assert.equal(projectCompletionGaps(readme).length, 1);
  assert.deepEqual(projectCompletionGaps(readme + summary), []);
  assert.equal(projectCompletionGaps(readme.replace(/```$/, summary + "```" )).length, 1);
  assert.equal(projectCompletionGaps(summary + readme).length, 1);
});

test("a promised README and an empty summary are not completed deliverables", () => {
  assert.equal(projectCompletionGaps("```text\ncarwash/\n  README.md\n```\n## Delivery summary\n").length, 2);
  assert.deepEqual(projectCompletionGaps("An ordinary chat reply."), []);
  assert.equal(projectCompletionGaps("## README.md\n```markdown\n# License\nMIT\n```" + summary).length, 1);
});

async function runReply(message, segments) {
  const writes = []; const requests = [];
  const response = {
    writableEnded: false,
    writeHead() {}, flushHeaders() {},
    write(value) { writes.push(String(value)); return true; },
    end(value) { this.writableEnded = true; if (value) writes.push(String(value)); },
  };
  const result = await streamChatTurn(response,
    { message, historyMessages: [], toolMode: false },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://control.test" }),
    async (_url, init) => {
      const request = JSON.parse(init.body);
      const index = requests.length; requests.push(request);
      assert.ok(index < segments.length, "unexpected extra generation");
      const spec = segments[index];
      const segment = typeof spec === "string" ? { text: spec } : spec;
      const anchor = index ? request.messages.at(-1).content.match(/CONTINUATION_ANCHOR:\n([\s\S]*?)\nEND_CONTINUATION_ANCHOR/)?.[1] ?? "" : "";
      return new Response(
        `data: ${JSON.stringify({ id: "chatcmpl-carwash", choices: [{ delta: { content: (segment.raw ? "" : anchor) + segment.text }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-carwash", choices: [{ delta: {}, finish_reason: segment.finish || "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
  return { result, writes: writes.join(""), requests };
}

test("carwash normal stop resumes missing wrap-up without duplicating the README", async () => {
  const { result, writes, requests } = await runReply(prompt, [readme, summary]);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /Complete these missing deliverables only/);
  assert.equal(result.content, readme + summary);
  assert.equal(result.finishReason, "stop");
  assert.equal((writes.match(/"finish_reason":"stop"/g) ?? []).length, 1);
  assert.equal((writes.match(/data: \[DONE\]/g) ?? []).length, 1);
});

test("complete documentation does not cause an extra model request", async () => {
  const { result, requests } = await runReply(prompt, [readme + summary]);
  assert.equal(requests.length, 1);
  assert.equal(result.finishReason, "stop");
});

test("plain and bold delivery summaries complete the response without needless continuation", async () => {
  const body = "The Student Enrollment API includes the controller, service, repository and entity. " +
    "Follow README.md and run mvn spring-boot:run, then check Swagger UI. " +
    "The generated code has not been executed here; H2 storage is in memory and authentication is not included.";
  for (const label of ["Delivery summary:", "**Delivery summary:**", "**Delivery summary**:", "## Delivery summary\n"]) {
    const complete = readme + "\n\n" + label + " " + body;
    assert.deepEqual(projectCompletionGaps(complete), []);
    const { result, requests, writes } = await runReply(prompt, [complete]);
    assert.equal(requests.length, 1);
    assert.equal(result.finishReason, "stop");
    assert.doesNotMatch(writes, /"finish_reason":"length"/);
  }
});

test("summary labels still need content outside and after the README file", () => {
  assert.equal(projectCompletionGaps(readme + "\n\nDelivery summary:").length, 1);
  assert.equal(projectCompletionGaps("Delivery summary: Delivered the API.\n\n" + readme).length, 1);
  assert.equal(projectCompletionGaps(readme.replace(/```$/, "Delivery summary: Delivered the API.\n```" )).length, 1);
});

test("wrap-ups accept arbitrary headings, plain prose and bullets", async () => {
  for (const ending of [
    "The API is ready to review. Run it using README.md. Tests have not been executed here.",
    "## What you have\nThe API includes enrollment endpoints. H2 data resets on restart.",
    "- Run mvn spring-boot:run.\n- Open Swagger UI to check the endpoints.\n- No authentication is included.",
    "**Verification and limitations**\nThis source has not been compiled here.",
  ]) {
    const complete = readme + "\n\n" + ending;
    const { result, requests } = await runReply(prompt, [complete]);
    assert.deepEqual(projectCompletionGaps(complete), []);
    assert.equal(requests.length, 1);
    assert.equal(result.finishReason, "stop");
  }
});

test("wrap-up recovery finishes an open README fence before the summary", async () => {
  const first = readme.replace(/```$/, "");
  const { result } = await runReply(prompt, [first, "\n```\n" + summary]);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(projectCompletionGaps(result.content), []);
});

test("code-only requests do not acquire a closing summary", async () => {
  const { result, requests } = await runReply(prompt + ", code only", [readme]);
  assert.equal(requests.length, 1);
  assert.equal(result.content, readme);
});

test("documentation-only recovery stops after two attempts with a visible documentation warning", async () => {
  const { result, requests, writes } = await runReply(prompt, [readme, "\n## More details\n", "\n## Other details\n"]);
  assert.equal(requests.length, 3);
  assert.equal(result.finishReason, "stop");
  assert.match(result.content, /Documentation could not be completed/);
  assert.doesNotMatch(writes, /"finish_reason":"length"/);
});

test("nested README command fences do not trigger duplicate project generation", async () => {
  for (const fence of ["```", "````"]) {
    const file = "## README.md\n" + fence + "markdown\n# Setup\n```bash\nnpm install\n```\n# Run\n```bash\nnpm start\n```\n" + fence;
    assert.deepEqual(projectCompletionGaps(file + summary), []);
    const { result, requests } = await runReply(prompt, [file + summary]);
    assert.equal(requests.length, 1);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.content, file + summary);
  }
});

test("rejected Swagger continuation retries before checking missing README", async () => {
  const first = "## Project structure\nREADME.md\n## routes/cars.js\n```js\n/**\n * schema:\n *   type: object\n * /cars/{id}:\n *   put:\n *     requestBody:\n *       required: true\n *       content:";
  const rejected = { text: "```json\n *   type: object\nSkipped Swagger lines\n```", raw: true };
  const suffix = "\n *         application/json: {}\n */\n```\n" + readme + summary;
  const { result, requests, writes } = await runReply(prompt, [
    { text: first, finish: "length" }, rejected, suffix,
  ]);
  assert.equal(requests.length, 3);
  assert.equal(result.content, first + suffix);
  assert.equal(result.finishReason, "stop");
  assert.match(requests[2].messages.at(-1).content, /first repeat CONTINUATION_ANCHOR exactly/);
  assert.match(requests[2].messages[0].content, /first copy the latest CONTINUATION_ANCHOR exactly/);
  assert.doesNotMatch(writes, /Skipped Swagger lines/);
});

test("repeated unsafe continuations remain bounded and preserve the original code", async () => {
  const first = "README.md\n```js\nconst existingController = true;\nconst nextController =";
  const rejected = { text: "```js\nconst existingController = true;\n```", raw: true };
  const { result, requests } = await runReply(prompt, [{ text: first, finish: "length" }, rejected, rejected, rejected]);
  assert.equal(requests.length, 4);
  assert.equal(result.finishReason, "length");
  assert.equal(result.content, first);
});


test("filename-labelled README fences do not request duplicate documentation", async () => {
  for (const label of ["README.md", "docs/README.md"]) {
    const file = "```" + label + "\n```markdown\n# Bus API\n\n## Installation\n```bash\nnpm install\n```\n\n## Run\n```bash\nnpm start\n```\n```\n";
    assert.deepEqual(projectCompletionGaps(file + summary), []);
    const {result,requests} = await runReply(prompt,[file + summary]);
    assert.equal(requests.length,1);
    assert.equal(result.finishReason,"stop");
  }
});

test("documentation-only follow-ups cannot graft restarted source onto a completed response", async () => {
  const source='## Project Structure\n```text\nstudent-api/\n  README.md\n```\n```rust\nuse diesel::prelude::*;\nuse diesel::sqlite::SqliteConnection;\npub fn delete_student() {}\n```';
  const {result,requests}=await runReply(prompt,[source,{raw:true,text:source},{raw:true,text:source}]);
  assert.equal(requests.length,3);
  assert.equal(result.finishReason,'stop');
  assert.equal(result.content.split('pub fn delete_student').length-1,1);
  assert.match(result.content,/Documentation could not be completed/);
  assert.match(requests[1].messages.find(m=>m.role==='system').content,/documentation-only/);
});

const schoolPrompt = "fast api CRUD for schoolmanagement system";
const schemasOnly = "## app/schemas.py\n```python\nclass StudentCreate: pass\nclass StudentUpdate: pass\n```";
const runnableRoutes = "\n## app/main.py\n```python\nfrom fastapi import FastAPI\napp = FastAPI()\n@app.get('/students')\ndef list_students(): return []\n@app.post('/students')\ndef create_student(): return {}\n@app.patch('/students/{id}')\ndef update_student(id: int): return {}\n@app.delete('/students/{id}')\ndef delete_student(id: int): return {}\n```";

test("FastAPI schemas alone do not satisfy a whole CRUD API request", () => {
  assert.equal(apiImplementationGaps(schoolPrompt, schemasOnly).length, 2);
  assert.deepEqual(apiImplementationGaps(schoolPrompt, schemasOnly + runnableRoutes), []);
  assert.deepEqual(apiImplementationGaps("Only give me models and schemas for FastAPI CRUD", schemasOnly), []);
  assert.deepEqual(apiImplementationGaps("Explain FastAPI CRUD", schemasOnly), []);
});

test("a normal stop after schemas recovers missing application and routes", async () => {
  const { result, requests } = await runReply(schoolPrompt, [schemasOnly, runnableRoutes]);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /missing implementation deliverables/);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(apiImplementationGaps(schoolPrompt, result.content), []);
});

test("an implementation that remains missing does not publish successful stop", async () => {
  const { result, writes, requests } = await runReply(schoolPrompt, [schemasOnly,
    "\n# Models are now ready.\n", "\n# Schemas are now ready.\n"]);
  assert.equal(requests.length, 3);
  assert.equal(result.finishReason, "error");
  assert.match(result.error, /Implementation incomplete/);
  assert.equal((writes.match(/"finish_reason":"stop"/g) ?? []).length, 0);
});
