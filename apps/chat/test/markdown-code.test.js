import test from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownCode } from "../src/markdown-code.js";

const readme = "# CarWash API\n\n## Installation\n1. Install dependencies:\n```bash\nnpm install\n```\n2. Create .env:\n```env\nPORT=3000\nMONGODB_URI=mongodb://localhost:27017/carwash\n```\n3. Start:\n```bash\nnpm start\n```\n## API Endpoints\n- GET /api/carwashes\n";

for (const fence of ["```", "````", "~~~~"]) {
  test(`README with ${fence.length}-character ${fence[0]} outer fence preserves nested commands`, () => {
    const parts = splitMarkdownCode(`## README.md\n${fence}markdown\n${readme}${fence}\n## Delivery summary\nDone.`);
    const code = parts.filter(part => part.type === "code");
    assert.equal(code.length, 1);
    assert.equal(code[0].language, "markdown");
    assert.equal(code[0].value, readme);
    assert.equal(parts.at(-1).value, "## Delivery summary\nDone.");
  });
}

test("fences inside source strings do not split code", () => {
  const code = 'const example = "```bash";\nconsole.log(example);\n';
  assert.equal(splitMarkdownCode('```js\n' + code + '```')[0].value, code);
});

test("streaming README remains one file before its closing fence arrives", () => {
  const parts = splitMarkdownCode('```markdown\n' + readme.slice(0, -20));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].value, readme.slice(0, -20));
});

test("ordinary code blocks, tilde fences, and prose remain separate", () => {
  const parts = splitMarkdownCode('Intro\n```js\nconst n = 1;\n```\nBetween\n~~~bash\nnpm start\n~~~\nEnd');
  assert.deepEqual(parts.map(part => part.type), ['text', 'code', 'text', 'code', 'text']);
  assert.equal(parts[3].language, 'bash');
  assert.equal(splitMarkdownCode('An inline ``` example')[0].type, 'text');
});

test("browser-embedded parser behaves identically", () => {
  const browserParser = new Function(`return (${splitMarkdownCode.toString()});`)();
  const input = '```markdown\n' + readme + '```';
  assert.deepEqual(browserParser(input), splitMarkdownCode(input));
});
