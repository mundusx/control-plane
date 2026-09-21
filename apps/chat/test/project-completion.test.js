import test from "node:test";
import assert from "node:assert/strict";
import { projectCompletionGaps } from "../src/project-completion.js";
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

test("documentation recovery stops after two attempts and reports incomplete", async () => {
  const { result, requests, writes } = await runReply(prompt, [readme, "\nMore details.", "\nOther details."]);
  assert.equal(requests.length, 3);
  assert.equal(result.finishReason, "length");
  assert.doesNotMatch(writes, /"finish_reason":"stop"/);
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
