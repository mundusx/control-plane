export function detectChatQualityFlags(rawValue, cleanedValue, finalValue = cleanedValue, promptValue = "") {
  const raw = String(rawValue ?? "").trim();
  const cleaned = String(cleanedValue ?? "").trim();
  const finalOutput = String(finalValue ?? "").trim();
  const flags = [];
  const addFlag = (code, severity, message) => {
    if (!flags.some((flag) => flag.code === code)) {
      flags.push({ code, severity, message });
    }
  };

  if (raw && cleaned && raw !== cleaned) {
    addFlag("sanitized_output", "info", "Output was cleaned before display.");
  }
  if (/\b(?:llama\.cpp|response=|system\s*:|assistant\s*:|user\s*:)\b/i.test(raw)) {
    addFlag("worker_or_role_leak", "info", "Worker metadata or role labels were present in the raw output.");
  }
  if (/\b(?:MundusX(?: code)? subjob|Required output|Responsibility|Do not include|Return only)\b/i.test(raw)) {
    addFlag("instruction_leak", "repair", "Prompt or subjob instructions appeared in the raw output.");
  }
  if (hasRepeatedText(raw)) {
    addFlag("repeated_text", "repair", "The raw output repeated the same sentence or clause.");
  }
  if (isRestatedUserIntent(promptValue, finalOutput)) {
    addFlag(
      "prompt_restatement",
      "reject",
      "MundusX restated the request instead of answering it. Please retry.",
    );
  }
  if (startsWithPromptContinuation(raw)) {
    addFlag("prompt_continuation", "repair", "The model appeared to continue the user's incomplete prompt.");
  }
  if (/explanation instead of source code/i.test(finalOutput)) {
    addFlag("code_missing", "repair", "A complete-code request did not produce source code.");
  }
  if (/incomplete placeholder code/i.test(finalOutput)) {
    addFlag("placeholder_code", "repair", "The code answer contained placeholders or omitted implementation.");
  }
  if (hasBrokenMarkdownFence(finalOutput)) {
    addFlag("broken_markdown", "repair", "The rendered answer has an unmatched Markdown code fence.");
  }
  if (looksLikeMathPrompt(promptValue) && hasMalformedMathOutput(finalOutput)) {
    addFlag(
      "invalid_math_output",
      "reject",
      "MundusX returned an incomplete or malformed math answer. Please retry.",
    );
  }
  if (hasUnrequestedQuestionDrift(promptValue, finalOutput)) {
    addFlag(
      "question_drift",
      "reject",
      "MundusX generated unrelated questions instead of answering the request. Please retry.",
    );
  }

  return flags;
}

function looksLikeMathPrompt(value) {
  const text = String(value ?? "");
  return /\b(?:solve|equation|derivative|differentiate|integral|integrate|compute|calculate|simplify|factor|evaluate|acceleration|velocity|friction|hypotenuse|right\s+triangle|angle)\b/i.test(text) ||
    /(?:\d+\s*[+\-*/=]\s*\d+|[a-z]\s*[+\-*/=]\s*\d+|d\/dx|[a-z]\^\d+)/i.test(text);
}

function hasMalformedMathOutput(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  if (/\\\[\s*\\\]/.test(text) || /\\\(\s*\\\)/.test(text)) return true;
  if ((text.match(/\\\[/g) ?? []).length !== (text.match(/\\\]/g) ?? []).length) return true;
  if ((text.match(/\\\(/g) ?? []).length !== (text.match(/\\\)/g) ?? []).length) return true;
  if ((text.match(/\$\$/g) ?? []).length % 2 === 1) return true;
  if (/\[math\]|\[\/math\]/i.test(text)) return true;
  return /(?:=|\bthus\b|\btherefore\b|\banswer\s*:?)\s*$/i.test(text);
}

