import { splitMarkdownCode } from "./markdown-code.js";

// A provider stop is a transport boundary, not evidence that an API was
// implemented. Limit this check to complete FastAPI CRUD requests; focused
// model/schema edits and explanations do not require an entire application.
export function apiImplementationGaps(request, value) {
  const prompt = String(request ?? "");
  if (!/fast\s*api/i.test(prompt) || !/\bcrud\b/i.test(prompt) ||
      /\b(?:explain|describe|compare|review|fix|debug|update|refactor)\b/i.test(prompt) ||
      /\b(?:only|just)\b.{0,50}\b(?:models?|schemas?)\b|\b(?:models?|schemas?)\b.{0,30}\bonly\b/i.test(prompt)) return [];
  const code = splitMarkdownCode(value).filter(part => part.type === "code" &&
    /^(?:python|py|[\w./-]+\.py)$/i.test(part.language)).map(part => part.value).join("\n");
  const gaps = [];
  if (!/\bFastAPI\s*\(/.test(code)) gaps.push("Provide the missing runnable FastAPI application entry point, including FastAPI() and router registration when separate routers are used.");
  const methods = new Set([...code.matchAll(/@(?:[A-Za-z_]\w*\.)+(get|post|put|patch|delete)\s*\(/g)].map(match => match[1]));
  if (!["get", "post", "delete"].every(method => methods.has(method)) || !(methods.has("put") || methods.has("patch"))) {
    gaps.push("Provide the missing HTTP CRUD implementation: GET, POST, PUT or PATCH, and DELETE route handlers with their implementations. Models and schemas alone are not a CRUD API. Preserve the already emitted models and schemas; do not repeat them.");
  }
  const missing = missingLocalPythonModules(value);
  if (missing.length) gaps.push(`Provide the missing local Python modules imported by the emitted implementation: ${missing.join(", ")}. Include their full implementations; do not replace existing files with placeholders.`);
  return gaps;
}

export function pythonSourceFiles(value) {
  const files = new Map();
  let filename = null;
  for (const part of splitMarkdownCode(value)) {
    if (part.type === "text") {
      for (const line of part.value.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:#{1,6}\s+)?(?:\d+[.)]\s+)?(?:\*\*|`)?([\w./-]+\.py)(?:\*\*|`)?\s*$/);
        if (match) filename = match[1].replace(/^\.\//, "");
      }
    } else if (/^(?:python|py|[\w./-]+\.py)$/i.test(part.language)) {
      const path = /\.py$/i.test(part.language) ? part.language : filename;
      if (path) files.set(path, `${files.get(path) || ""}\n${part.value}`);
    }
  }
  return files;
}

export function missingLocalPythonModules(value) {
  const files = pythonSourceFiles(value);
  const paths = [...files.keys()];
  const isFile = path => paths.some(file => file === path || file.endsWith(`/${path}`));
  const isPackage = path => paths.some(file => file.startsWith(`${path}/`) || file.includes(`/${path}/`));
  const missing = new Set();
  for (const [file, code] of files) {
    for (const match of code.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([^\n#]+)/gm)) {
      const [, dots, module, names] = match;
      let base;
      if (dots) {
        const directory = file.split("/").slice(0, -1);
        directory.splice(Math.max(0, directory.length - dots.length + 1));
        base = [...directory, ...module.split(".").filter(Boolean)].join("/");
      } else {
        base = module.replaceAll(".", "/");
        if (!isPackage(base.split("/")[0])) continue; // Third-party import.
      }
      if (module && isFile(`${base}.py`)) continue; // Imported attributes/classes.
      if (module && !isPackage(base)) { missing.add(`${base}.py`); continue; }
      for (const entry of names.replace(/[()]/g, "").split(",")) {
        const name = entry.trim().split(/\s+/)[0];
        if (!/^[a-z_]\w*$/.test(name)) continue;
        const path = [base, name].filter(Boolean).join("/");
        if (!isFile(`${path}.py`) && !isPackage(path)) missing.add(`${path}.py`);
      }
    }
  }
  return [...missing].sort();
}

// Check the documentation promised by a multi-file answer. This does not
// certify that generated code works; the summary must state verification limits.
export function projectCompletionGaps(value) {
  const text = String(value ?? "");
  if (!/\bREADME\.md\b/i.test(text)) return [];
  const prose = [];
  let readmeSection = false;
  let readme = "";
  let readmeEndInProse = -1;
  for (const part of splitMarkdownCode(text)) {
    if (part.type === "code") {
      if (/^(?:[\w./-]+\/)?README\.md$/i.test(part.language)) readmeSection = true;
      if (readmeSection) {
        readme += part.value + "\n";
        readmeEndInProse = prose.join("\n").length;
      }
      continue;
    }
    prose.push(part.value);
    for (const line of part.value.split(/\r?\n/)) {
      if (/^\s{0,3}#{1,6}\s+/.test(line)) readmeSection = /\bREADME\.md\b/i.test(line);
    }
  }
  const gaps = [];
  if (!readme.trim()) gaps.push("Provide the promised README.md as a complete fenced Markdown file, with installation, environment configuration, start commands, and API documentation instructions where applicable.");
  else if (!/\b(?:install|installation|setup|getting started)\b/i.test(readme) ||
           !/\b(?:start|run|usage)\b/i.test(readme)) {
    gaps.push("Finish the README setup and run instructions without repeating the completed source files.");
  }
  const outside = prose.join("\n");
  // A wrap-up can be a paragraph or bullets with any heading (or none).
  // Referring to README.md is normal; use the actual file boundary, and
  // ignore headings/empty labels rather than requiring magic summary words.
  const afterReadme = outside.slice(Math.max(0, readmeEndInProse)).replace(/\*\*/g, "");
  const hasWrapUp = afterReadme.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return !/^#{1,6}\s/.test(text) && !/:$/.test(text) && /\p{L}/u.test(text);
  });
  if (!hasWrapUp) {
    gaps.push("After closing all file code fences, add a Delivery summary section in normal prose: explain what was delivered, how to run and check it, and any limitations. Do not claim tests or execution occurred unless there is actual evidence.");
  }
  return gaps;
}
