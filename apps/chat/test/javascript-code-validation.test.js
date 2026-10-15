import test from "node:test";
import assert from "node:assert/strict";
import { repairJavascriptCodeBlocks, javascriptSyntaxError, requestJavascriptSyntaxRepair } from "../src/javascript-code-validation.js";

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

test("single-file syntax repair uses one direct completion without chat orchestration", async () => {
 let requests=0;
 const result=await requestJavascriptSyntaxRepair('router.get/:id, handler);','Unexpected token',{controlPlaneUrl:'https://control.test',operatorToken:'test-service-token'},async(url,init)=>{
  requests++;assert.equal(url,'https://control.test/v1/chat/completions');
  const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.equal(body.messages.length,2);
  assert.equal(body.model,'test-model');assert.ok(body.max_tokens>=1024);
  assert.match(body.messages[1].content,/router.get/);assert.match(body.messages[0].content,/one JavaScript module/);
  assert.equal(init.headers.Authorization,'Bearer test-service-token');
  return Response.json({choices:[{message:{content:"```javascript\nrouter.get('/:id', handler);\n```"},finish_reason:'stop'}]});
 },'test-model');
 assert.equal(requests,1);assert.match(result,/router.get\('/);
});
test("truncated and empty syntax repairs are rejected rather than accepted as modules",async()=>{
 for(const choice of [{message:{content:'```js\nconst value ='},finish_reason:'length'},{message:{content:''},finish_reason:'stop'}]){
  await assert.rejects(requestJavascriptSyntaxRepair('bad','syntax',{controlPlaneUrl:'https://control.test'},async()=>Response.json({choices:[choice]}),'test-model'),/complete module/);
 }
});

test("a changed module gets one bounded repair for its remaining parser error",async()=>{
 let calls=0;
 const result=await repairJavascriptCodeBlocks('```js\nconst a = ;\nconst b = ;\n```',async(code,error)=>{
  calls++;assert.match(error,/Unexpected token/);
  if(calls===1)return '```js\nconst a = 1;\nconst b = ;\n```';
  assert.match(code,/const a = 1/);return '```js\nconst a = 1;\nconst b = 2;\n```';
 });
 assert.equal(calls,2);assert.match(result,/const b = 2/);
});
test("multiple replacement modules cannot silently replace a single source file",async()=>{
 await assert.rejects(repairJavascriptCodeBlocks('```js\nconst a = ;\n```',async()=> '```js\nconst a = 1;\n```\n```js\nconst b = 2;\n```'),/multiple modules/);
});

test("an empty fenced repair cannot erase a source file",async()=>{
 await assert.rejects(repairJavascriptCodeBlocks('```js\nconst a = ;\n```',async()=> '```javascript\n\n```'),/empty module/);
});

test("invalid punctuation-only email ranges are repaired without a model call",async()=>{
 const code=String.raw`const email = /^[A-Za-z]+([\.-\+])?\w+@\w+\.com$/;`;
 const source='```javascript\n'+code+'\n```';
 assert.match(javascriptSyntaxError(code),/Range out of order/);
 const repaired=await repairJavascriptCodeBlocks(source,()=>assert.fail('punctuation escape must not use a model'));
 assert.match(repaired,/A-Za-z/);
 assert.equal(javascriptSyntaxError(repaired.split('\n').slice(1,-1).join('\n')),null);
 assert.match(repaired,/\\-/);
});
test("alphabetic descending ranges are not silently converted to literal letters",async()=>{
 let calls=0;
 const result=await repairJavascriptCodeBlocks('```js\nconst pattern = /[z-a]/;\n```',async()=>{calls++;return 'const pattern = /[a-z]/;';});
 assert.equal(calls,1);assert.match(result,/a-z/);
});

test("local regex repair and a later model repair replace the original block once",async()=>{
 const code=String.raw`const email = /[\.-\+]/;`+'\nconst value = ;\n';
 const fixed=String.raw`const email = /[\.\-\+]/;`+'\nconst value = 1;\n';
 const result=await repairJavascriptCodeBlocks('Before\n```js\n'+code+'```\nAfter',async(candidate,error)=>{
  assert.match(candidate,/\\-/);assert.match(error,/Unexpected token/);return '```js\n'+fixed+'```';
 });
 assert.equal(result,'Before\n```js\n'+fixed+'```\nAfter');
});
