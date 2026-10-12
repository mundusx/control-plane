import { parse } from "acorn";

export function javascriptCodeBlocks(content) {
  return [...String(content).matchAll(/```(?:javascript|js|cjs|mjs|nodejs)[ \t]*\r?\n([\s\S]*?)```/gi)].map(match => ({
    code: match[1], start: match.index + match[0].indexOf("\n") + 1, end: match.index + match[0].indexOf("\n") + 1 + match[1].length,
  }));
}

export function javascriptSyntaxError(code) {
  try { parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); return null; }
  catch (error) { return error.message; }
}

export async function repairJavascriptCodeBlocks(content, repair, maxRepairs = 2) {
  let result = String(content); let repairs = 0;
  for (const block of javascriptCodeBlocks(content).reverse()) {
    const error = javascriptSyntaxError(block.code);
    if (!error) continue;
    if (repairs >= maxRepairs) throw new Error("Generated JavaScript has too many syntax errors; please retry.");
    repairs++;
    const answer = await repair(block.code, error);
    const replacement = javascriptCodeBlocks(answer)[0]?.code ?? String(answer).trim();
    if (javascriptSyntaxError(replacement)) throw new Error("Generated JavaScript still has a syntax error after repair; please retry.");
    result = result.slice(0, block.start) + replacement + result.slice(block.end);
  }
  return result;
}
