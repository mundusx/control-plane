import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const MAX_SKILL_CHARS = 12_000;
const PROMPT_LINE_LIMIT = 12;

export function createSkillRegistry({ skillsDir }) {
  if (!skillsDir) throw new TypeError("skillsDir is required");
  const manifest = parseManifest(readFileSync(resolve(skillsDir, "manifest.json"), "utf8"));
  const records = new Map();

  for (const entry of manifest.skills) {
    const content = readFileSync(resolve(skillsDir, entry.file), "utf8").trim();
    const validation = validateSkillDraft(content);
    if (!validation.valid) {
      throw new Error(`Skill ${entry.id} is invalid: ${validation.errors.join("; ")}`);
    }
    records.set(entry.id, Object.freeze({ ...entry, content, validation }));
  }

  return Object.freeze({
    version: manifest.version,
    content(id, fallback = "") {
      const record = records.get(id);
      if (!record) return fallback;
      return record.enabled ? record.content : null;
    },
    rawContent(id) {
      return records.get(id)?.content ?? null;
    },
    has(id) {
      return records.has(id);
    },
    catalog() {
      return [...records.values()].map(({ content: _content, validation, ...entry }) => ({
        ...entry,
        prompt_line_count: validation.promptLines.length,
        warnings: validation.warnings,
      }));
    },
  });
}

export function validateSkillDraft(contentValue) {
  const content = String(contentValue ?? "").trim();
  const errors = [];
  const warnings = [];
  if (!content) errors.push("Skill Markdown is required");
  if (content.length > MAX_SKILL_CHARS) errors.push(`Skill Markdown exceeds ${MAX_SKILL_CHARS} characters`);
  if (content && !content.split(/\r?\n/).find((line) => line.trim())?.trim().startsWith("#")) {
    errors.push("The first meaningful line must be a Markdown heading");
  }
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]/i.test(content)) {
    errors.push("Skill Markdown must not contain credentials or private keys");
  }
  const promptLines = promptLinesForSkill(content);
  const meaningfulLines = meaningfulSkillLines(content).length;
  if (meaningfulLines > PROMPT_LINE_LIMIT) {
    warnings.push(`Only the first ${PROMPT_LINE_LIMIT} meaningful instruction lines enter the model prompt`);
  }
  return Object.freeze({ valid: errors.length === 0, errors, warnings, promptLines, preview: promptLines.join(" ") });
}

function parseManifest(raw) {
  const manifest = JSON.parse(raw);
  if (!Number.isInteger(manifest?.version) || manifest.version < 1 || !Array.isArray(manifest.skills)) {
    throw new Error("Skill manifest must contain a positive version and a skills array");
  }
  const ids = new Set();
  const files = new Set();
  const skills = manifest.skills.map((entry) => {
    const normalized = {
      id: String(entry?.id || ""),
      file: String(entry?.file || ""),
      title: String(entry?.title || "").trim(),
      description: String(entry?.description || "").trim(),
      enabled: entry?.enabled === true,
    };
    if (!SKILL_ID_PATTERN.test(normalized.id) || !SKILL_FILE_PATTERN.test(normalized.file)) {
      throw new Error("Skill manifest ids and files must use lowercase hyphenated names");
    }
    if (!normalized.title || !normalized.description) throw new Error(`Skill ${normalized.id} needs a title and description`);
    if (ids.has(normalized.id) || files.has(normalized.file)) throw new Error(`Skill ${normalized.id} is duplicated`);
    ids.add(normalized.id);
    files.add(normalized.file);
    return Object.freeze(normalized);
  });
  return Object.freeze({ version: manifest.version, skills });
}

function promptLinesForSkill(content) {
  return meaningfulSkillLines(content).slice(0, PROMPT_LINE_LIMIT);
}

function meaningfulSkillLines(content) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s+/, ""))
    .map((line) => line.replace(/^(?:Purpose|Rules|Facts|Examples|Output|Do|Do not)\s*:\s*/i, ""))
    .filter(Boolean);
}
