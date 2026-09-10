import test from "node:test";
import assert from "node:assert/strict";
import { ContinueFileStream, usesContinueFileProtocol } from "../src/continue-file-stream.js";
const start = "```tool\nTOOL_NAME: create_new_file\nBEGIN_ARG: filepath\nhello.js\nEND_ARG\nBEGIN_ARG: contents\n";
const end = "END_ARG\n```\n";
function assembled(deltas) { return JSON.parse(deltas.flatMap(d => d.tool_calls || []).map(c => c.function.arguments).join("")); }
test("file contents reach stock clients before the closing argument", () => {
  const stream = new ContinueFileStream();
  const first = stream.push(start + "// code\nconsole.log('hello');\n");
  assert(first.some(d => d.tool_calls?.[0].function.arguments.includes("console.log")));
  const all = [...first, ...stream.push(end), ...stream.finish()];
  assert.deepEqual(assembled(all), {filepath:"hello.js", contents:"// code\nconsole.log('hello');"});
  assert.equal(all.flatMap(d => d.tool_calls || []).filter(c => c.id).length, 1);
});
test("arbitrary transport boundaries preserve escapes, whitespace and Unicode", () => {
  const stream = new ContinueFileStream(); let all = [];
  const contents = "  // star ★\nconst x = \"a\\b\";  ";
  for (const character of start + contents + "\n" + end) all.push(...stream.push(character));
  all.push(...stream.finish());
  assert.deepEqual(assembled(all), {filepath:"hello.js", contents:contents.trim()});
});
test("non-file tool calls and ordinary answers are unchanged", () => {
  for (const value of ["Hello world\n", "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: filepath\nx.js\nEND_ARG\n```\n"]) {
    const stream = new ContinueFileStream(); const all=[];
    for (const char of value) all.push(...stream.push(char));
    all.push(...stream.finish()); assert.equal(all.map(d => d.content || "").join(""), value);
    assert.equal(stream.converted,false);
  }
});
test("interrupted arguments fail without claiming tool completion", () => {
  const stream = new ContinueFileStream(); stream.push(start+"const x=1;\n");
  assert.throws(() => stream.finish(), /before completion/);
});
test("adapter activates only for explicit Continue file protocol", () => {
  const body={messages:[{role:"system",content:"<tool_use_instructions> TOOL_NAME: create_new_file BEGIN_ARG: contents"}]};
  assert.equal(usesContinueFileProtocol(body),true);
  assert.equal(usesContinueFileProtocol({...body,tools:[{}]}),false);
  assert.equal(usesContinueFileProtocol({messages:[{role:"user",content:body.messages[0].content}]}),false);
});
