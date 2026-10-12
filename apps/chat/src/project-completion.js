import { splitMarkdownCode } from "./markdown-code.js";

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
