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