export function detectDegenerateRepetitionQualityFlags(outputValue) {
  const prose = proseOutsideCodeFences(outputValue);
  if (!hasAdjacentTokenLoop(prose)) {
    return [];
  }
  return [{
    code: "degenerate_repetition",
    severity: "reject",
    message: "MundusX generated a repeated text loop. Please retry.",
  }];
}

export function normalizeCompleteCodeOutput(outputValue, promptValue = "") {
  const output = String(outputValue ?? "");
  const prompt = String(promptValue ?? "");
  if (!isCompleteCodeRequest(prompt) || inferCodeLanguage(prompt, output) !== "java") {
    return output;
  }

  return output.replace(/```java\s*([\s\S]*?)```/i, (_match, sourceValue) => {
    let source = String(sourceValue ?? "").trim();
    source = source
      .replace(/^Scanner\s*;\s*/i, "import java.util.Scanner;\n\n")
      .replace(/(^|[^\w.])print\s*\(/g, "$1System.out.print(")
      .replace(/(^|[^\w.])println\s*\(/g, "$1System.out.println(");

    if (/\bScanner\b/.test(source) && !/\b(?:import\s+java\.util\.Scanner|java\.util\.Scanner)\b/.test(source)) {
      source = `import java.util.Scanner;\n\n${source}`;
    }

    source = formatJavaSource(source);

    return `\`\`\`java\n${source}\n\`\`\``;
  });
}

function formatJavaSource(sourceValue) {
  const source = String(sourceValue ?? "").trim();
  if (!source || (source.split("\n").length > 3 && !source.split("\n").some((line) => line.length > 160))) {
    return source;
  }

  const lines = [];
  let line = "";
  let indent = 0;
  let parentheses = 0;
  let quote = "";
  let escaped = false;
  const flush = () => {
    const value = line.trim();
    if (value) {
      lines.push(`${"    ".repeat(Math.max(0, indent))}${value}`);
    }
    line = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? "";
    if (quote) {
      line += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      line += character;
      continue;
    }
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      line += end < 0 ? source.slice(index) : source.slice(index, end);
      flush();
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      line += end < 0 ? source.slice(index) : source.slice(index, end + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses = Math.max(0, parentheses - 1);
    if (character === "{") {
      line = `${line.trimEnd()} {`;
      flush();
      indent += 1;
      continue;
    }
    if (character === "}") {
      flush();
      indent = Math.max(0, indent - 1);
      line = "}";
      const remainder = source.slice(index + 1);
      if (!/^\s*(?:;|else\b|catch\b|finally\b)/.test(remainder)) flush();
      continue;
    }
    line += character;
    if (character === ";" && parentheses === 0) flush();
    else if (character === "\n") flush();
  }
  flush();
  return lines.join("\n").replace(/\n(import\s)/g, "\n\n$1");
}

export function detectCompleteCodeQualityFlags(outputValue, promptValue = "") {
  const output = String(outputValue ?? "").trim();
  const prompt = String(promptValue ?? "").trim();
  if (!isCompleteCodeRequest(prompt)) {
    return [];
  }

  const fenced = extractFencedSource(output);
  const source = fenced.source;
  const language = inferCodeLanguage(prompt, output, fenced.label);
  const problems = [];
  if (!source) {
    problems.push("missing a fenced source file");
  } else {
    problems.push(...languageSpecificProblems(language, source, prompt));
    if (!hasBalancedCodeDelimiters(source, language)) {
      problems.push("has unbalanced code delimiters");
    }
    if (hasPlaceholderImplementation(source)) {
      problems.push("contains placeholder or omitted implementation");
    }
  }

  if (!problems.length) {
    return [];
  }
  return [{
    code: "invalid_complete_code",
    severity: "reject",
    message: `MundusX returned invalid ${language || "complete"} code: ${problems.join("; ")}. Please retry.`,
  }];
}

function isCompleteCodeRequest(promptValue) {
  const prompt = String(promptValue ?? "");
  return /\b(?:create|write|generate|build|return|provide|implement|convert)\b/i.test(prompt) &&
    /\b(?:complete|full|runnable|compilable|executable|program|application|source\s+file)\b/i.test(prompt) &&
    /\b(?:code|program|application|source|class|main|function|method|script)\b/i.test(prompt);
}

function extractFencedSource(outputValue) {
  const match = String(outputValue ?? "").match(/```([a-z0-9+#._-]*)\s*([\s\S]*?)```/i);
  return {
    label: String(match?.[1] ?? "").toLowerCase(),
    source: String(match?.[2] ?? "").trim(),
  };
}

function inferCodeLanguage(promptValue, outputValue, fenceLabel = "") {
  const text = `${promptValue ?? ""} ${fenceLabel} ${outputValue ?? ""}`.toLowerCase();
  if (/\b(?:c\+\+|cpp)\b/.test(text)) return "cpp";
  if (/\b(?:c#|csharp)\b/.test(text)) return "csharp";
  if (/\btypescript\b|```ts\b/.test(text)) return "typescript";
  if (/\bjavascript\b|```js\b/.test(text)) return "javascript";
  if (/\bpython\b|```py(?:thon)?\b/.test(text)) return "python";
  if (/\bjava\b/.test(text)) return "java";
  if (/\bgolang\b|\bgo\s+(?:program|code|application)\b|```go\b/.test(text)) return "go";
  if (/\brust\b|```rs\b/.test(text)) return "rust";
  if (/\b(?:language\s+c|c\s+program)\b|```c\b/.test(text)) return "c";
  return fenceLabel || "code";
}

function languageSpecificProblems(language, source, prompt) {
  const problems = [];
  const requiresMain = /\bmain\b/i.test(prompt) || /\b(?:runnable|executable)\b/i.test(prompt);
  if (language === "java") {
    if (/\bScanner\b/.test(source) && !/\b(?:import\s+java\.util\.Scanner|java\.util\.Scanner)\b/.test(source)) {
      problems.push("uses Scanner without importing java.util.Scanner");
    }
    if (/(^|[^\w.])(?:print|println)\s*\(/m.test(source)) {
      problems.push("uses unqualified print or println calls");
    }
    if (requiresMain && !/public\s+static\s+void\s+main\s*\(/.test(source)) {
      problems.push("does not define public static void main");
    }
    for (const method of requestedJavaMethods(prompt)) {
      if (!definesJavaMethod(source, method)) {
        problems.push(`does not define the requested ${method} method`);
      } else if (requiresMainToCallMethod(prompt, method) && !javaMainCallsMethod(source, method)) {
        problems.push(`main does not call the requested ${method} method`);
      }
    }
  } else if (language === "python" && requiresMain) {
    if (!/def\s+main\s*\(/.test(source) || !/if\s+__name__\s*==\s*["']__main__["']\s*:/.test(source)) {
      problems.push("does not define and invoke a Python main entrypoint");
    }
  } else if (language === "c" || language === "cpp") {
    if (requiresMain && !/\b(?:int|auto)\s+main\s*\(/.test(source)) {
      problems.push("does not define a main entrypoint");
    }
    if (language === "cpp" && /\b(?:std::)?cout\b/.test(source) && !/#include\s*<iostream>/.test(source)) {
      problems.push("uses cout without including iostream");
    }
    if (language === "c" && /\bprintf\s*\(/.test(source) && !/#include\s*<stdio\.h>/.test(source)) {
      problems.push("uses printf without including stdio.h");
    }
  } else if (language === "go") {
    if (requiresMain && (!/\bpackage\s+main\b/.test(source) || !/\bfunc\s+main\s*\(/.test(source))) {
      problems.push("does not define a Go package main entrypoint");
    }
    if (/\bfmt\./.test(source) && !/import\s+(?:\([^)]*["']fmt["']|["']fmt["'])/s.test(source)) {
      problems.push("uses fmt without importing it");
    }
  } else if (language === "rust" && requiresMain && !/\bfn\s+main\s*\(/.test(source)) {
    problems.push("does not define fn main");
  } else if (language === "csharp" && requiresMain && !/\bstatic\s+void\s+Main\s*\(/.test(source)) {
    problems.push("does not define static void Main");
  } else if (["javascript", "typescript"].includes(language) && /\bmain\b/i.test(prompt)) {
    if (!/(?:function\s+main\s*\(|(?:const|let|var)\s+main\s*=)/.test(source) || !/\bmain\s*\([^)]*\)\s*;?\s*$/m.test(source)) {
      problems.push("does not define and call main");
    }
  }
  return problems;
}

function requestedJavaMethods(promptValue) {
  const prompt = String(promptValue ?? "");
  const names = [];
  for (const pattern of [
    /\b([A-Za-z_$][\w$]*)\s+(?:function|method)\b/gi,
    /\b(?:function|method)\s+(?:named|called)\s+([A-Za-z_$][\w$]*)\b/gi,
  ]) {
    for (const match of prompt.matchAll(pattern)) {
      const name = String(match[1] ?? "").trim();
      if (name && name.toLowerCase() !== "main" && !names.some((item) => item.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return names;
}

function definesJavaMethod(sourceValue, methodName) {
  const method = escapeRegExp(methodName);
  return new RegExp(
    `\\b(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:void|byte|short|int|long|float|double|boolean|char|String|[A-Z][\\w$]*(?:<[^>]+>)?|[A-Za-z_$][\\w$]*\\[\\])\\s+${method}\\s*\\(`,
    "i",
  ).test(String(sourceValue ?? ""));
}

function requiresMainToCallMethod(promptValue, methodName) {
  const method = escapeRegExp(methodName);
  return new RegExp(`\\bmain\\b[\\s\\S]{0,100}\\bcall(?:s|ing|ed)?\\b[\\s\\S]{0,80}\\b${method}\\b`, "i")
    .test(String(promptValue ?? ""));
}

function javaMainCallsMethod(sourceValue, methodName) {
  const source = String(sourceValue ?? "");
  const signature = /public\s+static\s+void\s+main\s*\([^)]*\)\s*\{/i.exec(source);
  if (!signature) return false;
  const openingBrace = source.indexOf("{", signature.index);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      const body = source.slice(openingBrace + 1, index);
      return new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`, "i").test(body);
    }
  }
  return false;
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBalancedCodeDelimiters(sourceValue, language) {
  const source = String(sourceValue ?? "")
    .replace(/"(?:\\.|[^"\\])*"/g, "")
    .replace(/'(?:\\.|[^'\\])*'/g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const pairs = language === "python" ? [["(", ")"], ["[", "]"], ["{", "}"]] : [["{", "}"], ["(", ")"], ["[", "]"]];
  return pairs.every(([open, close]) =>
    countCharacter(source, open) === countCharacter(source, close),
  );
}

function hasPlaceholderImplementation(sourceValue) {
  return /\b(?:TODO|TBD)\b|\b(?:implement|add)\s+(?:this|logic|code)\s+here\b|\/\/\s*\.\.\.|\/\*\s*\.\.\.\s*\*\//i.test(
    String(sourceValue ?? ""),
  );
}

function countCharacter(value, character) {
  return String(value ?? "").split(character).length - 1;
}

function isRestatedUserIntent(promptValue, outputValue) {
  const prompt = String(promptValue ?? "").trim();
  const output = String(outputValue ?? "").trim();
  if (!prompt || !output) {
    return false;
  }
  if (!/^(?:i am looking for|i'?m looking for|i want to be able to|the user wants|you want to)\b/i.test(output)) {
    return false;
  }
  const promptTokens = contentTokens(prompt);
  const outputTokens = contentTokens(output);
  if (promptTokens.length < 4 || outputTokens.length < 8) {
    return false;
  }
  const promptSet = new Set(promptTokens);
  const overlap = outputTokens.filter((token) => promptSet.has(token)).length / outputTokens.length;
  const answerMarkers = /\b(?:first\s+step|steps?\s+are|use\s+(?:a|the)|store\s+(?:the|conversation)|send\s+(?:only|the)|configure|implement|answer|solution|for example|you can|we can)\b/i.test(output);
  return overlap >= 0.32 && !answerMarkers;
}

function contentTokens(value) {
  const stopWords = new Set(["want", "able", "that", "with", "while", "also", "have", "this", "that"]);
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !stopWords.has(token));
}

function hasUnrequestedQuestionDrift(promptValue, outputValue) {
  const prompt = String(promptValue ?? "").trim();
  const output = String(outputValue ?? "").trim();
  if (!prompt || !output) {
    return false;
  }
  if (/\b(?:quiz|questionnaire|worksheet|practice\s+(?:questions|problems)|exam|test\s+questions|generate\s+questions|list\s+questions|interview\s+questions)\b/i.test(prompt)) {
    return false;
  }
  const promptQuestionCount = countQuestionLikeClauses(prompt);
  const outputQuestionCount = countQuestionLikeClauses(output);
  if (outputQuestionCount < 6 || outputQuestionCount <= promptQuestionCount + 3) {
    return false;
  }
  const questionIntroCount = (output.match(/\b(?:what|who|where|when|why|how|is|are|can|does|do|should)\b[^?]{0,160}\?/gi) ?? []).length;
  const answerMarkers = (output.match(/\b(?:answer|result|therefore|equals|is\s+[-+]?\d|MundusX|weather|temperature)\b/gi) ?? []).length;
  return questionIntroCount >= 5 && answerMarkers < questionIntroCount;
}

function countQuestionLikeClauses(value) {
  const text = String(value ?? "");
  const questionMarks = (text.match(/\?/g) ?? []).length;
  const questionStarters = (text.match(/\b(?:what|who|where|when|why|how|is|are|can|does|do|should)\b[^.?!]{0,120}\?/gi) ?? []).length;
  return Math.max(questionMarks, questionStarters);
}

function startsWithPromptContinuation(value) {
  return /^[a-z][a-z0-9 ,/'-]{0,48}\.\s+(?:The|This|A|An)\s+(?:program|code|function|example|solution|answer)\b/.test(
    String(value ?? "").trim(),
  );
}

function hasBrokenMarkdownFence(value) {
  const fenceCount = (String(value ?? "").match(/```/g) ?? []).length;
  return fenceCount % 2 === 1;
}

function hasRepeatedText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  const seen = new Map();
  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (normalized.length < 24) {
      continue;
    }
    const count = (seen.get(normalized) ?? 0) + 1;
    if (count >= 3) {
      return true;
    }
    seen.set(normalized, count);
  }

  const repeatedClause = text.match(/\b(.{24,160}?)\b(?:\s+\1\b){2,}/i);
  return Boolean(repeatedClause) || hasAdjacentTokenLoop(proseOutsideCodeFences(text));
}

function proseOutsideCodeFences(value) {
  return String(value ?? "").replace(/```[a-zA-Z0-9_+#.-]*[ \t]*[\s\S]*?```/g, " ");
}

function hasAdjacentTokenLoop(value) {
  const tokens = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  for (let phraseLength = 2; phraseLength <= 8; phraseLength += 1) {
    for (let start = 0; start + phraseLength * 4 <= tokens.length; start += 1) {
      let repeats = 1;
      while (start + phraseLength * (repeats + 1) <= tokens.length) {
        let matches = true;
        for (let offset = 0; offset < phraseLength; offset += 1) {
          if (tokens[start + offset] !== tokens[start + phraseLength * repeats + offset]) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          break;
        }
        repeats += 1;
      }
      if (repeats >= 4 && phraseLength * repeats >= 12) {
        return true;
      }
    }
  }
  return false;
}
