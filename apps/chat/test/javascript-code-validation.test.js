import test from "node:test";
import assert from "node:assert/strict";
import { repairJavascriptCodeBlocks, javascriptSyntaxError } from "../src/javascript-code-validation.js";

test("valid CommonJS and ESM need no syntax repair", async () => {
  const source = "```js\nconst app = require('express')();\n```\n```javascript\nexport const value = 1;\n```";
  assert.equal(await repairJavascriptCodeBlocks(source, () => assert.fail("unexpected repair")), source);
});
test("repair replaces only the malformed JavaScript block", async () => {
  const source = "Intro\n```json\n{\"keep\":true}\n```\n```js\nrouter.delete/:id', handler);\n```\nFooter";
  let calls = 0;
  const result = await repairJavascriptCodeBlocks(source, async (code, error) => {
    calls++; assert.match(error, /Unexpected token/); assert.match(code, /router/);
    return "```js\nrouter.delete('/:id', handler);\n```";
  });
  assert.equal(calls, 1); assert.match(result, /Footer$/); assert.match(result, /\{\"keep\":true\}/);
  assert.match(result, /router.delete\('\/:id'/);
});
test("invalid repair is rejected after one attempt", async () => {
  let calls = 0;
  await assert.rejects(repairJavascriptCodeBlocks("```js\nconst x = ;\n```", async () => { calls++; return "const x = ;"; }), /still has a syntax error/);
  assert.equal(calls, 1);
});
test("syntax repair has a bounded call count", async () => {
  let calls = 0;
  await assert.rejects(repairJavascriptCodeBlocks("```js\nconst a = ;\n```\n".repeat(3), async () => { calls++; return "const a = 1;"; }), /too many syntax errors/);
  assert.equal(calls, 2); assert.equal(javascriptSyntaxError("const a = 1;"), null);
});


test("mislabeled dotenv and JSON files are preserved without JavaScript repairs", async () => {
  for (const source of [
    "```javascript\n// .env.example\nNODE_ENV=development\nPORT=3000\nMONGODB_URI=mongodb://localhost:27017/schooldb\nJWT_SECRET=your-secret-key-here\n```",
    "### config/.env.example\n\n```js\nPORT=3000\nMONGODB_URI=mongodb://localhost:27017/schooldb\n```",
    "### package.json\n```javascript\n{\"name\":\"school-api\",\"scripts\":{\"start\":\"node server.js\"}}\n```",
    "```javascript\n// config/settings.yaml\nport: 3000\ndatabase: schooldb\n```",
  ]) {
    assert.equal(await repairJavascriptCodeBlocks(source, () => assert.fail("configuration must not be repaired as JS")), source);
  }
});

test("mixed project files repair actual JavaScript while preserving configuration", async () => {
  const env = "### .env.example\n```javascript\nPORT=3000\nMONGODB_URI=mongodb://localhost:27017/schooldb\n```";
  const source = env + "\n### routes/students.js\n```javascript\n// routes/students.js\nrouter.delete/:id', handler);\n```";
  let calls = 0;
  const repaired = await repairJavascriptCodeBlocks(source, async code => {
    calls++; assert.match(code, /router.delete/);
    return "```js\n// routes/students.js\nrouter.delete('/:id', handler);\n```";
  });
  assert.equal(calls, 1);
  assert.ok(repaired.startsWith(env));
  assert.match(repaired, /router.delete\('/);
});

test("mentioning configuration in a JavaScript comment does not bypass validation", async () => {
  await assert.rejects(repairJavascriptCodeBlocks("```js\n// Load settings from .env.example\nconst value = ;\n```", async () => "const value = ;"), /still has a syntax error/);
});
