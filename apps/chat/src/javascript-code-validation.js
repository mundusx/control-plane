import { parse } from "acorn";

// Models sometimes label every project file as JavaScript. An explicit file
// declaration takes precedence over that fence label for configuration/assets.
function declaredFileName(content, match) {
  const firstLine = match[1].split(/\r?\n/).find(line => line.trim());
  const comment = firstLine?.match(/^\s*\/\/\s*(?:file(?:name)?\s*:\s*)?([\w./\\-]+)\s*$/i);
  if (comment) return comment[1];
  const previousLine = content.slice(0, match.index).trimEnd().split(/\r?\n/).at(-1) ?? "";
  return previousLine.match(/^\s*(?:#{1,6}\s+)?(?:file(?:name)?\s*:\s*)?`?([\w./\\-]+)`?\s*$/i)?.[1] ?? null;
}

function isNonJavascriptFile(filename) {
  if (!filename) return false;
  const name = filename.replace(/\\/g, "/").split("/").at(-1).toLowerCase();
  return /^\.env(?:\.|$)/.test(name) ||
    /\.(?:env|json|ya?ml|toml|ini|conf|cfg|md|txt|html|css|scss|sql|sh|bash|ps1|bat|cmd|py|rs|java|ts|tsx|jsx)$/.test(name);
}

export function javascriptCodeBlocks(content) {
  const text = String(content);
  return [...text.matchAll(/```(?:javascript|js|cjs|mjs|nodejs)[ \t]*\r?\n([\s\S]*?)```/gi)]
    .filter(match => !isNonJavascriptFile(declaredFileName(text, match)))
    .map(match => ({
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
