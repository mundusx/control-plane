// Check the documentation promised by a multi-file answer. This does not
// certify that generated code works; the summary must state verification limits.
export function projectCompletionGaps(value) {
  const text = String(value ?? "");
  if (!/\bREADME\.md\b/i.test(text)) return [];
  const prose = [];
  let fence = null;
  let readmeSection = false;
  let readme = "";
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      } else if (readmeSection) readme += line + "\n";
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    prose.push(line);
    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      readmeSection = /\bREADME\.md\b/i.test(line);
    }
  }
  const gaps = [];
  if (!readme.trim()) gaps.push("Provide the promised README.md as a complete fenced Markdown file, with installation, environment configuration, start commands, and API documentation instructions where applicable.");
  else if (!/\b(?:install|installation|setup|getting started)\b/i.test(readme) ||
           !/\b(?:start|run|usage)\b/i.test(readme)) {
    gaps.push("Finish the README setup and run instructions without repeating the completed source files.");
  }
  const outside = prose.join("\n");
  const summary = outside.match(/^\s{0,3}#{1,6}\s+(?:Delivery summary|Completion summary|Final notes)[ \t]*\n([\s\S]*)/im);
  const summaryBody = summary?.[1].split(/^\s{0,3}#{1,6}\s+/m)[0].trim();
  if (!summaryBody || (summary?.index ?? -1) < outside.toLowerCase().lastIndexOf("readme.md")) {
    gaps.push("After closing all file code fences, add a Delivery summary section in normal prose: explain what was delivered, how to run and check it, and any limitations. Do not claim tests or execution occurred unless there is actual evidence.");
  }
  return gaps;
}
