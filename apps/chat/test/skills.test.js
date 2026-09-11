import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderSkillsPage } from "../src/features/skills/page.js";
import { createSkillRegistry, validateSkillDraft } from "../src/features/skills/registry.js";
import { createSkillsHttpController } from "../src/features/skills/http-controller.js";

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../skills");

test("skill registry loads app-owned Markdown with stable metadata", () => {
  const registry = createSkillRegistry({ skillsDir });
  const catalog = registry.catalog();

  assert.equal(registry.version, 1);
  assert.equal(catalog.length, 16);
  for (const id of ["security", "guardrails", "rag-integration", "model-provider"]) {
    assert.equal(registry.rawContent(id), "");
    assert.equal(registry.content(id), null);
    assert.equal(catalog.find(skill => skill.id === id).enabled, false);
  }
  assert.equal(catalog.find((skill) => skill.id === "verifier")?.enabled, false);
  assert.equal(catalog.find((skill) => skill.id === "git-workflow")?.enabled, false);
  assert.match(registry.rawContent("git-workflow"), /^# Git Workflow Skill/);
  assert.match(registry.content("router"), /^# Router Skill/);
  assert.equal(registry.content("verifier"), null);
  assert.equal(registry.content("missing", "fallback"), "fallback");
  assert.equal(Object.hasOwn(catalog[0], "content"), false);
  assert.equal(Object.hasOwn(catalog[0], "prompt_lines"), false);
});

test("skill draft validation bounds prompt lines and rejects secrets", () => {
  const longDraft = ["# Example", "", "Purpose: safe behavior", ...Array.from({ length: 13 }, (_, index) => `- Rule ${index + 1}`)].join("\n");
  const valid = validateSkillDraft(longDraft);
  assert.equal(valid.valid, true);
  assert.equal(valid.promptLines.length, 12);
  assert.match(valid.warnings.join(" "), /first 12 meaningful instruction lines/);

  const unsafe = validateSkillDraft("# Unsafe\n\napi_key=secret-value");
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.errors.join(" "), /credentials or private keys/);
});

test("authenticated personalization page contains personal instructions only", () => {
  const html = renderSkillsPage({ user: { email: "person@example.com" }, csrfToken: "csrf" });
  assert.doesNotMatch(html, /Global skills|edit_global|api\/skills\/global/);
  assert.match(html, /Personal instructions apply only to your account/);
  assert.match(html, /Personal instructions · MundusX Chat/);
  assert.match(html, /Back to Settings/);
  assert.match(html, /\/api\/skills\/personal/);
  assert.match(html, /X-MundusX-CSRF/);
  assert.doesNotMatch(html, /localStorage/);
});

test("skills API keeps personal writes owner scoped and global writes admin scoped", async () => {
  const calls = [];
  const authStore = {
    async session() { return { id: "user-1", role: "user" }; },
    requireCsrf() { calls.push("csrf"); },
    async listUserSkills(id) { assert.equal(id, "user-1"); return []; },
    async globalSkillOverrides() { return []; },
    async saveUserSkill(id, input) { calls.push([id, input]); return { skill_id: "new" }; },
  };
  const registry = createSkillRegistry({ skillsDir });
  const output = [];
  const handle = createSkillsHttpController({
    authStore, registry,
    async readJsonBody() { return { slug: "my-style", title: "My style", content: "# Style\nBe concise." }; },
    sendJson(_response, status, body) { output.push({ status, body }); },
  });
  await handle({ request: { method: "GET", headers: {} }, response: {}, url: new URL("https://chat.mundusx.ai/api/skills") });
  assert.equal(Object.hasOwn(output[0].body, "system"), false);
  assert.equal(output[0].body.permissions.edit_personal, true);
  await handle({ request: { method: "POST", headers: {} }, response: {}, url: new URL("https://chat.mundusx.ai/api/skills/personal") });
  assert.equal(output[1].status, 201);
  assert.equal(calls[1][0], "user-1");
  await assert.rejects(
    () => handle({ request: { method: "PUT", headers: {} }, response: {}, url: new URL("https://chat.mundusx.ai/api/skills/global/router") }),
    /administrator/i,
  );
});
